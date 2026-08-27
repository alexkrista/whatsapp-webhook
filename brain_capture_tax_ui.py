# coding: utf-8
"""KRISTINE Capture UI: MwSt/Steuerart je Kontierungszeile als Dropdown.

Die Steuerart ist fachlich mehr als nur der Prozentwert: 20 % Inland und
20 % ig Lieferung duerfen nicht zusammenfallen. Deshalb speichert KRISTINE
zusätzlich zur bestehenden vat_rate nun tax_class je Kontierungszeile.

Stabilitaet bleibt wie beim V2-Fix: Der MutationObserver beobachtet nur direkte
Zeilenwechsel im Allocation-Host. DOM-Aenderungen innerhalb einer Zeile loesen
keine selbstverstaerkende Observer-Schleife aus.
"""
from __future__ import annotations

import json
import re


TAX_TYPES = [
    {"code": "inland_0", "rate": 0.0, "label": "Inland 0 %"},
    {"code": "inland_4_9", "rate": 4.9, "label": "Inland 4,9 %"},
    {"code": "inland_10", "rate": 10.0, "label": "Inland 10 %"},
    {"code": "inland_20", "rate": 20.0, "label": "Inland 20 %"},
    {"code": "ig_10", "rate": 10.0, "label": "10 % ig Lieferung"},
    {"code": "ig_20", "rate": 20.0, "label": "20 % ig Lieferung"},
    {"code": "reverse_charge_19", "rate": 19.0, "label": "19 % Reverse Charge"},
]
TAX_CODES = {x["code"] for x in TAX_TYPES}


def _default_tax_class(rate):
    try:
        value = float(rate or 0)
    except Exception:
        value = 0.0
    if abs(value - 4.9) < 0.01:
        return "inland_4_9"
    if abs(value - 10.0) < 0.01:
        return "inland_10"
    if abs(value - 19.0) < 0.01:
        return "reverse_charge_19"
    if abs(value - 20.0) < 0.01:
        return "inland_20"
    return "inland_0"


def _clean_tax_class(value, rate=0):
    code = str(value or "").strip()
    return code if code in TAX_CODES else _default_tax_class(rate)


def _ensure_tax_schema(area_connection):
    for area in ("live", "test"):
        try:
            con = area_connection(area)
            try:
                cols = {str(r[1]) for r in con.execute("PRAGMA table_info(incoming_allocations)").fetchall()}
                if "tax_class" not in cols:
                    con.execute("ALTER TABLE incoming_allocations ADD COLUMN tax_class TEXT")
                    con.commit()
            finally:
                con.close()
        except Exception as exc:
            print("⚠ Capture Tax Schema", area, exc)


def _save_tax_classes(area_connection, area, invoice_id, allocations):
    if not invoice_id or not isinstance(allocations, list):
        return
    con = area_connection(area)
    try:
        cols = {str(r[1]) for r in con.execute("PRAGMA table_info(incoming_allocations)").fetchall()}
        if "tax_class" not in cols:
            con.execute("ALTER TABLE incoming_allocations ADD COLUMN tax_class TEXT")
        for index, item in enumerate(allocations, 1):
            item = item or {}
            line_no = int(item.get("lineNo") or index)
            code = _clean_tax_class(item.get("taxClass"), item.get("vatRate"))
            con.execute(
                "UPDATE incoming_allocations SET tax_class=? WHERE invoice_id=? AND line_no=?",
                (code, int(invoice_id), line_no),
            )
        con.commit()
    finally:
        con.close()


def _invoice_id_from_response(area_connection, area, data):
    invoice = (data or {}).get("invoice") or {}
    try:
        invoice_id = int(invoice.get("id") or 0)
    except Exception:
        invoice_id = 0
    if invoice_id:
        return invoice_id
    doc_id = str(invoice.get("docId") or "").strip()
    if not doc_id:
        return 0
    con = area_connection(area)
    try:
        row = con.execute("SELECT id FROM incoming_invoices WHERE doc_id=? LIMIT 1", (doc_id,)).fetchone()
        return int(row[0]) if row else 0
    finally:
        con.close()


