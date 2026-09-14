"""Validate a reviewed KRISTINE proposal and prepare cumulative invoice lines."""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json


def money(value):
    try:
        result = Decimal(str(value))
        if not result.is_finite() or abs(result) > Decimal("1000000000"):
            raise ValueError("Betrag ist nicht plausibel.")
        return result.quantize(Decimal(".01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError):
        raise ValueError("Betrag ist nicht gültig.") from None


def invoice_snapshot(invoices):
    return sorted([
        [str(i.get("source_id") or ""), str(i.get("invoice_number") or ""),
         str(i.get("kind") or "").upper(), float(money(i.get("increment_net") or 0))]
        for i in invoices if i.get("status") == "issued"
    ], key=lambda row: json.dumps(row, ensure_ascii=False))


def check_snapshot(proposal, invoices):
    expected = (proposal.get("baseline") or {}).get("invoiceSnapshot")
    if not isinstance(expected, list):
        raise ValueError("Rechnungsstand fehlt. Den Vorschlag in der Akte neu öffnen.")
    normalize = lambda rows: sorted(json.dumps(row, ensure_ascii=False) for row in rows)
    # JSON represents 100 and 100.0 differently; compare normalized monetary values.
    wanted = [[str(x[0]), str(x[1]), str(x[2]), float(money(x[3]))] for x in expected]
    if normalize(wanted) != normalize(invoice_snapshot(invoices)):
        raise ValueError("Der Rechnungsstand hat sich geändert. Den Vorschlag in der Akte neu laden.")


def prepare_preset(proposal, run, invoices):
    if not isinstance(proposal, dict) or len(json.dumps(proposal)) > 60000:
        raise ValueError("Abrechnungsvorschlag ist ungültig.")
    if str(proposal.get("jobId") or "") != str(run.get("project_number") or ""):
        raise ValueError("Vorschlag und Baustelle stimmen nicht überein.")
    if run.get("status") != "open":
        raise ValueError("Dieser Rechnungslauf ist abgeschlossen.")
    check_snapshot(proposal, invoices)
    baseline = proposal.get("baseline") or {}
    kind = str(proposal.get("kind") or "")
    if kind not in {"TR", "SR"} or not baseline.get("complete") or baseline.get("hasClosingInvoice"):
        raise ValueError("Kein vollständiger, offener TR-/SR-Vorschlag.")
    percent = Decimal("100") if kind == "SR" else Decimal(str(proposal.get("completionPercent")))
    if not percent.is_finite() or not 0 <= percent <= 100:
        raise ValueError("Fertigstellung muss zwischen 0 und 100 % liegen.")
    fixed = money(money(baseline.get("fixedContractAmount")) * percent / 100) - money(baseline.get("fixedPartialInvoiceNet"))
    regie = money(proposal.get("regieToInvoice"))
    if min(fixed, regie) < 0 or (kind == "TR" and fixed + regie <= 0):
        raise ValueError("Der neue Rechnungsbetrag ist nicht plausibel.")
    if money(proposal.get("amountToInvoice")) != money(fixed + regie):
        raise ValueError("Beträge im Vorschlag sind nicht konsistent.")
    prior = sum((money(i.get("increment_net") or 0) for i in invoices
                 if i.get("status") == "issued" and i.get("kind") in {"TR", "SR", "RE"}
                 and int(i.get("run_id") or 0) == int(run["id"])), Decimal("0"))
    lines = []
    for component, description, net in [
        ("prior", "Bisher geschriebener Leistungsstand dieses Rechnungslaufs", prior),
        ("fixed", f"Fixauftrag · {percent.normalize()} % Fertigstellung · zusätzlicher Leistungsstand", fixed),
        ("regie", "Regieleistungen · jetzt abzurechnen", regie),
    ]:
        if net:
            lines.append({"description": description, "quantity": 1, "unit": "PA",
                          "unitPrice": float(net), "discountPercent": 0, "billingComponent": component})
    if not lines:
        raise ValueError("Es ist noch keine Leistung zum Abrechnen vorhanden.")
    return {"kind": kind, "lines": lines, "progressBilling": proposal,
            "incrementNet": float(money(fixed + regie)), "cumulativeNet": float(money(prior + fixed + regie))}
