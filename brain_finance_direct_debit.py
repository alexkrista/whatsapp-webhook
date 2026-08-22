# coding: utf-8
"""KRISTINE Finance: erwartete Einzuege getrennt vom Zahl-OP.

WinWorker kennzeichnet Lastschrift/Einzug ueber seinen Zahlungsstatus bzw. ggf.
ueber eine Zahlungsart-Spalte. Solche Rechnungen bleiben in KRISTINE sichtbar,
bis der lokale Zahlungsstatus durch den spaeteren CAMT-Abgleich auf paid gesetzt
wird.

Wichtig fuer den einmaligen Altbestands-Cutover:
- Vor dem Cutover-Stichtag werden alte WW-Einzuege gar nicht mehr geladen.
- Neue/aktuelle WW-Einzuege werden gesammelt in EINER SQLite-Transaktion vorgemerkt,
  nicht mehr einzeln pro Rechnung. Das verhindert das minutenlange Haengen beim
  ersten OP-Aufruf.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from brain_finance_source import FinanceStore, norm_method, norm_status
from brain_finance_runtime import _parse_finance_task


def _norm(value):
    text = str(value or "").strip().lower()
    return (text.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
                .replace("ß", "ss"))


def _identifier(name):
    return "[" + str(name or "").replace("]", "]]" ) + "]"


def _iso_day(value):
    raw = str(value or "").strip()[:10]
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except Exception:
        return None


def _pick_columns(cursor):
    try:
        rows = cursor.execute("""
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='Eingangsbelege'
        """).fetchall()
    except Exception:
        return "", ""
    names = [str(getattr(r, "COLUMN_NAME", r[0]) or "") for r in rows]

    due_scored = []
    payment_scored = []
    for name in names:
        n = _norm(name)
        due_score = 0
        if "faellig" in n or "fallig" in n:
            due_score = 100
        elif "zahlungsziel" in n:
            due_score = 80
        if due_score:
            if "datum" in n or n.startswith(("d", "dz")):
                due_score += 10
            due_scored.append((due_score, name))

        pay_score = 0
        if "zahlungsart" in n or "zahlart" in n:
            pay_score = 100
        elif "zahlungsweise" in n or "zahlweise" in n:
            pay_score = 95
        elif "lastschrift" in n or "einzug" in n or "abbuch" in n:
            pay_score = 90
        if pay_score:
            payment_scored.append((pay_score, name))

    due = sorted(due_scored, reverse=True)[0][1] if due_scored else ""
    payment = sorted(payment_scored, reverse=True)[0][1] if payment_scored else ""
    return due, payment


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    sql_connection = ns.get("sql_connection")
    iso_date = ns.get("_iso_date")
    lookup_paths = ns.get("_pdf_paths_by_docids")
    kristine_api = ns.get("kristine_api_request")
    if app is None or not page or not callable(sql_connection):
        return

    store = FinanceStore(ns)

    def direct_debit_cutoff():
        """Fixer Cutover-Stichtag; vor Initialisierung: heute - 14 Tage."""
        fallback = date.today() - timedelta(days=14)
        try:
            con = store.con()
            try:
                exists = con.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='brain_direct_debit_cutover_state'"
                ).fetchone()
                if not exists:
                    return fallback
                row = con.execute(
                    "SELECT cutoff_date FROM brain_direct_debit_cutover_state WHERE id=1"
                ).fetchone()
                parsed = _iso_day(row["cutoff_date"] if row else "")
                return parsed or fallback
            finally:
                con.close()
        except Exception:
            return fallback

    def approval_index():
        if not callable(kristine_api):
            return {}
        try:
            boot = kristine_api("/kristine/api/bootstrap") or {}
            out = {}
            for task in boot.get("tasks") or []:
                meta = _parse_finance_task(task)
                if meta:
                    out[(str(meta.get("source") or ""), str(meta.get("id") or ""))] = meta
            return out
        except Exception:
            return {}

    def persist_current_debits(source_ids):
        ids = sorted({str(x or "").strip() for x in source_ids if str(x or "").strip()})
        if not ids:
            return
        now = datetime.now().isoformat(timespec="seconds")
        con = store.con()
        try:
            for sid in ids:
                con.execute(
                    """INSERT INTO brain_payment_meta
                       (source,source_id,payment_method,payment_status,payment_id,note,updated_at)
                       VALUES('WinWorker',?,'direct_debit','open','',?,?)
                       ON CONFLICT(source,source_id) DO UPDATE SET
                         payment_method='direct_debit',
                         updated_at=excluded.updated_at""",
                    (sid, "WW Einzug erkannt", now),
                )
            con.commit()
        finally:
            con.close()

    def ww_direct_debits():
        cutoff = direct_debit_cutoff()
        meta = store.meta()
        legacy = store.legacy()
        con = sql_connection("WinWorker_Projekte_Standard")
        try:
            cur = con.cursor()
            due_col, payment_col = _pick_columns(cur)
            due_sql = f", e.{_identifier(due_col)} AS ddDueDate" if due_col else ", NULL AS ddDueDate"
            payment_sql = f", e.{_identifier(payment_col)} AS ddPaymentHint" if payment_col else ", NULL AS ddPaymentHint"
            due_expr = f"COALESCE(e.{_identifier(due_col)},e.dzBelegdatum)" if due_col else "e.dzBelegdatum"
            sql = """
                SELECT e.cID,e.sBelegnummer,e.dzBelegdatum,e.dblBruttoBetrag,
                       e.lVonAdrIndex,e.sZahlungsStatus,dm.sDocID,
                       k.sFirma,k.sName,k.sVorname
            """ + due_sql + payment_sql + """
                FROM dbo.Eingangsbelege e
                LEFT JOIN dbo.DokumentenManagement dm ON dm.gID=e.gDMID
                LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden k ON k.StammIndex=e.lVonAdrIndex
                WHERE """ + due_expr + """ >= ?
                ORDER BY """ + due_expr + """,e.cID
            """
            rows = cur.execute(sql, cutoff.isoformat()).fetchall()
        finally:
            con.close()

        keep = []
        docs = []
        newly_detected = []
        for r in rows:
            sid = f"ww:{int(r.cID)}"
            ex = meta.get(("WinWorker", sid), {})
            method = norm_method(ex.get("paymentMethod"))
            local_status = norm_status(ex.get("paymentStatus"))
            legacy_paid = bool(legacy.get(sid) and legacy[sid].get("status") == "paid")

            raw_status = str(getattr(r, "sZahlungsStatus", "") or "")
            hint_value = getattr(r, "ddPaymentHint", None)
            hint_text = str(hint_value or "")
            hint_name = _norm(payment_col)
            probe = _norm(raw_status + " " + hint_text)
            raw_debit = any(token in probe for token in ("lastschrift", "einzug", "abbuch", "bankeinzug"))
            if not raw_debit and any(token in hint_name for token in ("lastschrift", "einzug", "abbuch")):
                truth = _norm(hint_value)
                raw_debit = truth in {"1", "true", "ja", "yes", "x", "j"}

            if raw_debit and method != "direct_debit" and local_status != "paid":
                method = "direct_debit"
                newly_detected.append(sid)

            if method != "direct_debit":
                continue
            if local_status == "paid" or legacy_paid:
                continue

            invoice_date = iso_date(r.dzBelegdatum) if callable(iso_date) else str(r.dzBelegdatum or "")[:10]
            due_raw = getattr(r, "ddDueDate", None)
            due_date = iso_date(due_raw) if due_raw is not None and callable(iso_date) else str(due_raw or "")[:10]
            due_date = due_date or invoice_date or ""
            expected = _iso_day(due_date)
            if expected is not None and expected < cutoff:
                continue

            doc = str(getattr(r, "sDocID", "") or "").strip()
            if doc:
                docs.append(doc)
            keep.append((r, sid, doc, raw_status, invoice_date, due_date))

        # Einmalige Sammelschreibung statt hunderten Einzel-Commits.
        try:
            persist_current_debits(newly_detected)
        except Exception as exc:
            print("⚠ WW Einzuege konnten nicht gesammelt vorgemerkt werden:", exc)

        paths = {}
        if callable(lookup_paths) and docs:
            try:
                paths = lookup_paths(docs, include_text=False)
            except Exception:
                paths = {}

        out = []
        for r, sid, doc, raw_status, invoice_date, due_date in keep:
            company = str(getattr(r, "sFirma", "") or "").strip()
            person = " ".join(x for x in [str(getattr(r, "sVorname", "") or "").strip(), str(getattr(r, "sName", "") or "").strip()] if x)
            found = paths.get(doc, {}) if doc else {}
            out.append({
                "id": sid,
                "docId": doc,
                "supplier": company or person or f"WW-Adresse {getattr(r, 'lVonAdrIndex', '') or ''}".strip(),
                "invoiceNumber": str(getattr(r, "sBelegnummer", "") or "").strip(),
                "invoiceDate": invoice_date or "",
                "dueDate": due_date,
                "expectedDebitDate": due_date,
                "amount": float(getattr(r, "dblBruttoBetrag", 0) or 0),
                "currency": "EUR",
                "paymentState": "open",
                "paymentStatus": "open",
                "paymentMethod": "direct_debit",
                "approvalStatus": "not_required",
                "workflowStatus": "WinWorker",
                "path": str(found.get("pdfPath") or found.get("originalPath") or ""),
                "source": "WinWorker",
                "wwStatusRaw": raw_status,
            })
        return out

    def kristine_direct_debits():
        approvals = approval_index()
        rows = []
        try:
            candidates = store.kristine(False)
        except Exception:
            candidates = []
        for item in candidates:
            if norm_method(item.get("paymentMethod")) != "direct_debit":
                continue
            row = dict(item)
            row["expectedDebitDate"] = row.get("dueDate") or row.get("invoiceDate") or ""
            meta = approvals.get(("KRISTINE", str(row.get("id") or "")))
            row["approvalStatus"] = str((meta or {}).get("decision") or "pending")
            row["approvalReason"] = str((meta or {}).get("reason") or "")
            rows.append(row)
        return rows

    def direct_debits():
        rows = ww_direct_debits() + kristine_direct_debits()
        seen = set()
        clean = []
        for row in rows:
            key = (str(row.get("source") or ""), str(row.get("id") or ""))
            if key in seen:
                continue
            seen.add(key)
            clean.append(row)
        clean.sort(key=lambda x: (
            str(x.get("expectedDebitDate") or x.get("dueDate") or x.get("invoiceDate") or "9999-12-31"),
            str(x.get("supplier") or "").lower(),
            float(x.get("amount") or 0),
        ))
        return clean

    original_items = app.view_functions.get("brain_incoming_payment_open_items")
    if original_items and not getattr(original_items, "_krista_direct_debit", False):
        from flask import jsonify

        def payment_open_items_with_debits():
            response = app.make_response(original_items())
            try:
                if not response.is_json:
                    return response
                body = response.get_json(silent=True) or {}
                if not body.get("ok"):
                    return response
                rows = direct_debits()
                totals = {}
                for row in rows:
                    cur = str(row.get("currency") or "EUR")
                    totals[cur] = round(float(totals.get(cur, 0)) + float(row.get("amount") or 0), 2)
                body["directDebit"] = rows
                body["directDebitCount"] = len(rows)
                body["directDebitTotals"] = totals
                response = jsonify(body)
            except Exception as exc:
                print("⚠ Erwartete Einzuege:", exc)
            return response

        payment_open_items_with_debits.__name__ = "brain_incoming_payment_open_items_direct_debit"
        payment_open_items_with_debits._krista_direct_debit = True
        app.view_functions["brain_incoming_payment_open_items"] = payment_open_items_with_debits

    original_page = app.view_functions.get("brain_incoming_payments_page")
    if original_page and not getattr(original_page, "_krista_direct_debit", False):
        from flask import Response

        def payments_page_with_debits():
            response = app.make_response(original_page())
            html = response.get_data(as_text=True)
            html = html.replace("<h2>Offene Überweisungen</h2>", "<h2>Zu zahlende Rechnungen</h2>")
            section = r'''
<section class="card" id="directDebitCard">
  <div class="section-title"><h2>Erwartete Einzüge</h2><span class="hint">Bleiben hier bis zum tatsächlichen CAMT-Treffer – auch wenn WinWorker bereits „Lastschrift beglichen“ meldet.</span></div>
  <div id="directDebitMeta" class="note">Einzüge werden geladen …</div>
  <div id="directDebitRows"><div class="empty">Wird geladen …</div></div>
</section>
'''
            marker = '<section class="card unknown">'
            if 'id="directDebitCard"' not in html and marker in html:
                html = html.replace(marker, section + marker, 1)
            css = r'''
<style id="kristaDirectDebitCss">
.dd-group{border-top:1px solid var(--line);padding-top:8px;margin-top:8px}.dd-group:first-child{border-top:0;margin-top:0}.dd-head{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:5px 6px 8px}.dd-head strong{font-size:14px}.dd-head span{color:var(--muted);font-size:12px}.dd-row{display:grid;grid-template-columns:105px minmax(160px,1.2fr) minmax(120px,.8fr) 125px 190px 90px;gap:9px;align-items:center;padding:9px 6px;border-top:1px solid var(--line);font-size:13px}.dd-wait{color:#9cc7ff;font-weight:850;font-size:11px}.dd-warn{color:var(--warn);font-weight:850;font-size:11px}.dd-blocked{color:var(--danger);font-weight:850;font-size:11px}@media(max-width:900px){.dd-row{grid-template-columns:1fr 1fr}}@media(max-width:520px){.dd-row{grid-template-columns:1fr}}
</style>
'''
            if 'kristaDirectDebitCss' not in html:
                html = html.replace('</head>', css + '</head>', 1)
            script = r'''
<script id="kristaDirectDebitV1">
(function(){
 const box=document.getElementById('directDebitRows'),meta=document.getElementById('directDebitMeta');if(!box||!meta)return;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=(n,c='EUR')=>{try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0))}catch(_){return Number(n||0).toFixed(2)+' '+c}};
 const date=s=>{const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]+'.'+m[1]:(s||'–')};
 const status=x=>x.approvalStatus==='blocked'?'<span class="dd-blocked">⛔ gesperrt · Einzug trotzdem beobachten</span>':x.approvalStatus==='pending'?'<span class="dd-warn">⏳ Freigabe offen · wartet auf CAMT</span>':'<span class="dd-wait">↙ erwartet · wartet auf CAMT</span>';
 const pdf=x=>x.path?`<a class="pdf" href="/pdf?path=${encodeURIComponent(x.path)}" target="_blank">PDF</a>`:'–';
 function totals(rows){const t={};rows.forEach(x=>{const c=x.currency||'EUR';t[c]=(t[c]||0)+Number(x.amount||0)});return Object.entries(t).map(([c,n])=>money(n,c)).join(' · ')}
 function render(rows){
   rows=[...(rows||[])].sort((a,b)=>String(a.expectedDebitDate||a.dueDate||'9999').localeCompare(String(b.expectedDebitDate||b.dueDate||'9999'))||String(a.supplier||'').localeCompare(String(b.supplier||''),'de'));
   meta.innerHTML=`<strong>${rows.length} erwartete Einzüge</strong>${rows.length?' · '+esc(totals(rows)):''} · älteste Fälligkeit zuerst`;
   if(!rows.length){box.innerHTML='<div class="empty">Keine erwarteten Einzüge.</div>';return}
   const groups=new Map();rows.forEach(x=>{const k=String(x.supplier||'Ohne Lieferant');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)});
   box.innerHTML=[...groups.entries()].map(([supplier,items])=>`<div class="dd-group"><div class="dd-head"><strong>${esc(supplier)}</strong><span>${items.length} Rechnung(en) · ${esc(totals(items))}</span></div>${items.map(x=>`<div class="dd-row"><div><strong>${esc(date(x.expectedDebitDate||x.dueDate))}</strong><div class="sub">erwarteter Einzug</div></div><div><div>${esc(x.invoiceNumber||'–')}</div><div class="sub">${esc(x.source||'')}</div></div><div class="amount">${esc(money(x.amount,x.currency))}</div><div>${status(x)}</div><div class="sub">${x.wwStatusRaw?'WW: '+esc(x.wwStatusRaw):''}</div><div>${pdf(x)}</div></div>`).join('')}</div>`).join('');
 }
 fetch('/incoming/payment-open-items',{cache:'no-store'}).then(r=>r.json().then(d=>[r,d])).then(([r,d])=>{if(!r.ok||!d.ok)throw Error(d.error||'Einzüge konnten nicht geladen werden');render(d.directDebit||[])}).catch(e=>{meta.textContent='Einzüge konnten nicht geladen werden';box.innerHTML='<div class="empty">'+esc(e.message||e)+'</div>'});
})();
</script>
'''
            if 'kristaDirectDebitV1' not in html:
                html = html.replace('</body>', script + '</body>', 1)
            return Response(html, mimetype="text/html")

        payments_page_with_debits.__name__ = "brain_incoming_payments_page_direct_debit"
        payments_page_with_debits._krista_direct_debit = True
        app.view_functions["brain_incoming_payments_page"] = payments_page_with_debits

    print("✅ OP Einzug: aktueller Cutover schnell · alte WW-Einzuege nicht mehr gescannt · danach CAMT")