def _install_backend(ns):
    app = ns.get("app")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    if app is None or not callable(area_connection) or not callable(capture_area):
        return
    if getattr(app, "_krista_capture_tax_classes_v3", False):
        return

    _ensure_tax_schema(area_connection)
    from flask import request

    original_save = app.view_functions.get("incoming_capture_save")
    if original_save:
        def capture_save_with_tax_class():
            try:
                payload = json.loads(str(request.form.get("payload") or "{}"))
            except Exception:
                payload = {}
            response = app.make_response(original_save())
            try:
                if response.status_code < 400 and response.is_json:
                    data = response.get_json(silent=True) or {}
                    if data.get("ok"):
                        area = capture_area(payload.get("area") or "live")
                        invoice_id = _invoice_id_from_response(area_connection, area, data)
                        _save_tax_classes(area_connection, area, invoice_id, payload.get("allocations") or [])
            except Exception as exc:
                print("⚠ Capture Tax: Steuerart nach Speichern", exc)
            return response
        capture_save_with_tax_class.__name__ = "incoming_capture_save_tax_class_v3"
        app.view_functions["incoming_capture_save"] = capture_save_with_tax_class

    original_edit_save = app.view_functions.get("brain_capture_edit_save")
    if original_edit_save:
        def capture_edit_save_with_tax_class(invoice_id):
            body = request.get_json(silent=True) or {}
            response = app.make_response(original_edit_save(invoice_id))
            try:
                if response.status_code < 400 and response.is_json:
                    data = response.get_json(silent=True) or {}
                    if data.get("ok"):
                        area = capture_area(body.get("area") or "live")
                        _save_tax_classes(area_connection, area, invoice_id, body.get("allocations") or [])
            except Exception as exc:
                print("⚠ Capture Tax: Steuerart nach Bearbeiten", exc)
            return response
        capture_edit_save_with_tax_class.__name__ = "brain_capture_edit_save_tax_class_v3"
        app.view_functions["brain_capture_edit_save"] = capture_edit_save_with_tax_class

    original_edit_data = app.view_functions.get("brain_capture_edit_data")
    if original_edit_data:
        def capture_edit_data_with_tax_class(invoice_id):
            response = app.make_response(original_edit_data(invoice_id))
            try:
                if response.status_code < 400 and response.is_json:
                    data = response.get_json(silent=True) or {}
                    if data.get("ok") and isinstance((data.get("invoice") or {}).get("allocations"), list):
                        area = capture_area(request.args.get("area") or "live")
                        con = area_connection(area)
                        try:
                            rows = con.execute(
                                "SELECT line_no,vat_rate,tax_class FROM incoming_allocations WHERE invoice_id=? ORDER BY line_no",
                                (int(invoice_id),),
                            ).fetchall()
                        finally:
                            con.close()
                        tax_by_line = {
                            int(r[0]): _clean_tax_class(r[2], r[1])
                            for r in rows
                        }
                        for index, item in enumerate(data["invoice"]["allocations"], 1):
                            line_no = int((item or {}).get("lineNo") or index)
                            item["taxClass"] = tax_by_line.get(line_no, _default_tax_class((item or {}).get("vatRate")))
                        response.set_data(json.dumps(data, ensure_ascii=False))
                        response.mimetype = "application/json"
            except Exception as exc:
                print("⚠ Capture Tax: Steuerart beim Bearbeiten laden", exc)
            return response
        capture_edit_data_with_tax_class.__name__ = "brain_capture_edit_data_tax_class_v3"
        app.view_functions["brain_capture_edit_data"] = capture_edit_data_with_tax_class

    app._krista_capture_tax_classes_v3 = True


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page:
        return

    _install_backend(ns)

    # capturePayload() wird von Neu-Speichern UND Bearbeiten verwendet. TaxClass
    # deshalb dort mitgeben, ohne die grosse Basisdatei anzufassen.
    page = page.replace(
        "vatRate:captureNumber(row.vatRate)}))",
        "vatRate:captureNumber(row.vatRate),taxClass:String(row.taxClass||'')}))",
    )
    # Beim Bearbeiten die vom Backend geladene Steuerart nicht wegwerfen.
    page = page.replace(
        "vatRate:Number(a.vatRate||0)}));",
        "vatRate:Number(a.vatRate||0),taxClass:a.taxClass||''}));",
    )

    # Alte Tax-UI-Blöcke entfernen, damit wirklich nur V3 aktiv ist.
    page = re.sub(r'<script\s+id=["\']kristaCaptureTaxUiV[12]["\'][^>]*>.*?</script>', '', page, flags=re.I | re.S)
    page = re.sub(r'<style\s+id=["\']kristaCaptureTaxUiCss["\'][^>]*>.*?</style>', '', page, flags=re.I | re.S)

    css = r'''
<style id="kristaCaptureTaxUiCss">
#captureAllocations{display:grid!important;gap:0!important}
.capture-allocation{
  margin:0!important;padding:10px 0!important;border-top:1px solid #2c313a!important;
  align-items:end!important;column-gap:8px!important;row-gap:8px!important
}
.capture-allocation:last-child{border-bottom:1px solid #2c313a!important}
.capture-allocation>div{
  min-width:0!important;align-self:stretch!important;display:flex!important;
  flex-direction:column!important;justify-content:flex-end!important
}
.capture-allocation .formlabel{
  min-height:18px!important;height:18px!important;margin:0 0 5px 3px!important;
  display:flex!important;align-items:center!important;white-space:nowrap!important;line-height:18px!important
}
.capture-allocation input,.capture-allocation select,.capture-allocation .remove{
  height:42px!important;min-height:42px!important;box-sizing:border-box!important
}
.capture-tax-select{min-width:155px!important;font-weight:750!important}
.capture-tax-allocation-hint{margin:8px 0 2px!important;color:#8f98a5!important;font-size:11px!important;line-height:1.35!important}
</style>
'''

    tax_json = json.dumps(TAX_TYPES, ensure_ascii=False)
    script = f'''
<script id="kristaCaptureTaxUiV3">
(function(){{
  const taxTypes={tax_json};
  const byCode=new Map(taxTypes.map(x=>[x.code,x]));
  const num=v=>{{const n=Number(String(v??'').replace(',','.'));return Number.isFinite(n)?n:0}};
  const hintText='MwSt / Steuerart je Kontierungszeile wählen. Bei gemischten Steuerarten einfach eine weitere Kontierungszeile verwenden.';

  function defaultCode(rate){{
    const n=num(rate);
    if(Math.abs(n-4.9)<.01)return 'inland_4_9';
    if(Math.abs(n-10)<.01)return 'inland_10';
    if(Math.abs(n-19)<.01)return 'reverse_charge_19';
    if(Math.abs(n-20)<.01)return 'inland_20';
    return 'inland_0';
  }}

  function hideInvoiceVat(){{
    const vat=document.getElementById('captureVat'),wrap=vat?.parentElement;
    if(!vat||!wrap)return;
    if(!wrap.hidden)wrap.hidden=true;
    if(wrap.style.display!=='none')wrap.style.display='none';
    wrap.classList.remove('capture-money-row','capture-span-1','capture-span-2','capture-span-3','full');
  }}

  function syncHiddenVat(){{
    const net=document.getElementById('captureNet'),gross=document.getElementById('captureGross'),vat=document.getElementById('captureVat');
    if(!net||!gross||!vat)return;
    if(String(net.value||'').trim()===''||String(gross.value||'').trim()==='')return;
    const next=(Math.round((num(gross.value)-num(net.value))*100)/100).toFixed(2);
    if(vat.value!==next)vat.value=next;
  }}

  function taxSelect(row){{
    const current=row.querySelector('[data-field="vatRate"]');
    if(!current)return;
    const index=Number(row.dataset.allocation||0);
    if(typeof captureAllocationRows==='undefined'||!captureAllocationRows[index])return;
    const state=captureAllocationRows[index];
    let code=String(state.taxClass||'');
    if(!byCode.has(code))code=defaultCode(state.vatRate);
    state.taxClass=code;
    state.vatRate=String(byCode.get(code)?.rate??num(state.vatRate));

    if(current.tagName==='SELECT'&&current.dataset.kristaTaxSelect==='1'){{
      if(current.value!==code)current.value=code;
      return;
    }}

    const select=document.createElement('select');
    select.dataset.field='vatRate';
    select.dataset.kristaTaxSelect='1';
    select.className=(current.className?current.className+' ':'')+'capture-tax-select';
    select.innerHTML=taxTypes.map(x=>'<option value="'+x.code+'">'+x.label+'</option>').join('');
    select.value=code;
    const changed=()=>{{
      const picked=byCode.get(select.value)||taxTypes[0];
      state.taxClass=picked.code;
      state.vatRate=String(picked.rate);
      if(typeof updateCaptureAllocationTotal==='function')updateCaptureAllocationTotal();
      syncHiddenVat();
    }};
    select.onchange=changed;
    select.oninput=changed;
    current.replaceWith(select);
  }}

  function polishAllocations(){{
    const host=document.getElementById('captureAllocations');if(!host)return;
    host.querySelectorAll('.capture-allocation').forEach(row=>{{
      taxSelect(row);
      const vatInput=row.querySelector('[data-field="vatRate"]');
      const vatLabel=vatInput?.parentElement?.querySelector('.formlabel');
      if(vatLabel&&vatLabel.textContent!=='MwSt / Steuerart')vatLabel.textContent='MwSt / Steuerart';
      const netInput=row.querySelector('[data-field="netAmount"]');
      const netLabel=netInput?.parentElement?.querySelector('.formlabel');
      if(netLabel&&netLabel.textContent!=='Netto')netLabel.textContent='Netto';
    }});
    let hint=document.getElementById('captureTaxAllocationHint');
    if(!hint){{hint=document.createElement('div');hint.id='captureTaxAllocationHint';hint.className='capture-tax-allocation-hint';host.insertAdjacentElement('afterend',hint)}}
    if(hint.textContent!==hintText)hint.textContent=hintText;
  }}

  function hook(){{
    if(document.documentElement.dataset.kristaTaxUiV3==='1')return;
    document.documentElement.dataset.kristaTaxUiV3='1';
    hideInvoiceVat();polishAllocations();syncHiddenVat();
    const net=document.getElementById('captureNet'),gross=document.getElementById('captureGross');
    net?.addEventListener('input',syncHiddenVat);net?.addEventListener('change',syncHiddenVat);
    gross?.addEventListener('input',syncHiddenVat);gross?.addEventListener('change',syncHiddenVat);
    const host=document.getElementById('captureAllocations');
    if(host){{
      // Nur direkte Zeilenwechsel. Das ist absichtlich KEIN subtree-Observer.
      new MutationObserver(()=>polishAllocations()).observe(host,{{childList:true,subtree:false}});
      host.addEventListener('input',e=>{{if(e.target?.matches?.('[data-field="netAmount"]'))syncHiddenVat()}});
      host.addEventListener('change',e=>{{if(e.target?.matches?.('[data-field="netAmount"]'))syncHiddenVat()}});
    }}
  }}

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hook,{{once:true}});else hook();
}})();
</script>
'''

    page = page.replace("</head>", css + "\n</head>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Capture Tax UI V3: Steuerarten-Dropdown + persistente TaxClass · stabiler Observer")
