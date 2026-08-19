"""Compatibility shim for Python stdlib difflib + KRISTA Brain Linie-2 patch.

archive-connector.py already imports ``difflib``. This file transparently loads and
re-exports the real stdlib module, then attaches the bounded Brain runtime fixes.
"""
import importlib.util as _importlib_util
import os as _os_boot
import sysconfig as _sysconfig

_stdlib_path = _os_boot.path.join(_sysconfig.get_path("stdlib"), "difflib.py")
_stdlib_spec = _importlib_util.spec_from_file_location("_krista_stdlib_difflib", _stdlib_path)
_stdlib_module = _importlib_util.module_from_spec(_stdlib_spec)
_stdlib_spec.loader.exec_module(_stdlib_module)
for _name in dir(_stdlib_module):
    if not _name.startswith("__") or _name in {"__all__", "__doc__"}:
        globals()[_name] = getattr(_stdlib_module, _name)

import json
import os
import re
import sqlite3
from pathlib import Path
from urllib.parse import parse_qs, quote

try:
    import flask
except Exception:
    flask = None

_PATCHED = False


def _norm(value: object) -> str:
    text = str(value or "").lower().replace("ß", "ss")
    text = text.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _capture_db_paths() -> list[Path]:
    base = Path(r"N:\OneDrive\Dokumente\Kristine\Daten")
    values = [
        Path(os.environ.get("KRISTINE_INCOMING_DB", str(base / "kristine_incoming_capture.db"))),
        Path(os.environ.get("KRISTINE_INCOMING_TEST_DB", str(base / "kristine_incoming_training.db"))),
    ]
    out: list[Path] = []
    for p in values:
        if p not in out and p.exists():
            out.append(p)
    return out


def _capture_material_hits(query: str, limit: int = 80) -> tuple[list[dict], int]:
    q = _norm(query)
    if len(q) < 2:
        return [], 0
    q_tokens = [x for x in q.split() if len(x) >= 2]
    hits: list[dict] = []
    scanned = 0

    for db in _capture_db_paths():
        try:
            con = sqlite3.connect(db)
            con.row_factory = sqlite3.Row
            rows = con.execute(
                """SELECT i.id,i.doc_id,i.supplier_name,i.supplier_address,i.supplier_number,
                          i.invoice_date,i.gross_amount,i.pdf_path,i.pdf_text,
                          GROUP_CONCAT(a.description, '\n') AS allocation_text
                   FROM incoming_invoices i
                   LEFT JOIN incoming_allocations a ON a.invoice_id=i.id
                   GROUP BY i.id
                   ORDER BY i.invoice_date DESC, i.id DESC"""
            ).fetchall()
        except Exception:
            continue
        finally:
            try:
                con.close()
            except Exception:
                pass

        for row in rows:
            scanned += 1
            raw = "\n".join(filter(None, [row["allocation_text"], row["pdf_text"]]))
            lines = [x.strip() for x in raw.splitlines() if x.strip()]
            if not lines:
                continue

            best_line = ""
            best_score = 0.0
            exact = False
            for line in lines:
                n = _norm(line)
                if not n:
                    continue
                if q in n or (q_tokens and all(tok in n for tok in q_tokens)):
                    score = 1.0 + min(len(q), 80) / 1000.0
                    if score > best_score:
                        best_score, best_line, exact = score, line, True
                    continue
                ratio = SequenceMatcher(None, q, n[: max(len(q) * 4, 80)]).ratio()
                if ratio > best_score:
                    best_score, best_line = ratio, line

            if not best_line or (not exact and best_score < 0.58):
                continue

            hits.append({
                "source": "capture",
                "docId": row["doc_id"],
                "path": row["pdf_path"] or "",
                "supplierName": row["supplier_name"] or "Lieferant",
                "supplierAddress": row["supplier_address"] or "",
                "supplierNumber": row["supplier_number"] or "",
                "invoiceDate": row["invoice_date"] or "",
                "invoiceDateTime": row["invoice_date"] or "",
                "amount": row["gross_amount"],
                "materialMatches": [best_line[:500]],
                "matchScore": int(best_score * 1000),
                "matchType": "exact" if exact else "similar",
                "matchCount": 1,
            })

    hits.sort(key=lambda x: (
        1 if x.get("matchType") == "exact" else 0,
        int(x.get("matchScore") or 0),
        str(x.get("invoiceDateTime") or ""),
    ), reverse=True)
    return hits[:limit], scanned


