"""Require a confirmed, valid beneficiary IBAN before SEPA capture writes."""
import json
import re

from brain_finance_source import norm_method

ERROR = "Bei Überweisung / SEPA ist eine gültige IBAN erforderlich. Bitte die Lieferanten-IBAN ergänzen oder die Rechnungs-IBAN ausdrücklich übernehmen."


def install(ns):
    app = ns.get("app")
    if app is None or getattr(app, "_capture_iban_required", False):
        return
    app._capture_iban_required = True
    from flask import jsonify, request

    @app.before_request
    def require_capture_iban():
        create = request.method == "POST" and request.path == "/incoming/capture/save"
        edit = request.method == "PUT" and re.fullmatch(r"/incoming/capture/\d+/edit", request.path)
        if not (create or edit):
            return
        try:
            payload = json.loads(request.form.get("payload") or "{}") if create else (request.get_json(silent=True) or {})
            if norm_method(payload.get("paymentMethod")) != "transfer":
                return
            area = ns["_capture_area"](payload.get("area") or ("test" if payload.get("trainingMode") else "live"))
            accepted = ns["_capture_truthy"](payload.get("acceptNewIban"))
            if accepted:
                iban = payload.get("invoiceIban")
            else:
                iban = payload.get("masterIban")
                if not iban:
                    supplier = payload.get("supplier") or {}
                    iban = ns["_capture_supplier_context"](str(supplier.get("addressId") or ""), area).get("latestIban")
            if not ns["_iban_valid"](ns["_norm_iban"](iban)):
                return jsonify(ok=False, error=ERROR), 400
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400

    script = r"""<script>
(() => {
 document.addEventListener('click',event=>{
  if(!event.target.closest?.('#captureSave')||document.getElementById('capturePaymentMethod')?.value!=='transfer')return;
  const accepted=typeof captureAcceptNewIban!=='undefined'&&captureAcceptNewIban;
  const iban=String(document.getElementById(accepted?'captureInvoiceIban':'captureMasterIban')?.value||'').replace(/\s/g,'').toUpperCase();
  if(iban&&captureIbanValid(iban))return;
  event.preventDefault();event.stopImmediatePropagation();
  setCaptureMessage('Bei Überweisung / SEPA ist eine gültige IBAN erforderlich. Lieferanten-IBAN ergänzen oder Rechnungs-IBAN ausdrücklich übernehmen.','error');
  document.getElementById('captureInvoiceIban')?.focus();
 },true);
})();
</script>"""
    ns["MOBILE_PAGE"] = str(ns.get("MOBILE_PAGE") or "").replace("</body>", script + "</body>")
