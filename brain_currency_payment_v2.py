# coding: utf-8
"""KRISTINE Eingangsrechnung: Zahlungsweg + Fremdwaehrungen + gespeicherter FX-Kurs."""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from datetime import date, datetime

COMMON_CURRENCIES = (
    "EUR", "USD", "CHF", "GBP", "CAD", "AUD", "JPY", "SEK", "NOK", "DKK",
    "PLN", "CZK", "HUF", "RON", "BGN", "CNY", "HKD", "SGD", "NZD", "TRY",
)
PAYMENT_METHODS = {"unknown", "transfer", "direct_debit", "revolut", "cash"}


def _currency(value):
    code = re.sub(r"[^A-Za-z]", "", str(value or "")).upper()[:3]
    return code if len(code) == 3 else "EUR"


def _payment_method(value):
    raw = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "": "unknown", "offen": "unknown", "unbekannt": "unknown",
        "ueberweisung": "transfer", "überweisung": "transfer", "sepa": "transfer", "bank": "transfer",
        "einzug": "direct_debit", "lastschrift": "direct_debit", "abbucher": "direct_debit",
        "revolut": "revolut", "kreditkarte": "revolut", "karte": "revolut",
        "bar": "cash", "barzahlung": "cash", "kassa": "cash",
    }
    method = aliases.get(raw, raw)
    return method if method in PAYMENT_METHODS else "unknown"


def _float(value, default=None):
    try:
        if value in (None, ""):
            return default
        return float(str(value).replace(",", "."))
    except Exception:
        return default


