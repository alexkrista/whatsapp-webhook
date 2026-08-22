# coding: utf-8
"""KRISTA The Brain · Linie 2 direct runtime extension.

Explicitly installed by archive-connector.py. No stdlib shadowing / import shim.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import quote

_INSTALLED = False
_QUERY_CACHE = {}
_QUERY_CACHE_LOCK = threading.Lock()
_LOOKUP_CACHE = {}
_LOOKUP_CACHE_LOCK = threading.Lock()
_PREVIEW_DIR = Path(tempfile.gettempdir()) / "krista_brain_preview"
_PREVIEW_TTL = 2 * 60 * 60


def _mtime(path):
    try:
        return Path(path).stat().st_mtime_ns
    except Exception:
        return 0


def _cache_get(cache, lock, key, ttl):
    now = time.monotonic()
    with lock:
        row = cache.get(key)
        if not row:
            return None
        if now - row[0] > ttl:
            cache.pop(key, None)
            return None
        return copy.deepcopy(row[1])


def _cache_put(cache, lock, key, value):
    with lock:
        cache[key] = (time.monotonic(), copy.deepcopy(value))
        if len(cache) > 160:
            for k, _ in sorted(cache.items(), key=lambda item: item[1][0])[:40]:
                cache.pop(k, None)


def _safe_preview_token(value):
    token = str(value or "").strip().lower()
    return token if re.fullmatch(r"[0-9a-f]{64}", token) else ""


def _preview_cleanup():
    try:
        _PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
        cutoff = time.time() - _PREVIEW_TTL
        for path in _PREVIEW_DIR.glob("*.pdf"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink(missing_ok=True)
            except Exception:
                pass
    except Exception:
        pass


def _preview_store(data):
    if not data:
        return ""
    _preview_cleanup()
    token = hashlib.sha256(data).hexdigest()
    _PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    path = _PREVIEW_DIR / f"{token}.pdf"
    if not path.exists():
        tmp = _PREVIEW_DIR / f".{token}.tmp"
        tmp.write_bytes(data)
        tmp.replace(path)
    return token


def _preview_path(token):
    token = _safe_preview_token(token)
    if not token:
        raise ValueError("Ungültige Vorschau.")
    path = _PREVIEW_DIR / f"{token}.pdf"
    if not path.is_file():
        raise FileNotFoundError("Vorschau ist abgelaufen.")
    if time.time() - path.stat().st_mtime > _PREVIEW_TTL:
        path.unlink(missing_ok=True)
        raise FileNotFoundError("Vorschau ist abgelaufen.")
    return path


def _brain_header_css():
    return r'''
.krista-brain-head{position:relative;z-index:100;background:linear-gradient(90deg,#203a2b,#18281f);color:#fff;border-bottom:1px solid #3b5445;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.krista-brain-head-inner{max-width:1540px;margin:0 auto;padding:12px 18px;display:grid;grid-template-columns:280px minmax(0,1fr) 190px;gap:18px;align-items:center}
.krista-brain-brand{display:flex;align-items:center;gap:11px;color:#fff;text-decoration:none;min-width:0}
.krista-brain-mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(145deg,#f2dda7,#caa74f);color:#20251f;display:grid;place-items:center;font-size:23px;font-weight:950;flex:0 0 auto}
.krista-brain-brand strong{display:block;font-size:17px}.krista-brain-brand small{display:block;color:#cbd5ce;margin-top:2px}
.krista-brain-worlds{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}
.krista-brain-worlds a{color:#fff;text-decoration:none;border:1px solid #46564c;background:#25362d;padding:9px 12px;border-radius:10px;font-weight:850;font-size:12px;white-space:nowrap}
.krista-brain-worlds a.active{background:#368a55;border-color:#58a875}.krista-brain-user{text-align:right}.krista-brain-user strong{display:block}.krista-brain-user small{color:#c6d0c9}
.capture-super-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:10px 0 0;padding:8px;border:1px solid var(--line);border-radius:12px;background:#111318}
.capture-super-tools[hidden]{display:none!important}.capture-super-tools button{height:auto;min-height:36px;padding:7px 10px;border-radius:9px;background:#242c36;color:#fff;border:1px solid #455160}
.capture-super-tools button.active{background:#fff;color:#111}.capture-super-status{font-size:12px;color:#c8d1dc;min-width:82px;text-align:center}
.capture-pdf-shell{position:relative;overflow:auto!important;display:block!important;text-align:center}
#capturePdfPageImage{display:block;max-width:none;height:auto;margin:0 auto;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.32)}
#capturePdfPageImage[hidden]{display:none!important}.capture-preview-loupe{position:fixed;z-index:10050;width:340px;height:235px;border:3px solid #fff;border-radius:14px;box-shadow:0 10px 45px rgba(0,0,0,.65);background:#111 no-repeat;pointer-events:none;display:none;overflow:hidden}
@media(max-width:980px){.krista-brain-head-inner{grid-template-columns:1fr}.krista-brain-worlds{justify-content:flex-start}.krista-brain-user{text-align:left}}
@media(max-width:720px){.capture-preview-loupe{width:260px;height:180px}}
'''


def _brain_header_html():
    return r'''
<header class="krista-brain-head"><div class="krista-brain-head-inner">
<a class="krista-brain-brand" href="/brain-go/kristower"><span class="krista-brain-mark">K</span><span><strong>KRISTA</strong><small>Einfach. Intuitiv. Gemeinsam.</small></span></a>
<nav class="krista-brain-worlds" aria-label="KRISTA Arbeitswelten">
<a href="/brain-go/kristower">⌂ KRISTOWER</a><a href="/brain-go/kriszeit">⏱ KRISZEIT</a><a href="/" class="active" aria-current="page">🧠 THE BRAIN</a><a href="/brain-go/kristine">✦ KRISTINE</a><a href="/brain-go/krisadmin">⚙ KRISADMIN</a><a href="/brain-go/tasks">📌 AUFGABEN</a>
</nav><div class="krista-brain-user"><strong>Alexander Krista</strong><small>The Brain</small></div>
</div></header>
'''


def _capture_toolbar_html():
    return r'''
<div id="captureSuperTools" class="capture-super-tools" hidden>
<button id="capturePreviewPrev" type="button">←</button><span id="capturePreviewStatus" class="capture-super-status">1 / 1</span><button id="capturePreviewNext" type="button">→</button>
<button id="capturePreviewMinus" type="button">−</button><button id="capturePreview100" type="button">100 %</button><button id="capturePreviewWidth" type="button">Breite</button><button id="capturePreviewPlus" type="button">＋</button>
<button type="button" data-capture-loupe="2">🔎 2×</button><button type="button" data-capture-loupe="3">🔎 3×</button><button type="button" data-capture-loupe="4">🔎 4×</button>
</div>
'''


def _capture_script():
    return r'''
<script id="kristaBrainCaptureViewerV2">
(function(){
 const fileInput=document.getElementById('captureFile'),frame=document.getElementById('capturePdfPreview'),empty=document.getElementById('capturePdfEmpty'),tools=document.getElementById('captureSuperTools');
 const shell=frame?.closest('.capture-pdf-shell');if(!frame||!shell||!tools)return;
 let image=document.getElementById('capturePdfPageImage');if(!image){image=document.createElement('img');image.id='capturePdfPageImage';image.alt='PDF Vorschau';image.hidden=true;shell.appendChild(image)}
 let loupe=document.getElementById('capturePreviewLoupe');if(!loupe){loupe=document.createElement('div');loupe.id='capturePreviewLoupe';loupe.className='capture-preview-loupe';document.body.appendChild(loupe)}
 const state={token:'',page:1,pages:1,scale:1.45,width:0,loupe:0},status=document.getElementById('capturePreviewStatus'),prev=document.getElementById('capturePreviewPrev'),next=document.getElementById('capturePreviewNext');
 function pageUrl(){return '/incoming/capture/preview-page?token='+encodeURIComponent(state.token)+'&page='+state.page+'&scale='+Number(state.scale).toFixed(2)}
 function stopLoupe(){state.loupe=0;loupe.style.display='none';tools.querySelectorAll('[data-capture-loupe]').forEach(b=>b.classList.remove('active'))}
 function render(){if(!state.token)return;stopLoupe();status.textContent=state.page+' / '+state.pages;prev.disabled=state.page<=1;next.disabled=state.page>=state.pages;image.src=pageUrl();image.hidden=false;frame.hidden=true;if(empty)empty.hidden=true}
 function fitWidth(){if(!state.width||!shell.clientWidth){render();return}state.scale=Math.max(.55,Math.min(5,Math.max(300,shell.clientWidth-22)/state.width));render()}
 async function activate(token){if(!token)return;state.token=token;state.page=1;state.pages=1;state.scale=1.45;state.width=0;try{const r=await fetch('/incoming/capture/preview-info?token='+encodeURIComponent(token),{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'PDF Vorschau fehlgeschlagen');state.pages=Number(d.pages||1);state.width=Number(d.width||0);tools.hidden=false;fitWidth()}catch(e){console.error('Dunja PDF-Superviewer:',e);tools.hidden=true;image.hidden=true;frame.hidden=false}}
 function reset(){state.token='';state.page=1;state.pages=1;state.width=0;stopLoupe();tools.hidden=true;image.hidden=true;image.removeAttribute('src')}
 prev.addEventListener('click',()=>{if(state.page>1){state.page--;render()}});next.addEventListener('click',()=>{if(state.page<state.pages){state.page++;render()}});
 document.getElementById('capturePreviewMinus')?.addEventListener('click',()=>{state.scale=Math.max(.45,state.scale-.2);render()});document.getElementById('capturePreviewPlus')?.addEventListener('click',()=>{state.scale=Math.min(5,state.scale+.2);render()});document.getElementById('capturePreview100')?.addEventListener('click',()=>{state.scale=1;render()});document.getElementById('capturePreviewWidth')?.addEventListener('click',fitWidth);
 tools.querySelectorAll('[data-capture-loupe]').forEach(button=>button.addEventListener('click',()=>{const value=Number(button.dataset.captureLoupe||0),same=state.loupe===value;stopLoupe();if(!same){state.loupe=value;button.classList.add('active')}}));
 shell.addEventListener('wheel',e=>{if(!e.ctrlKey||!state.token)return;e.preventDefault();state.scale=Math.max(.45,Math.min(5,state.scale+(e.deltaY<0?.18:-.18)));render()},{passive:false});
 image.addEventListener('mousemove',e=>{if(!state.loupe)return;const r=image.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(x<0||y<0||x>r.width||y>r.height)return;const z=state.loupe,lw=loupe.offsetWidth||340,lh=loupe.offsetHeight||235;loupe.style.display='block';loupe.style.left=Math.min(window.innerWidth-lw-8,e.clientX+24)+'px';loupe.style.top=Math.max(8,Math.min(window.innerHeight-lh-8,e.clientY-lh/2))+'px';loupe.style.backgroundImage='url("'+image.src+'")';loupe.style.backgroundSize=(r.width*z)+'px '+(r.height*z)+'px';loupe.style.backgroundPosition=(-x*z+lw/2)+'px '+(-y*z+lh/2)+'px'});image.addEventListener('mouseleave',()=>loupe.style.display='none');
 const realFetch=window.fetch.bind(window);window.fetch=async function(input,init){const response=await realFetch(input,init);try{const url=typeof input==='string'?input:(input?.url||'');if(url.includes('/incoming/capture/analyze'))response.clone().json().then(d=>{if(d?.ok&&d?.previewToken)activate(d.previewToken)}).catch(()=>{})}catch(_){}return response};
 const oldShow=window.showCapturePdf;if(typeof oldShow==='function')window.showCapturePdf=function(file){reset();return oldShow.apply(this,arguments)};
 fileInput?.addEventListener('change',()=>{if(!fileInput.files?.length)reset()});
})();
</script>
'''


def _inject_page(page):
    if "krista-brain-head" not in page:
        page = page.replace("</style>", _brain_header_css() + "\n</style>", 1)
        page = page.replace("<body>", "<body>\n" + _brain_header_html(), 1)
    if 'id="captureSuperTools"' not in page:
        page = page.replace('<div class="capture-pdf-shell">', _capture_toolbar_html() + '\n          <div class="capture-pdf-shell">', 1)
    if "kristaBrainCaptureViewerV2" not in page:
        page = page.replace("</body>", _capture_script() + "\n</body>", 1)
    return page


def _register_navigation(ns):
    app = ns["app"]
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    names = ("kristower", "kriszeit", "kristine", "krisadmin", "tasks")
    if isinstance(allowed, set):
        for name in names:
            allowed.add("/brain-go/" + name)
    if "brain_go" in app.view_functions:
        return
    from flask import redirect
    paths = {"kristower":"/kontrollzentrum","kriszeit":"/kristool-preview/","kristine":"/kristine#planning","krisadmin":"/admin/ui","tasks":"/kristine#tasks"}

    @app.get("/brain-go/<name>")
    def brain_go(name):
        path = paths.get(str(name or "").lower())
        if not path:
            return ("Nicht verfügbar", 404)
        target_path, sep, fragment = path.partition("#")
        base = str(ns.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
        token = str(ns.get("KRISTINE_ADMIN_TOKEN") or "").strip()
        location = base + target_path
        if token:
            location += ("&" if "?" in location else "?") + "token=" + quote(token, safe="")
        if sep:
            location += "#" + fragment
        return redirect(location, code=302)


def _register_preview(ns):
    app = ns["app"]
    if "brain_capture_preview_info" in app.view_functions:
        return
    from flask import request, jsonify, send_file
    import pymupdf
    from io import BytesIO

    original = app.view_functions.get("incoming_capture_analyze")
    if original:
        def wrapped_analyze():
            token = ""
            upload = request.files.get("file")
            if upload:
                try:
                    data = upload.read()
                    upload.stream.seek(0)
                    token = _preview_store(data)
                except Exception:
                    try:
                        upload.stream.seek(0)
                    except Exception:
                        pass
            response = app.make_response(original())
            if token and response.is_json:
                payload = response.get_json(silent=True)
                if isinstance(payload, dict) and payload.get("ok"):
                    payload["previewToken"] = token
                    response.set_data(json.dumps(payload, ensure_ascii=False))
                    response.mimetype = "application/json"
            return response
        wrapped_analyze.__name__ = "incoming_capture_analyze_line2"
        app.view_functions["incoming_capture_analyze"] = wrapped_analyze

    @app.get("/incoming/capture/preview-info")
    def brain_capture_preview_info():
        try:
            path = _preview_path(request.args.get("token"))
            with pymupdf.open(path) as doc:
                if doc.page_count < 1:
                    raise ValueError("PDF hat keine Seiten.")
                rect = doc[0].rect
                return jsonify(ok=True, pages=doc.page_count, width=float(rect.width), height=float(rect.height))
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400

    @app.get("/incoming/capture/preview-page")
    def brain_capture_preview_page():
        try:
            path = _preview_path(request.args.get("token"))
            page_no = max(1, int(request.args.get("page", 1)))
            scale = max(.45, min(5.0, float(request.args.get("scale", 1.45))))
            with pymupdf.open(path) as doc:
                if page_no > doc.page_count:
                    raise ValueError("PDF-Seite existiert nicht.")
                pix = doc[page_no - 1].get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                data = pix.tobytes("png")
            return send_file(BytesIO(data), mimetype="image/png", max_age=0)
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400

    @app.get("/incoming/capture/preview-text")
    def brain_capture_preview_text():
        try:
            path = _preview_path(request.args.get("token"))
            page_no = max(1, int(request.args.get("page", 1)))
            with pymupdf.open(path) as doc:
                if page_no > doc.page_count:
                    raise ValueError("PDF-Seite existiert nicht.")
                page = doc[page_no - 1]
                rect = page.rect
                words = page.get_text("words") or []
                meaningful = "".join(str(w[4] or "") for w in words if len(w) > 4).strip()
                if len(meaningful) < 20:
                    try:
                        lang = str(ns.get("CAPTURE_OCR_LANG") or "deu+eng")
                        dpi = int(ns.get("CAPTURE_OCR_DPI") or 190)
                        textpage = page.get_textpage_ocr(language=lang, dpi=dpi, full=True)
                        words = page.get_text("words", textpage=textpage) or []
                    except Exception:
                        pass
                payload = []
                for word in words:
                    if len(word) < 5:
                        continue
                    x0, y0, x1, y1, text = word[:5]
                    text = str(text or "")
                    if not text.strip():
                        continue
                    payload.append({
                        "x0": round(float(x0), 3), "y0": round(float(y0), 3),
                        "x1": round(float(x1), 3), "y1": round(float(y1), 3),
                        "text": text,
                    })
                return jsonify(ok=True, page=page_no, width=float(rect.width), height=float(rect.height), words=payload)
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400


def _terms(query):
    return [x for x in re.split(r"\s+", str(query or "").strip()) if len(x) >= 2]


def _archive_prefilter(ns, query, limit=900):
    db = Path(ns["DB"])
    terms = _terms(query)
    if not terms or not db.exists():
        return []
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(pdf_index)").fetchall()}
        select = ["filename", "path", "dokumenttyp", "modified", "text"]
        if "doc_year" in cols: select.append("doc_year")
        if "logical_id" in cols: select.append("logical_id")
        clauses = ["text LIKE ?" for _ in terms]
        params = [f"%{term}%" for term in terms]
        sql = "SELECT " + ",".join(select) + " FROM pdf_index WHERE " + " AND ".join(clauses)
        sql += (" AND source='EINGANG'" if "source" in cols else r" AND path LIKE '%\Dokman\%'")
        sql += " ORDER BY modified DESC LIMIT ?"
        params.append(max(20, min(int(limit), 1600)))
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def _capture_prefilter(query, db_path, area, limit=450):
    path = Path(db_path)
    terms = _terms(query)
    if not path.exists() or not terms:
        return []
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    try:
        clauses = ["pdf_text LIKE ?" for _ in terms]
        params = [f"%{term}%" for term in terms] + [max(20, min(int(limit), 900))]
        sql = "SELECT id,doc_id,supplier_name,supplier_address,supplier_number,invoice_date,gross_amount,pdf_path,pdf_text FROM incoming_invoices WHERE " + " AND ".join(clauses) + " ORDER BY invoice_date DESC,id DESC LIMIT ?"
        rows = con.execute(sql, params).fetchall()
        return [{**dict(row), "_area": area} for row in rows]
    except sqlite3.Error:
        return []
    finally:
        con.close()


def _install_material_search(ns):
    if not callable(ns.get("global_material_search")):
        return
    material_search_result = ns["_material_search_result"]
    norm_supplier = ns["_norm_supplier"]
    extract_supplier = ns["_extract_supplier_identity"]
    extract_date = ns["_extract_invoice_date"]
    extract_amount = ns["_extract_invoice_amount"]
    focus = ns["_focus_material_snippet"]

    def fast_search(query, limit=80):
        import difflib
        query = str(query or "").strip()
        if len(query) < 2:
            return {"query":query,"results":[],"exactCount":0,"similarCount":0,"scanned":0}
        try:
            limit_i = max(10, min(200, int(limit)))
        except Exception:
            limit_i = 80
        stamp = (_mtime(ns["DB"]), _mtime(ns["CAPTURE_DB"]), _mtime(ns["CAPTURE_TEST_DB"]))
        key = (query.lower(), limit_i, stamp)
        cached = _cache_get(_QUERY_CACHE, _QUERY_CACHE_LOCK, key, 45)
        if cached is not None:
            return cached
        rows = _archive_prefilter(ns, query) + _capture_prefilter(query, ns["CAPTURE_DB"], "live") + _capture_prefilter(query, ns["CAPTURE_TEST_DB"], "test")
        results = []
        scanned = 0
        seen = set()
        for row in rows:
            text = str(row.get("text") or row.get("pdf_text") or "")
            if not text.strip():
                continue
            scanned += 1
            hit = material_search_result(text, query)
            if not hit:
                continue
            path = str(row.get("path") or row.get("pdf_path") or "")
            identity = str(row.get("logical_id") or row.get("doc_id") or path or row.get("filename") or "")
            if identity in seen:
                continue
            seen.add(identity)
            supplier_name = str(row.get("supplier_name") or "").strip()
            supplier_address = str(row.get("supplier_address") or "").strip()
            if not supplier_name:
                supplier = extract_supplier(text)
                supplier_name = supplier.get("name") or "Lieferant nicht sicher erkannt"
                supplier_address = supplier.get("address") or ""
            date = str(row.get("invoice_date") or "")
            if not date:
                date = extract_date(text)
            amount = row.get("gross_amount")
            if amount is None:
                amount = extract_amount(text)
            base = {
                "filename": row.get("filename") or Path(path).name,
                "path": path,
                "invoiceDate": date,
                "invoiceDateTime": date,
                "amount": amount,
                "supplierName": supplier_name,
                "supplierAddress": supplier_address,
                "supplierNumber": row.get("supplier_number") or "",
                "materialMatches": [],
                "matchScore": 0,
                "matchType": "",
            }
            base.update(hit)
            results.append(base)
            if len(results) >= limit_i * 3:
                break
        results.sort(key=lambda x: (0 if x.get("matchType") == "exact" else 1, -float(x.get("matchScore") or 0), str(x.get("invoiceDate") or "")), reverse=False)
        result = {
            "query": query,
            "results": results[:limit_i],
            "exactCount": sum(1 for x in results if x.get("matchType") == "exact"),
            "similarCount": sum(1 for x in results if x.get("matchType") == "similar"),
            "scanned": scanned,
        }
        _cache_put(_QUERY_CACHE, _QUERY_CACHE_LOCK, key, result)
        return result

    fast_search._brain_fast_material = True
    ns["global_material_search"] = fast_search


def _install_viewer_page(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    ns["MOBILE_PAGE"] = _inject_page(page)


def install(ns):
    global _INSTALLED
    if _INSTALLED:
        return
    _register_navigation(ns)
    _register_preview(ns)
    _install_material_search(ns)
    _install_viewer_page(ns)
    _INSTALLED = True
    print("✅ The Brain Linie 2 aktiv: Navigation · PDF-Superviewer · schnelle Materialsuche")