def _merge_material_json(body: bytes, query: str) -> bytes:
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:
        return body
    if not isinstance(data, dict) or not data.get("ok", False):
        return body

    try:
        limit = max(1, min(200, int(data.get("limit") or 80)))
    except Exception:
        limit = 80
    extra, extra_scanned = _capture_material_hits(query, limit)
    if not extra:
        data["scanned"] = int(data.get("scanned") or 0) + extra_scanned
        return json.dumps(data, ensure_ascii=False).encode("utf-8")

    existing = list(data.get("results") or [])
    seen = {(str(x.get("path") or ""), str(x.get("docId") or "")) for x in existing if isinstance(x, dict)}
    for row in extra:
        key = (str(row.get("path") or ""), str(row.get("docId") or ""))
        if key not in seen:
            existing.append(row)
            seen.add(key)

    existing.sort(key=lambda x: (
        1 if x.get("matchType") == "exact" else 0,
        int(x.get("matchScore") or 0),
        str(x.get("invoiceDateTime") or x.get("invoiceDate") or ""),
    ), reverse=True)
    existing = existing[:limit]
    data["results"] = existing
    data["exactCount"] = sum(1 for x in existing if x.get("matchType") in {"exact", "good"})
    data["similarCount"] = sum(1 for x in existing if x.get("matchType") == "similar")
    data["scanned"] = int(data.get("scanned") or 0) + extra_scanned
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


_BRAIN_UI = r'''
<style id="kristaBrainLine2Style">
.krista-brain-top{background:linear-gradient(90deg,#203a2b,#18281f);color:#fff;border-bottom:1px solid #3b5445;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.krista-brain-top-inner{max-width:1540px;margin:auto;padding:13px 18px;display:grid;grid-template-columns:280px 1fr 190px;gap:18px;align-items:center}
.krista-brain-brand{display:flex;align-items:center;gap:11px;color:#fff;text-decoration:none}.krista-brain-mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(145deg,#f2dda7,#caa74f);color:#20251f;display:grid;place-items:center;font-size:23px;font-weight:950}.krista-brain-brand strong{display:block;font-size:17px}.krista-brain-brand small{display:block;color:#cbd5ce;margin-top:2px}
.krista-brain-nav{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}.krista-brain-nav a{color:#fff;text-decoration:none;border:1px solid #46564c;background:#25362d;padding:9px 12px;border-radius:10px;font-weight:850;font-size:12px}.krista-brain-nav a.active{background:#368a55;border-color:#58a875}.krista-brain-user{text-align:right}.krista-brain-user strong{display:block}.krista-brain-user small{color:#c6d0c9}
.brain-capture-viewer-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0}.brain-capture-viewer-tools button{height:auto;padding:7px 9px;border-radius:8px;background:#fff;color:#111;border:1px solid #cfd2d0;font-weight:800}.brain-capture-viewer-tools .brain-viewer-status{font-size:11px;color:#9aa4ae;margin-left:auto}.capture-pdf-shell{min-height:650px!important}.capture-pdf-shell iframe#capturePdfPreview{width:100%!important;height:650px!important;background:#262626}
@media(max-width:900px){.krista-brain-top-inner{grid-template-columns:1fr}.krista-brain-nav{justify-content:flex-start}.krista-brain-user{text-align:left}.capture-pdf-shell{min-height:520px!important}.capture-pdf-shell iframe#capturePdfPreview{height:520px!important}}
</style>
<script id="kristaBrainLine2Script">
(function(){
  const go=(name)=>'/brain-go/'+name;
  function addHead(){
    if(document.querySelector('.krista-brain-top'))return;
    const top=document.createElement('header');top.className='krista-brain-top';
    top.innerHTML=`<div class="krista-brain-top-inner"><a class="krista-brain-brand" href="${go('kristower')}"><span class="krista-brain-mark">K</span><span><strong>KRISTA</strong><small>Einfach. Intuitiv. Gemeinsam.</small></span></a><nav class="krista-brain-nav"><a href="${go('kristower')}">⌂ KRISTOWER</a><a href="${go('kriszeit')}">⏱ KRISZEIT</a><a class="active" href="/">🧠 THE BRAIN</a><a href="${go('kristine')}">✦ KRISTINE</a><a href="${go('krisadmin')}">⚙ KRISADMIN</a><a href="${go('tasks')}">📌 AUFGABEN</a></nav><div class="krista-brain-user"><strong>Alexander Krista</strong><small>The Brain</small></div></div>`;
    document.body.insertBefore(top,document.body.firstChild);
  }
  let zoom=100;
  function viewerUrl(src){
    const base=String(src||'').split('#')[0];
    return base+(base?'#toolbar=1&navpanes=0&zoom='+(zoom==='width'?'page-width':zoom):'');
  }
  function applyZoom(){const f=document.getElementById('capturePdfPreview');if(!f||!f.src)return;f.src=viewerUrl(f.src);const s=document.querySelector('.brain-viewer-status');if(s)s.textContent=zoom==='width'?'Breite':zoom+' %'}
  function addViewer(){
    const f=document.getElementById('capturePdfPreview'),shell=f?.closest('.capture-pdf-shell');if(!f||!shell||shell.previousElementSibling?.classList?.contains('brain-capture-viewer-tools'))return;
    const t=document.createElement('div');t.className='brain-capture-viewer-tools';t.innerHTML='<button data-z="minus">−</button><button data-z="100">100 %</button><button data-z="width">↔ Breite</button><button data-z="plus">+</button><button data-z="200">2×</button><button data-z="300">3×</button><button data-z="400">4×</button><span class="brain-viewer-status">Breite</span>';shell.parentNode.insertBefore(t,shell);zoom='width';
    t.addEventListener('click',e=>{const z=e.target?.dataset?.z;if(!z)return;if(z==='minus')zoom=Math.max(50,(Number(zoom)||100)-25);else if(z==='plus')zoom=Math.min(400,(Number(zoom)||100)+25);else if(z==='width')zoom='width';else zoom=Number(z);applyZoom()});
    f.addEventListener('load',()=>{if(!String(f.src).includes('zoom='))applyZoom()});
    t.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();zoom=Math.max(50,Math.min(400,(Number(zoom)||100)+(e.deltaY<0?25:-25)));applyZoom()},{passive:false});
  }
  function init(){addHead();addViewer();const mo=new MutationObserver(()=>addViewer());mo.observe(document.body,{childList:true,subtree:true});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
</script>
'''


