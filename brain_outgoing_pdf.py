# coding: utf-8
"""WW-inspired PDF rendering for KRISTINE outgoing invoices."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path


def _d(value):
    return Decimal(str(value or 0))


def money(value):
    value = _d(value).quantize(Decimal("0.01"))
    sign = "-" if value < 0 else ""
    raw = f"{abs(value):,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")
    return f"{sign}{raw}"


def percent(value):
    raw = f"{_d(value).normalize():f}".replace(".", ",")
    return raw + " %"


def de_date(value):
    text = str(value or "")[:10]
    try:
        return date.fromisoformat(text).strftime("%d.%m.%Y")
    except ValueError:
        return text


def _kind_title(invoice):
    kind = invoice.get("kind")
    if kind == "TR":
        previous = [x for x in invoice.get("previousInvoices", []) if x.get("kind") == "TR"]
        return f"{len(previous) + 1}. Abschlagsrechnung"
    return {"SR": "Schlussrechnung", "RE": "Rechnung", "ST": "Stornorechnung", "GS": "Gutschrift"}.get(kind, "Rechnung")


def render_invoice_pdf(invoice, settings, destination):
    """Render one immutable invoice snapshot with ReportLab."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_LEFT, TA_RIGHT
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            BaseDocTemplate, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle,
        )
    except ImportError as exc:
        raise RuntimeError("ReportLab fehlt für die Rechnungserstellung.") from exc

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    width, height = A4
    left, right, top, bottom = 18 * mm, 16 * mm, 22 * mm, 25 * mm
    styles = getSampleStyleSheet()
    base = ParagraphStyle("WW", parent=styles["Normal"], fontName="Helvetica", fontSize=8.4, leading=10.6, textColor=colors.black)
    small = ParagraphStyle("WWSmall", parent=base, fontSize=7.2, leading=8.8)
    tiny = ParagraphStyle("WWTiny", parent=base, fontSize=6.5, leading=7.8)
    title = ParagraphStyle("WWTitle", parent=base, fontName="Helvetica-Bold", fontSize=14, leading=17)
    right_text = ParagraphStyle("WWRight", parent=base, alignment=TA_RIGHT)
    heading = ParagraphStyle("WWHeading", parent=base, fontName="Helvetica-Bold", fontSize=8.5, leading=10.5)
    note = ParagraphStyle("WWNote", parent=base, fontSize=8, leading=10)

    run = invoice.get("run") or {}
    number = invoice.get("invoice_number") or invoice.get("invoiceNumber") or "ENTWURF"
    document_title = _kind_title(invoice)
    project_number = run.get("project_number") or ""
    worker = invoice.get("worker") or settings.get("default_worker") or ""

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 6.5)
        strip = (
            f"{settings.get('company_name','')}  |  IBAN {settings.get('bank_iban','')}  |  "
            f"BIC {settings.get('bank_bic','')}  |  {settings.get('company_uid','')}  |  "
            f"EORI-Nr. {settings.get('company_eori','')}  |  DG-Nr. {settings.get('company_dg','')}"
        )
        canvas.drawString(left, 17 * mm, strip[:180])
        canvas.setFont("Helvetica-Bold", 7)
        canvas.drawString(left, 12.5 * mm, settings.get("company_name", ""))
        canvas.setFont("Helvetica", 6.5)
        canvas.drawString(left, 9.5 * mm, (
            f"{settings.get('company_street','')} | {settings.get('company_postal_city','')} | "
            f"T {settings.get('company_phone','')} | {settings.get('company_email','')} | {settings.get('company_web','')}"
        )[:180])
        canvas.drawString(left, 6.5 * mm, settings.get("company_legal", "")[:190])
        canvas.drawRightString(width - right, 12.5 * mm, f"[{document_title} {number}]  - {doc.page:02d} -")
        canvas.restoreState()

    doc = BaseDocTemplate(
        str(destination), pagesize=A4, leftMargin=left, rightMargin=right,
        topMargin=top, bottomMargin=bottom, title=f"{document_title} {number}",
        author=settings.get("company_name", "KRISTINE"), creator="KRISTINE",
    )
    frame = Frame(left, bottom, width - left - right, height - top - bottom, id="normal")
    doc.addPageTemplates(PageTemplate(id="ww", frames=[frame], onPage=footer))
    story = []

    story.append(Table([
        [Paragraph(f"Unser Bearbeiter: {worker}<br/>Projekt: {project_number}", small),
         Paragraph(f"{settings.get('company_name','')}<br/>T {settings.get('company_phone','')}<br/>{settings.get('company_email','')}", right_text)],
    ], colWidths=[100 * mm, 76 * mm], style=TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ])))
    story.append(Spacer(1, 11 * mm))
    recipient = [run.get("customer_company") or "", run.get("customer_name") or "", run.get("customer_street") or "",
                 " ".join(x for x in [run.get("customer_postal_code") or "", run.get("customer_city") or ""] if x),
                 run.get("customer_country") or ""]
    story.append(Paragraph("<br/>".join(x for x in recipient if x), base))
    story.append(Spacer(1, 8 * mm))
    story.append(Table([
        [Paragraph(document_title, title), Paragraph("Nr. :", right_text), Paragraph(str(number), heading)],
        [Paragraph(invoice.get("subject") or "", base), "", Paragraph(de_date(invoice.get("issue_date")), base)],
    ], colWidths=[112 * mm, 18 * mm, 46 * mm], style=TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ])))
    if invoice.get("corrects_invoice_id"):
        original = invoice.get("correctedInvoice") or {}
        story.append(Paragraph(
            f"zur Rechnung Nr. {original.get('invoiceNumber','')} vom {de_date(original.get('issueDate'))}", base
        ))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph(
        f"Die Leistung wurde zwischen dem {de_date(invoice.get('service_from'))} und dem {de_date(invoice.get('service_to'))} erbracht.", base
    ))
    story.append(Spacer(1, 4 * mm))

    line_rows = [[Paragraph("Pos", heading), Paragraph("Menge", heading), Paragraph("Einh.", heading),
                  Paragraph("Leistung", heading), Paragraph("EP [EUR]", heading), Paragraph("GP [EUR]", heading)]]
    for index, line in enumerate(invoice.get("lines") or [], 1):
        ep = _d(line.get("unit_price" if "unit_price" in line else "unitPrice"))
        net = _d(line.get("net"))
        desc = str(line.get("description") or "")
        disc = _d(line.get("discount_percent" if "discount_percent" in line else "discountPercent"))
        if disc:
            desc += f"<br/><font size=6.5>Positionsrabatt {percent(disc)}</font>"
        line_rows.append([
            str(line.get("line_no") or line.get("lineNo") or index),
            money(line.get("quantity") or 1), str(line.get("unit") or ""), Paragraph(desc, base),
            money(ep), money(net),
        ])
    line_table = Table(line_rows, repeatRows=1, colWidths=[10 * mm, 20 * mm, 14 * mm, 82 * mm, 24 * mm, 26 * mm])
    line_table.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), .65, colors.black), ("LINEBELOW", (0, -1), (-1, -1), .35, colors.black),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5), ("LEADING", (0, 0), (-1, -1), 9.5),
        ("ALIGN", (1, 1), (1, -1), "RIGHT"), ("ALIGN", (4, 1), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(line_table)
    story.append(Spacer(1, 3 * mm))

    # Requested calculation summary: retention, discount, VAT, cash discount, then payments.
    calc = []
    def calc_row(label, rate, net, vat="", gross="", strong=False):
        calc.append([Paragraph(label, heading if strong else base), rate, money(net) if net != "" else "",
                     money(vat) if vat != "" else "", money(gross) if gross != "" else ""])
    calc_row("Rechnungszwischensumme Netto:", "", invoice.get("line_subtotal_net"), strong=True)
    if _d(invoice.get("retention_percent")):
        calc_row("Deckungsrücklass:", percent(invoice.get("retention_percent")), -_d(invoice.get("retention_net")))
        calc_row("", "", invoice.get("net_after_retention"), strong=True)
    if _d(invoice.get("discount_percent")):
        calc_row("Rabatt:", percent(invoice.get("discount_percent")), -_d(invoice.get("discount_net")))
        calc_row("", "", invoice.get("cumulative_net"), strong=True)
    else:
        calc_row("Nettosumme:", "", invoice.get("cumulative_net"), strong=True)
    if _d(invoice.get("vat_rate")):
        calc_row("Mehrwertsteuer:", percent(invoice.get("vat_rate")), "", invoice.get("cumulative_vat"))
    calc_row("Bruttosumme:", "", "", "", invoice.get("cumulative_gross"), strong=True)
    if _d(invoice.get("cash_discount_percent")):
        calc_row("Skonto:", percent(invoice.get("cash_discount_percent")), "", "", -_d(invoice.get("cash_discount_gross")))
        calc_row("Brutto mit Skonto:", "", "", "", invoice.get("cumulative_gross_discounted"), strong=True)
    calc_table = Table(calc, colWidths=[72 * mm, 19 * mm, 28 * mm, 28 * mm, 29 * mm], hAlign="RIGHT")
    calc_table.setStyle(TableStyle([
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 8.2),
        ("TOPPADDING", (0, 0), (-1, -1), 1.7), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.7),
        ("LINEABOVE", (2, 0), (-1, 0), .45, colors.black),
    ]))
    story.append(KeepTogether([calc_table, Spacer(1, 3 * mm)]))

    previous = invoice.get("previousInvoices") or []
    if previous and invoice.get("kind") in {"TR", "SR"}:
        rows = [[Paragraph("Übersicht der bisher gestellten Rechnungen:", heading), "", "", "", ""],
                ["Rech.Nr.", "Datum", "Netto", "USt", "Brutto"]]
        for old in previous:
            rows.append([old.get("invoiceNumber") or "", de_date(old.get("issueDate")), money(old.get("net")), money(old.get("vat")), money(old.get("gross"))])
        rows.append(["Summe bisher:", "", money(invoice.get("prior_net")), money(invoice.get("prior_vat")), money(invoice.get("prior_gross"))])
        rows.append(["Zuwachs mit dieser Rechnung:", "", money(invoice.get("increment_net")), money(invoice.get("increment_vat")), money(invoice.get("increment_gross"))])
        rows.append(["Summe:", "", money(invoice.get("cumulative_net")), money(invoice.get("cumulative_vat")), money(invoice.get("cumulative_gross"))])
        t = Table(rows, colWidths=[61 * mm, 27 * mm, 29 * mm, 29 * mm, 30 * mm], repeatRows=2)
        t.setStyle(TableStyle([
            ("SPAN", (0, 0), (-1, 0)), ("FONTNAME", (0, 0), (-1, 1), "Helvetica-Bold"),
            ("ALIGN", (2, 1), (-1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("LINEBELOW", (0, 1), (-1, 1), .4, colors.black), ("LINEABOVE", (0, -2), (-1, -2), .4, colors.black),
            ("FONTNAME", (0, -2), (-1, -1), "Helvetica-Bold"), ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        story.append(t)
        story.append(Spacer(1, 3 * mm))

    payments = invoice.get("payments") or []
    if payments:
        rows = [[Paragraph("Bereits erhaltene Zahlungen Brutto:", heading), "", "", "", ""],
                ["", "Datum", "Netto", "USt", "Brutto"]]
        for index, pay in enumerate(payments, 1):
            label = pay.get("reference") or f"{index}. Zahlung"
            rows.append([label, de_date(pay.get("paymentDate")), money(pay.get("net")), money(pay.get("vat")), money(pay.get("gross"))])
        rows.append(["Summe Zahlungen:", "", money(invoice.get("paid_net_snapshot")), money(invoice.get("paid_vat_snapshot")), money(invoice.get("paid_gross_snapshot"))])
        t = Table(rows, colWidths=[61 * mm, 27 * mm, 29 * mm, 29 * mm, 30 * mm], repeatRows=2)
        t.setStyle(TableStyle([
            ("SPAN", (0, 0), (-1, 0)), ("FONTNAME", (0, 0), (-1, 1), "Helvetica-Bold"),
            ("ALIGN", (2, 1), (-1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("LINEBELOW", (0, 1), (-1, 1), .4, colors.black), ("LINEABOVE", (0, -1), (-1, -1), .4, colors.black),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        story.append(t)
        story.append(Spacer(1, 3 * mm))

    if invoice.get("kind") not in {"ST", "GS"}:
        due_rows = []
        if _d(invoice.get("cash_discount_percent")):
            due_rows.append([
                f"Offener Betrag mit Skonto bis {de_date(invoice.get('cash_discount_until'))}",
                money(_d(invoice.get("open_with_discount")) / (Decimal("1") + _d(invoice.get("vat_rate")) / Decimal("100"))) if _d(invoice.get("vat_rate")) else money(invoice.get("open_with_discount")),
                money(_d(invoice.get("open_with_discount")) - (_d(invoice.get("open_with_discount")) / (Decimal("1") + _d(invoice.get("vat_rate")) / Decimal("100")))) if _d(invoice.get("vat_rate")) else money(0),
                money(invoice.get("open_with_discount")),
            ])
        due_rows.append([
            f"Betrag nach der Skontofrist fällig bis {de_date(invoice.get('due_date'))}",
            money(_d(invoice.get("open_after_discount")) / (Decimal("1") + _d(invoice.get("vat_rate")) / Decimal("100"))) if _d(invoice.get("vat_rate")) else money(invoice.get("open_after_discount")),
            money(_d(invoice.get("open_after_discount")) - (_d(invoice.get("open_after_discount")) / (Decimal("1") + _d(invoice.get("vat_rate")) / Decimal("100")))) if _d(invoice.get("vat_rate")) else money(0),
            money(invoice.get("open_after_discount")),
        ])
        due = Table(due_rows, colWidths=[88 * mm, 29 * mm, 29 * mm, 30 * mm])
        due.setStyle(TableStyle([
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8.1), ("LINEABOVE", (0, 0), (-1, 0), .75, colors.black),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(KeepTogether([due, Spacer(1, 3 * mm)]))

    if invoice.get("tax_note"):
        story.append(Paragraph(invoice.get("tax_note"), heading))
        story.append(Spacer(1, 2 * mm))
    if invoice.get("recipient_uid"):
        story.append(Paragraph(f"Ihre UStIDNr.: {invoice.get('recipient_uid')}", base))
    if invoice.get("notes"):
        story.append(Paragraph(str(invoice.get("notes")).replace("\n", "<br/>"), note))
    if invoice.get("kind") not in {"ST", "GS"}:
        story.append(Paragraph(f"Bitte zahlen Sie bis zum {de_date(invoice.get('due_date'))} ohne Abzug.", base))

    doc.build(story)
    return destination