def _detect_currency(text):
    text = str(text or "")
    upper = text.upper()
    for code in ("USD", "CHF", "GBP", "CAD", "AUD", "JPY", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "CNY", "HKD", "SGD", "NZD", "TRY", "EUR"):
        if re.search(rf"(?<![A-Z]){code}(?![A-Z])", upper):
            return code
    if "€" in text:
        return "EUR"
    if "£" in text:
        return "GBP"
    if "$" in text:
        return "USD"
    return "EUR"


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    if app is None or not page or not callable(area_connection) or not callable(capture_area):
        return

    def ensure_schema(con):
        existing = {str(row[1]) for row in con.execute("PRAGMA table_info(incoming_invoices)").fetchall()}
        migrations = {
            "payment_method": "TEXT NOT NULL DEFAULT 'unknown'",
            "fx_rate_to_eur": "REAL",
            "fx_rate_date": "TEXT",
            "fx_rate_source": "TEXT",
            "fx_estimated_eur": "REAL",
            "fx_tolerance_percent": "REAL NOT NULL DEFAULT 3.0",
            "fx_tolerance_eur": "REAL NOT NULL DEFAULT 1.0",
            "settlement_amount_eur": "REAL",
            "settlement_fx_rate": "REAL",
            "settlement_difference_eur": "REAL",
        }
        for name, sql_type in migrations.items():
            if name not in existing:
                con.execute(f"ALTER TABLE incoming_invoices ADD COLUMN {name} {sql_type}")
        con.commit()

    for area_name in ("live", "test"):
        try:
            con = area_connection(area_name)
            try:
                ensure_schema(con)
            finally:
                con.close()
        except Exception as exc:
            print("⚠ FX-Schema", area_name, exc)

    def fx_fields(row):
        d = dict(row or {})
        return {
            "paymentMethod": _payment_method(d.get("payment_method")),
            "fxRateToEur": _float(d.get("fx_rate_to_eur")),
            "fxRateDate": str(d.get("fx_rate_date") or ""),
            "fxRateSource": str(d.get("fx_rate_source") or ""),
            "fxEstimatedEur": _float(d.get("fx_estimated_eur")),
            "fxTolerancePercent": _float(d.get("fx_tolerance_percent"), 3.0),
            "fxToleranceEur": _float(d.get("fx_tolerance_eur"), 1.0),
            "settlementAmountEur": _float(d.get("settlement_amount_eur")),
            "settlementFxRate": _float(d.get("settlement_fx_rate")),
            "settlementDifferenceEur": _float(d.get("settlement_difference_eur")),
        }

    def save_fx(area, invoice_id, payload):
        area = capture_area(area)
        currency = _currency(payload.get("currency"))
        method = _payment_method(payload.get("paymentMethod"))
        gross = max(0.0, _float(payload.get("grossAmount"), 0.0) or 0.0)
        rate = _float(payload.get("fxRateToEur"))
        if currency == "EUR":
            rate = 1.0
        if rate is not None and rate <= 0:
            rate = None
        rate_date = str(payload.get("fxRateDate") or payload.get("invoiceDate") or "")[:10]
        source = str(payload.get("fxRateSource") or ("EUR" if currency == "EUR" else ""))[:120]
        estimated = round(gross * rate, 2) if rate else (round(gross, 2) if currency == "EUR" else None)
        tol_percent = max(0.0, min(25.0, _float(payload.get("fxTolerancePercent"), 3.0) or 0.0))
        tol_eur = max(0.0, min(100.0, _float(payload.get("fxToleranceEur"), 1.0) or 0.0))

        con = area_connection(area)
        try:
            ensure_schema(con)
            con.execute("""
                UPDATE incoming_invoices SET
                    currency=?, payment_method=?, fx_rate_to_eur=?, fx_rate_date=?, fx_rate_source=?,
                    fx_estimated_eur=?, fx_tolerance_percent=?, fx_tolerance_eur=?, updated_at=?
                WHERE id=?
            """, (
                currency, method, rate, rate_date, source, estimated, tol_percent, tol_eur,
                datetime.now().isoformat(timespec="seconds"), int(invoice_id),
            ))
            if area == "live":
                con.execute("""
                    CREATE TABLE IF NOT EXISTS brain_payment_meta(
                        source TEXT NOT NULL, source_id TEXT NOT NULL,
                        payment_method TEXT NOT NULL DEFAULT 'unknown',
                        payment_status TEXT NOT NULL DEFAULT 'open',
                        payment_id TEXT NOT NULL DEFAULT '', note TEXT, updated_at TEXT NOT NULL,
                        PRIMARY KEY(source,source_id)
                    )
                """)
                source_id = f"kristine:{int(invoice_id)}"
                now = datetime.now().isoformat(timespec="seconds")
                old = con.execute("SELECT * FROM brain_payment_meta WHERE source='KRISTINE' AND source_id=?", (source_id,)).fetchone()
                status = str(old["payment_status"] or "open") if old else "open"
                pid = str(old["payment_id"] or "") if old else ""
                note = str(old["note"] or "") if old else ""
                if method != "transfer" and status == "sepa_submitted":
                    status = "open"
                con.execute("""
                    INSERT INTO brain_payment_meta(source,source_id,payment_method,payment_status,payment_id,note,updated_at)
                    VALUES('KRISTINE',?,?,?,?,?,?)
                    ON CONFLICT(source,source_id) DO UPDATE SET
                        payment_method=excluded.payment_method,
                        payment_status=excluded.payment_status,
                        updated_at=excluded.updated_at
                """, (source_id, method, status, pid, note, now))
            con.commit()
            row = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (int(invoice_id),)).fetchone()
            return fx_fields(row)
        finally:
            con.close()

    def augment_invoice(area, invoice):
        if not isinstance(invoice, dict) or not invoice.get("id"):
            return invoice
        con = area_connection(area)
        try:
            ensure_schema(con)
            row = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (int(invoice["id"]),)).fetchone()
            if row:
                invoice.update(fx_fields(row))
        finally:
            con.close()
        return invoice

    if "brain_capture_fx_rate" not in app.view_functions:
        from flask import request, jsonify

        @app.get("/incoming/capture/fx-rate")
        def brain_capture_fx_rate():
            code = _currency(request.args.get("currency"))
            requested = str(request.args.get("date") or "")[:10]
            if code == "EUR":
                return jsonify({"ok": True, "currency": "EUR", "rateToEur": 1.0, "date": requested or date.today().isoformat(), "source": "EUR"})
            day = requested if re.fullmatch(r"\d{4}-\d{2}-\d{2}", requested) else "latest"
            url = f"https://api.frankfurter.app/{urllib.parse.quote(day)}?from={urllib.parse.quote(code)}&to=EUR"
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "KRISTINE/1.0", "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=8) as response:
                    data = json.loads(response.read().decode("utf-8", errors="replace") or "{}")
                rate = _float((data.get("rates") or {}).get("EUR"))
                if not rate or rate <= 0:
                    raise ValueError("Kein EUR-Kurs geliefert.")
                return jsonify({
                    "ok": True, "currency": code, "rateToEur": rate,
                    "date": str(data.get("date") or requested or date.today().isoformat()),
                    "source": "Frankfurter / EZB",
                })
            except Exception as exc:
                return jsonify({"ok": False, "error": f"Online-Kurs nicht verfügbar: {exc}"}), 502

    original_analyze = app.view_functions.get("incoming_capture_analyze")
    if original_analyze and not getattr(original_analyze, "_krista_currency_v2", False):
        def wrapped_analyze():
            response = app.make_response(original_analyze())
            try:
                if response.is_json:
                    body = response.get_json(silent=True) or {}
                    analysis = body.get("analysis") or {}
                    if body.get("ok") and isinstance(analysis, dict):
                        analysis["currency"] = _detect_currency(analysis.get("text") or analysis.get("textPreview") or "")
                        body["analysis"] = analysis
                        response.set_data(json.dumps(body, ensure_ascii=False)); response.mimetype = "application/json"
            except Exception:
                pass
            return response
        wrapped_analyze.__name__ = "incoming_capture_analyze_currency_v2"
        wrapped_analyze._krista_currency_v2 = True
        app.view_functions["incoming_capture_analyze"] = wrapped_analyze

    original_save = app.view_functions.get("incoming_capture_save")
    if original_save and not getattr(original_save, "_krista_currency_v2", False):
        from flask import request

        def wrapped_save():
            try:
                payload = json.loads(request.form.get("payload") or "{}")
            except Exception:
                payload = {}
            response = app.make_response(original_save())
            try:
                if response.is_json:
                    body = response.get_json(silent=True) or {}
                    invoice = body.get("invoice") or {}
                    if body.get("ok") and invoice.get("id"):
                        area = capture_area(payload.get("area") or ("test" if payload.get("trainingMode") else "live"))
                        invoice.update(save_fx(area, invoice["id"], payload)); body["invoice"] = invoice
                        response.set_data(json.dumps(body, ensure_ascii=False)); response.mimetype = "application/json"
            except Exception as exc:
                print("⚠ FX nach Save:", exc)
            return response
        wrapped_save.__name__ = "incoming_capture_save_currency_v2"
        wrapped_save._krista_currency_v2 = True
        app.view_functions["incoming_capture_save"] = wrapped_save

    edit_data = app.view_functions.get("brain_capture_edit_data")
    if edit_data and not getattr(edit_data, "_krista_currency_v2", False):
        from flask import request

        def wrapped_edit_data(invoice_id):
            response = app.make_response(edit_data(invoice_id))
            try:
                if response.is_json:
                    body = response.get_json(silent=True) or {}
                    if body.get("ok") and isinstance(body.get("invoice"), dict):
                        augment_invoice(capture_area(request.args.get("area") or "live"), body["invoice"])
                        response.set_data(json.dumps(body, ensure_ascii=False)); response.mimetype = "application/json"
            except Exception:
                pass
            return response
        wrapped_edit_data.__name__ = "brain_capture_edit_data_currency_v2"
        wrapped_edit_data._krista_currency_v2 = True
        app.view_functions["brain_capture_edit_data"] = wrapped_edit_data

    edit_save = app.view_functions.get("brain_capture_edit_save")
    if edit_save and not getattr(edit_save, "_krista_currency_v2", False):
        from flask import request

        def wrapped_edit_save(invoice_id):
            payload = request.get_json(silent=True) or {}
            response = app.make_response(edit_save(invoice_id))
            try:
                if response.is_json:
                    body = response.get_json(silent=True) or {}
                    if body.get("ok") and isinstance(body.get("invoice"), dict):
                        area = capture_area(payload.get("area") or "live")
                        body["invoice"].update(save_fx(area, invoice_id, payload))
                        response.set_data(json.dumps(body, ensure_ascii=False)); response.mimetype = "application/json"
            except Exception as exc:
                print("⚠ FX nach Edit:", exc)
            return response
        wrapped_edit_save.__name__ = "brain_capture_edit_save_currency_v2"
        wrapped_edit_save._krista_currency_v2 = True
        app.view_functions["brain_capture_edit_save"] = wrapped_edit_save

    dashboard_view = app.view_functions.get("incoming_capture_dashboard")
    if dashboard_view and not getattr(dashboard_view, "_krista_currency_v2", False):
        from flask import request

        def wrapped_dashboard():
            response = app.make_response(dashboard_view())
            try:
                if not response.is_json:
                    return response
                body = response.get_json(silent=True) or {}; dashboard = body.get("dashboard") or {}
                area = capture_area(request.args.get("area") or "live")
                year = str(dashboard.get("year") or request.args.get("year") or datetime.now().year)
                con = area_connection(area)
                try:
                    ensure_schema(con)
                    rows = con.execute("SELECT invoice_date,payment_state,currency,gross_amount,fx_rate_to_eur,fx_estimated_eur FROM incoming_invoices").fetchall()
                    def eur_amount(row):
                        code = _currency(row["currency"])
                        if code == "EUR":
                            return float(row["gross_amount"] or 0)
                        est = _float(row["fx_estimated_eur"])
                        if est is not None:
                            return est
                        rate = _float(row["fx_rate_to_eur"])
                        return float(row["gross_amount"] or 0) * rate if rate else 0.0
                    dashboard["openSum"] = round(sum(eur_amount(r) for r in rows if str(r["payment_state"] or "open").lower() == "open"), 2)
                    dashboard["yearSum"] = round(sum(eur_amount(r) for r in rows if str(r["invoice_date"] or "").startswith(year)), 2)
                finally:
                    con.close()
                body["dashboard"] = dashboard
                response.set_data(json.dumps(body, ensure_ascii=False)); response.mimetype = "application/json"
            except Exception as exc:
                print("⚠ FX Dashboard:", exc)
            return response
        wrapped_dashboard.__name__ = "incoming_capture_dashboard_currency_v2"
        wrapped_dashboard._krista_currency_v2 = True
        app.view_functions["incoming_capture_dashboard"] = wrapped_dashboard

    css = r'''
.capture-payment-method-wrap select{width:100%}
.capture-fx-panel{grid-column:1/-1;border:1px solid #3e4d5f;border-radius:12px;background:#111820;padding:11px 12px;display:grid;grid-template-columns:minmax(150px,.8fr) minmax(150px,.8fr) minmax(120px,.6fr) auto;gap:9px;align-items:end}
.capture-fx-panel[hidden]{display:none!important}.capture-fx-panel label{font-size:11px;color:var(--muted)}.capture-fx-panel input{margin-top:4px}
.capture-fx-rate-line{font-size:12px;color:#c7d2df}.capture-fx-estimate{font-weight:900;font-size:17px}.capture-fx-hint{grid-column:1/-1;color:var(--muted);font-size:11px}
.capture-fx-online{white-space:nowrap;background:#315d91!important;border-color:#315d91!important}.capture-fx-online:disabled{opacity:.6}
@media(max-width:850px){.capture-fx-panel{grid-template-columns:1fr 1fr}.capture-fx-hint{grid-column:1/-1}}@media(max-width:520px){.capture-fx-panel{grid-template-columns:1fr}}
'''

    script = r'''
<script id="kristaCurrencyPaymentV2">
(function(){
  if(typeof captureCurrency==='undefined'||typeof captureGross==='undefined'||document.getElementById('capturePaymentMethod'))return;
  const currencyCodes=__CURRENCIES__;
  currencyCodes.forEach(code=>{if(![...captureCurrency.options].some(o=>String(o.value||o.textContent).toUpperCase()===code)){const o=document.createElement('option');o.value=code;o.textContent=code;captureCurrency.appendChild(o)}});
  const currencyWrap=captureCurrency.parentElement;
  const paymentWrap=document.createElement('div');paymentWrap.className='capture-payment-method-wrap';
  paymentWrap.innerHTML='<div class="formlabel">Zahlungsweg</div><select id="capturePaymentMethod"><option value="unknown">Noch offen</option><option value="transfer">Überweisung / SEPA</option><option value="revolut">Revolut / Kreditkarte</option><option value="direct_debit">Einzug / Lastschrift</option><option value="cash">Bar / Kassa</option></select>';
  currencyWrap.insertAdjacentElement('afterend',paymentWrap);
  const fx=document.createElement('div');fx.id='captureFxPanel';fx.className='capture-fx-panel';fx.hidden=true;
  fx.innerHTML='<label>Umrechnungsfaktor<div class="capture-fx-rate-line" id="captureFxRateLabel">1 USD = EUR</div><input id="captureFxRate" type="number" step="0.000001" min="0"></label><label>Kurs-Stichtag<input id="captureFxDate" type="date"></label><div><div class="formlabel">EUR-Vergleich</div><div id="captureFxEstimate" class="capture-fx-estimate">–</div><div id="captureFxSource" class="sub"></div></div><button id="captureFxOnline" type="button" class="capture-fx-online">↻ Kurs online</button><label>Abgleich ± Prozent<input id="captureFxTolPercent" type="number" min="0" max="25" step="0.1" value="3"></label><label>oder mindestens ± EUR<input id="captureFxTolEur" type="number" min="0" max="100" step="0.01" value="1.00"></label><div class="capture-fx-hint">Der Rechnungskurs wird fix gespeichert. Beim späteren Bank/Revolut-Abgleich darf der tatsächliche Karten-/Bankkurs abweichen; die Toleranz gilt nur zusammen mit Lieferant/Referenz/Datum.</div>';
  paymentWrap.insertAdjacentElement('afterend',fx);
  const payment=document.getElementById('capturePaymentMethod'),rate=document.getElementById('captureFxRate'),rateDate=document.getElementById('captureFxDate'),rateLabel=document.getElementById('captureFxRateLabel'),estimate=document.getElementById('captureFxEstimate'),source=document.getElementById('captureFxSource'),online=document.getElementById('captureFxOnline'),tolP=document.getElementById('captureFxTolPercent'),tolE=document.getElementById('captureFxTolEur');
  let rateSource='';
  const money=(v,c='EUR')=>{try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:c}).format(Number(v||0))}catch{return Number(v||0).toFixed(2)+' '+c}};
  const isoToday=()=>new Date().toISOString().slice(0,10);
  function updateFx(){const code=String(captureCurrency.value||'EUR').toUpperCase(),foreign=code!=='EUR';fx.hidden=!foreign;if(!foreign){rate.value='1';rateDate.value=captureInvoiceDate?.value||isoToday();rateSource='EUR';source.textContent='';estimate.textContent=money(Number(captureGross.value||0),'EUR');return}rateLabel.textContent='1 '+code+' = EUR';if(!rateDate.value)rateDate.value=captureInvoiceDate?.value||isoToday();const r=Number(rate.value||0),gross=Number(captureGross.value||0);estimate.textContent=r>0?('≈ '+money(gross*r,'EUR')):'–';source.textContent=rateSource||'Kurs noch nicht gespeichert'}
  async function fetchRate(){const code=String(captureCurrency.value||'EUR').toUpperCase();if(code==='EUR')return updateFx();online.disabled=true;const old=online.textContent;online.textContent='Lade …';try{const day=rateDate.value||captureInvoiceDate?.value||isoToday(),r=await fetch('/incoming/capture/fx-rate?currency='+encodeURIComponent(code)+'&date='+encodeURIComponent(day),{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Kurs nicht verfügbar');rate.value=Number(d.rateToEur||0).toFixed(6);rateDate.value=d.date||day;rateSource=d.source||'Online';updateFx()}catch(e){source.textContent=e.message||String(e)}finally{online.disabled=false;online.textContent=old}}
  function detectFromAnalysis(){let a={};try{a=captureAnalysis||{}}catch(_){}const code=String(a.currency||'').toUpperCase();if(code&&currencyCodes.includes(code)){captureCurrency.value=code;rate.value=code==='EUR'?'1':'';rateDate.value=captureInvoiceDate?.value||isoToday();rateSource=code==='EUR'?'EUR':'';updateFx();if(code!=='EUR')fetchRate()}}
  captureCurrency.addEventListener('change',()=>{const code=String(captureCurrency.value||'EUR').toUpperCase();rate.value=code==='EUR'?'1':'';rateSource=code==='EUR'?'EUR':'';rateDate.value=captureInvoiceDate?.value||isoToday();updateFx()});captureGross.addEventListener('input',updateFx);rate.addEventListener('input',()=>{rateSource='manuell';updateFx()});rateDate.addEventListener('change',()=>{rateSource='';updateFx()});online.addEventListener('click',fetchRate);if(typeof captureInvoiceDate!=='undefined')captureInvoiceDate.addEventListener('change',()=>{if(!rateDate.value||rateSource==='')rateDate.value=captureInvoiceDate.value;updateFx()});
  if(typeof analyzeCaptureFile==='function'){const originalAnalyze=analyzeCaptureFile;analyzeCaptureFile=async function(){const result=await originalAnalyze.apply(this,arguments);detectFromAnalysis();return result};if(typeof captureFile!=='undefined')captureFile.onchange=analyzeCaptureFile}
  const originalPayload=typeof capturePayload==='function'?capturePayload:null;if(originalPayload){capturePayload=function(){const p=originalPayload.apply(this,arguments),code=String(captureCurrency.value||'EUR').toUpperCase(),r=code==='EUR'?1:Number(rate.value||0);p.paymentMethod=payment.value;p.fxRateToEur=r>0?r:null;p.fxRateDate=rateDate.value||captureInvoiceDate?.value||'';p.fxRateSource=code==='EUR'?'EUR':rateSource;p.fxTolerancePercent=Number(tolP.value||0);p.fxToleranceEur=Number(tolE.value||0);return p}}
  document.addEventListener('click',event=>{const btn=event.target.closest?.('[data-edit-invoice]');if(!btn)return;const id=btn.dataset.editInvoice;setTimeout(async()=>{try{const r=await fetch('/incoming/capture/'+encodeURIComponent(id)+'/edit-data?area='+encodeURIComponent(captureArea),{cache:'no-store'}),d=await r.json();const x=d.invoice||{};if(!r.ok||!d.ok)return;payment.value=x.paymentMethod||'unknown';if(x.currency)captureCurrency.value=x.currency;rate.value=x.fxRateToEur??(x.currency==='EUR'?1:'');rateDate.value=x.fxRateDate||x.invoiceDate||'';rateSource=x.fxRateSource||'';tolP.value=x.fxTolerancePercent??3;tolE.value=x.fxToleranceEur??1;updateFx()}catch(_){ }},250)},true);
  if(typeof renderCaptureRecent==='function'){const originalRecent=renderCaptureRecent;renderCaptureRecent=function(rows){const result=originalRecent.apply(this,arguments),cards=[...captureRecent.querySelectorAll(':scope > .card')];(rows||[]).forEach((x,i)=>{const amount=cards[i]?.querySelector('.invoice-amount');if(!amount)return;amount.textContent=money(x.grossAmount,x.currency||'EUR');if(x.currency&&x.currency!=='EUR'&&x.fxEstimatedEur)amount.textContent+=' · ≈ '+money(x.fxEstimatedEur,'EUR')});return result}}
  updateFx();setTimeout(detectFromAnalysis,0);
})();
</script>
'''
    script = script.replace("__CURRENCIES__", json.dumps(list(COMMON_CURRENCIES), ensure_ascii=False))
    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ KRISTINE FX/Zahlungsweg V2: Fremdwaehrungen · Online-Kurs · Revolut/SEPA · Kurs gespeichert")