def _inject_brain_ui(body: bytes) -> bytes:
    try:
        text = body.decode("utf-8")
    except Exception:
        return body
    if "kristaBrainLine2Script" in text or "The Brain" not in text:
        return body
    pos = text.lower().rfind("</body>")
    if pos >= 0:
        text = text[:pos] + _BRAIN_UI + text[pos:]
    else:
        text += _BRAIN_UI
    return text.encode("utf-8")


def _redirect_response(name: str, start_response):
    base = os.environ.get("KRISTINE_API_BASE", "https://protokoll.krista.at").rstrip("/")
    token = os.environ.get("KRISTINE_ADMIN_TOKEN", "").strip()
    paths = {
        "kristower": "/kontrollzentrum",
        "kriszeit": "/kristool-preview/",
        "kristine": "/kristine#planning",
        "krisadmin": "/admin/ui",
        "tasks": "/kristine#tasks",
    }
    path = paths.get(name, "/kristine#planning")
    if "#" in path:
        p, frag = path.split("#", 1)
    else:
        p, frag = path, ""
    location = base + p
    if token:
        location += ("&" if "?" in location else "?") + "token=" + quote(token, safe="")
    if frag:
        location += "#" + frag
    body = b"Weiterleitung ..."
    start_response("302 Found", [("Location", location), ("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", str(len(body)))])
    return [body]


def _patch_flask():
    global _PATCHED
    if _PATCHED or flask is None:
        return
    _PATCHED = True
    original = flask.Flask.wsgi_app

    def patched(self, environ, start_response):
        path = str(environ.get("PATH_INFO") or "")
        if path.startswith("/brain-go/"):
            return _redirect_response(path.rsplit("/", 1)[-1], start_response)

        captured = {}
        def hold_start(status, headers, exc_info=None):
            captured["status"] = status
            captured["headers"] = list(headers)
            captured["exc_info"] = exc_info
        iterable = original(self, environ, hold_start)
        try:
            body = b"".join(iterable)
        finally:
            close = getattr(iterable, "close", None)
            if close:
                close()

        headers = captured.get("headers", [])
        content_type = next((v for k, v in headers if k.lower() == "content-type"), "")
        if path == "/material-search" and "application/json" in content_type:
            query = parse_qs(str(environ.get("QUERY_STRING") or "")).get("q", [""])[0]
            body = _merge_material_json(body, query)
        elif "text/html" in content_type:
            body = _inject_brain_ui(body)

        headers = [(k, v) for k, v in headers if k.lower() != "content-length"]
        headers.append(("Content-Length", str(len(body))))
        start_response(captured.get("status", "200 OK"), headers, captured.get("exc_info"))
        return [body]

    flask.Flask.wsgi_app = patched


_patch_flask()
