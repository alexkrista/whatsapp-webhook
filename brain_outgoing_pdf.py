# coding: utf-8
"""WW-inspired PDF rendering for KRISTINE outgoing invoices."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from xml.sax.saxutils import escape


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


def de_date_long(value):
    text = str(value or "")[:10]
    months = ("", "Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember")
    try:
        stamp = date.fromisoformat(text)
        return f"{stamp.day}. {months[stamp.month]} {stamp.year}"
    except ValueError:
        return text


def _kind_title(invoice):
    kind = invoice.get("kind")
    if kind == "TR":
        previous = [x for x in invoice.get("previousInvoices", []) if x.get("kind") == "TR"]
        return f"{len(previous) + 1}. Abschlagsrechnung"
    return {"SR": "Schlussrechnung", "RE": "Rechnung", "ST": "Stornorechnung", "GS": "Gutschrift"}.get(kind, "Rechnung")


def _single_line(value, limit):
    return " ".join(str(value or "").replace("\r", " ").replace("\n", " ").split())[:limit]


def _epc_payment_payload(invoice, settings, amount=None):
    """Build an EPC069-12 v3.1 SEPA payment payload for an issued invoice."""
    number = _single_line(invoice.get("invoice_number") or invoice.get("invoiceNumber"), 100)
    iban = "".join(str(settings.get("bank_iban") or "").upper().split())
    bic = "".join(str(settings.get("bank_bic") or "").upper().split())
    beneficiary = _single_line(settings.get("company_name"), 70)
    if not number or not beneficiary or not (15 <= len(iban) <= 34) or not iban.isalnum():
        return ""
    if bic and (len(bic) not in {8, 11} or not bic.isalnum()):
        return ""
    if amount is None:
        has_cash_discount = _d(invoice.get("cash_discount_percent")) > 0
        amount = invoice.get("open_with_discount") if has_cash_discount else invoice.get("open_after_discount")
    amount = _d(amount).quantize(Decimal("0.01"))
    if amount < Decimal("0.01") or amount > Decimal("999999999.99"):
        return ""
    remittance = _single_line(f"Rechnung {number}", 140)
    return "\n".join([
        "BCD", "002", "1", "SCT", bic, beneficiary, iban,
        f"EUR{amount:.2f}", "", "", remittance,
    ])


def _payment_qr_drawing(payload, size):
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors

    qr = QrCodeWidget(payload, barLevel="M")
    qr.barWidth = size
    qr.barHeight = size
    drawing = Drawing(size, size)
    drawing.add(qr)
    shield = size * 0.205
    mark = size * 0.165
    drawing.add(Rect(
        (size - shield) / 2, (size - shield) / 2, shield, shield,
        rx=size * 0.025, ry=size * 0.025, fillColor=colors.white, strokeColor=None,
    ))
    drawing.add(Rect(
        (size - mark) / 2, (size - mark) / 2, mark, mark,
        rx=size * 0.02, ry=size * 0.02,
        fillColor=colors.HexColor("#d5bd73"), strokeColor=colors.HexColor("#b79d52"), strokeWidth=0.35,
    ))
    drawing.add(String(
        size / 2, size * 0.445, "K", textAnchor="middle",
        fontName="Helvetica-Bold", fontSize=size * 0.125, fillColor=colors.HexColor("#17211b"),
    ))
    return drawing


def _draw_krista_wordmark(canvas, page_height):
    """Draw only the KRISTA part of the established invoice logo."""
    logo = Path(__file__).resolve().parent / "assets" / "krista_invoice_logo.png"
    if not logo.exists():
        return
    from reportlab.lib.utils import ImageReader

    target_x, target_w = 350.0, 198.0
    crop_left = 0.58
    image = ImageReader(str(logo))
    image_w, image_h = image.getSize()
    full_w = target_w / (1 - crop_left)
    full_h = full_w * image_h / image_w
    target_y = page_height - 114.0
    canvas.saveState()
    clip = canvas.beginPath()
    clip.rect(target_x, target_y, target_w, full_h)
    canvas.clipPath(clip, stroke=0, fill=0)
    canvas.drawImage(
        image, target_x - (crop_left * full_w), target_y,
        width=full_w, height=full_h, preserveAspectRatio=True, mask="auto",
    )
    canvas.restoreState()


def render_invoice_pdf(invoice, settings, destination):
    """Render one immutable invoice snapshot with ReportLab."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_LEFT, TA_RIGHT
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.platypus import (
            BaseDocTemplate, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle,
        )
    except ImportError as exc:
        raise RuntimeError("ReportLab fehlt für die Rechnungserstellung.") from exc

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    width, height = A4
    left, right, top, bottom = 17 * mm, 18 * mm, 100 * mm, 27 * mm
    regular_font, bold_font = "Helvetica", "Helvetica-Bold"
    arial = Path(r"C:\Windows\Fonts\arial.ttf")
    arial_bold = Path(r"C:\Windows\Fonts\arialbd.ttf")
    if arial.exists() and arial_bold.exists():
        try:
            if "KristaArial" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("KristaArial", str(arial)))
            if "KristaArialBold" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("KristaArialBold", str(arial_bold)))
            regular_font, bold_font = "KristaArial", "KristaArialBold"
        except Exception:
            pass
    styles = getSampleStyleSheet()
    base = ParagraphStyle("WW", parent=styles["Normal"], fontName=regular_font, fontSize=9.92, leading=11.9, textColor=colors.black)
    small = ParagraphStyle("WWSmall", parent=base, fontSize=7.9, leading=9.2)
    tiny = ParagraphStyle("WWTiny", parent=base, fontSize=6.84, leading=8.2)
    title = ParagraphStyle("WWTitle", parent=base, fontName=bold_font, fontSize=12.76, leading=15.5)
    right_text = ParagraphStyle("WWRight", parent=base, alignment=TA_RIGHT)
    heading = ParagraphStyle("WWHeading", parent=base, fontName=bold_font, fontSize=9.92, leading=11.9)
    note = ParagraphStyle("WWNote", parent=base, fontSize=9.2, leading=11.2)

    run = invoice.get("run") or {}
    number = invoice.get("invoice_number") or invoice.get("invoiceNumber") or "ENTWURF"
    document_title = _kind_title(invoice)
    project_number = run.get("project_number") or ""
    worker = invoice.get("worker") or settings.get("default_worker") or ""

    def ww_page(canvas, doc):
        canvas.saveState()
        _draw_krista_wordmark(canvas, height)

        customer_names = run.get("customer_name_lines") if isinstance(run.get("customer_name_lines"), list) else [run.get("customer_name") or ""]
        recipient = [
            run.get("customer_company") or "", *customer_names, run.get("customer_street") or "",
            " ".join(x for x in [run.get("customer_postal_code") or "", run.get("customer_city") or ""] if x),
            run.get("customer_country") or "",
        ]
        canvas.setFillColor(colors.black)
        canvas.setFont(regular_font, 9.92)
        y = height - 168
        for line in (x for x in recipient if x):
            canvas.drawString(56.6, y, str(line))
            y -= 11.9
        canvas.setFont(bold_font, 10.8)
        if project_number:
            canvas.drawString(350.0, height - 169, f"Projekt: {project_number}")
        canvas.setFont(regular_font, 9.96)
        canvas.drawString(350.0, height - 184, f"Unser Bearbeiter: {worker}")

        canvas.setFont(regular_font, 7.92)
        bank = (
            f"Hypo Vorarlberg Bank AG  |  IBAN {settings.get('bank_iban','')}  |  BIC {settings.get('bank_bic','')}  |  "
            f"{settings.get('company_uid','')}  |  EORI-Nr.  {settings.get('company_eori','')}  |  DG-Nr.  {settings.get('company_dg','')}"
        )
        canvas.drawString(36.7, 48.0, bank)
        canvas.setFont(regular_font, 6.84)
        canvas.drawString(36.5, 32.5, settings.get("company_name", ""))
        canvas.drawString(168.6, 32.5, f"T {settings.get('company_phone','')}")
        canvas.drawString(249.1, 32.5, settings.get("company_fn", ""))
        canvas.drawString(334.1, 32.5, "Unbeschränkt haftender Gesellschafter: Farben Krista GmbH")
        canvas.drawString(36.5, 22.7, f"{settings.get('company_street','')}  |  {settings.get('company_postal_city','')}")
        canvas.drawString(168.6, 22.7, settings.get("company_email", ""))
        canvas.drawString(249.1, 22.7, settings.get("company_web", ""))
        canvas.drawString(334.1, 22.7, "Feldkircherstraße 45, 6820 Frastanz, FN 77707a, Firmenbuchgericht Feldkirch")
        canvas.restoreState()

    doc = BaseDocTemplate(
        str(destination), pagesize=A4, leftMargin=left, rightMargin=right,
        topMargin=top, bottomMargin=bottom, title=f"{document_title} {number}",
        author=settings.get("company_name", "KRISTINE"), creator="KRISTINE",
    )
    frame = Frame(left, bottom, width - left - right, height - top - bottom, id="normal", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates(PageTemplate(id="ww", frames=[frame], onPage=ww_page))
    story = []
    story.append(Table([
        [Paragraph(document_title, title), Paragraph(de_date_long(invoice.get("issue_date")), right_text)],
        [Paragraph("Nr. :&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;" + str(number), base), ""],
    ], colWidths=[86 * mm, 89 * mm], style=TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 3.5), ("BOTTOMPADDING", (0, 1), (-1, 1), 0),
        ("LINEBELOW", (0, 0), (-1, 0), .65, colors.black),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
    ])))
    if invoice.get("corrects_invoice_id"):
        original = invoice.get("correctedInvoice") or {}
        story.append(Paragraph(
            f"zur Rechnung Nr. {original.get('invoiceNumber','')} vom {de_date(original.get('issueDate'))}", base
        ))
    story.append(Spacer(1, 7))
    subject = str(invoice.get("subject") or "").strip()
    if subject and "aus winworker fortgeführt" not in subject.casefold():
        story.append(Paragraph(subject, heading))
    story.append(Paragraph(
        f"Die Leistung wird zwischen dem {de_date(invoice.get('service_from'))} und dem {de_date(invoice.get('service_to'))} erbracht.", base
    ))
    story.append(Spacer(1, 38))

    line_rows = [["Pos", "Menge", "Einh.", "Leistung", "EP [EUR]", "GP [EUR]"]]
    group_rows = []
    subtotal_rows = []
    section_subtotal_rows = []
    report_net = Decimal("0")
    labor_net = Decimal("0")
    material_raw = Decimal("0")
    material_net = Decimal("0")
    in_material = False
    has_material = False
    visible_position = 0
    report_number = 0
    report_position = 0
    saw_labor = False
    has_section_markers = any(str(row.get("unit") or "").upper() == "MATERIAL" for row in (invoice.get("lines") or []))
    for index, line in enumerate(invoice.get("lines") or [], 1):
        ep = _d(line.get("unit_price" if "unit_price" in line else "unitPrice"))
        quantity = _d(line.get("quantity") or 1)
        raw_total = quantity * ep
        net = _d(line.get("net"))
        desc = str(line.get("description") or "")
        marker = str(line.get("unit") or "").upper()
        if marker in {"TAG", "BAUTEIL", "ARBEIT", "MATERIAL", "SUMME"}:
            if marker == "TAG":
                report_number += 1
                report_position = 0
                report_net = Decimal("0")
                labor_net = Decimal("0")
                material_raw = Decimal("0")
                material_net = Decimal("0")
                in_material = False
                has_material = False
                saw_labor = False
            elif marker == "ARBEIT":
                in_material = False
            elif marker == "MATERIAL":
                work_subtotal_row = len(line_rows)
                line_rows.append(["", "", "", Paragraph("Zwischensumme Arbeit", base), "", money(labor_net)])
                section_subtotal_rows.append(work_subtotal_row)
                in_material = True
                has_material = True
            row_index = len(line_rows)
            if marker == "SUMME":
                disc = _d(line.get("discount_percent" if "discount_percent" in line else "discountPercent"))
                if not has_material:
                    work_subtotal_row = len(line_rows)
                    line_rows.append(["", "", "", Paragraph("Zwischensumme Arbeit", base), "", money(labor_net)])
                    section_subtotal_rows.append(work_subtotal_row)
                if disc and material_raw > material_net:
                    line_rows.append(["", "", "", Paragraph(f"Materialrabatt {percent(disc)}", base), "", money(-(material_raw - material_net))])
                if has_material:
                    material_subtotal_row = len(line_rows)
                    line_rows.append(["", "", "", Paragraph("Zwischensumme Material", base), "", money(material_net)])
                    section_subtotal_rows.append(material_subtotal_row)
                row_index = len(line_rows)
                line_rows.append(["", "", "", Paragraph(f"Summe {report_number}", heading), "", money(report_net)])
            else:
                line_rows.append([str(report_number) if marker == "TAG" else "", "", "", Paragraph(desc, heading if marker in {"TAG", "ARBEIT", "MATERIAL"} else base), "", ""])
            (subtotal_rows if marker == "SUMME" else group_rows).append((row_index, marker))
            continue
        disc = _d(line.get("discount_percent" if "discount_percent" in line else "discountPercent"))
        is_labor = marker in {"STD", "STD.", "H", "H."}
        if not has_section_markers and saw_labor and not is_labor and not in_material:
            work_subtotal_row = len(line_rows)
            line_rows.append(["", "", "", Paragraph("Zwischensumme Arbeit", base), "", money(labor_net)])
            section_subtotal_rows.append(work_subtotal_row)
            material_heading_row = len(line_rows)
            line_rows.append(["", "", "", Paragraph("Material", heading), "", ""])
            group_rows.append((material_heading_row, "MATERIAL"))
            in_material = True
            has_material = True
        if is_labor:
            saw_labor = True
        report_net += net
        if in_material:
            material_raw += raw_total
            material_net += net
        else:
            labor_net += net
        visible_position += 1
        report_position += 1
        line_rows.append([
            f"{report_number}.{report_position}" if report_number else str(visible_position),
            money(quantity), str(line.get("unit") or ""), Paragraph(desc, base),
            money(ep), "" if disc else money(net),
        ])
        if disc:
            discount_amount = raw_total - net
            line_rows.append([
                "", "", "", Paragraph(f"{percent(disc)} Rabatt", small),
                money(-discount_amount), money(net),
            ])
    line_table = Table(line_rows, repeatRows=1, colWidths=[19.5 * mm, 12 * mm, 19 * mm, 82.5 * mm, 21 * mm, 21 * mm])
    line_style = [
        ("FONTNAME", (0, 0), (-1, -1), regular_font),
        ("FONTSIZE", (0, 0), (-1, -1), 9.92), ("LEADING", (0, 0), (-1, -1), 11.9),
        ("ALIGN", (1, 1), (1, -1), "RIGHT"), ("ALIGN", (4, 1), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 20), ("BOTTOMPADDING", (0, 1), (-1, -1), 1),
        ("RIGHTPADDING", (1, 1), (1, -1), 4), ("LEFTPADDING", (2, 1), (2, -1), 3),
        ("RIGHTPADDING", (4, 1), (4, -1), 5), ("LEFTPADDING", (5, 1), (5, -1), 3),
    ]
    for row_index, marker in group_rows:
        line_style.extend([("SPAN", (1, row_index), (2, row_index)), ("SPAN", (3, row_index), (5, row_index)), ("FONTNAME", (0, row_index), (5, row_index), bold_font), ("TOPPADDING", (0, row_index), (5, row_index), 9 if marker == "TAG" else 5), ("BOTTOMPADDING", (0, row_index), (5, row_index), 4)])
    for row_index in section_subtotal_rows:
        line_style.extend([("SPAN", (0, row_index), (2, row_index)), ("FONTNAME", (3, row_index), (5, row_index), bold_font), ("ALIGN", (5, row_index), (5, row_index), "RIGHT"), ("TOPPADDING", (0, row_index), (5, row_index), 3), ("BOTTOMPADDING", (0, row_index), (5, row_index), 4), ("LINEABOVE", (3, row_index), (5, row_index), 0.3, colors.HexColor("#b7b7b7"))])
    for row_index, _marker in subtotal_rows:
        line_style.extend([("SPAN", (0, row_index), (2, row_index)), ("FONTNAME", (3, row_index), (5, row_index), bold_font), ("ALIGN", (5, row_index), (5, row_index), "RIGHT"), ("TOPPADDING", (0, row_index), (5, row_index), 4), ("BOTTOMPADDING", (0, row_index), (5, row_index), 7), ("LINEABOVE", (0, row_index), (5, row_index), 0.5, colors.HexColor("#9aa397"))])
    line_table.setStyle(TableStyle(line_style))
    story.append(line_table)
    complex_summary = bool(
        invoice.get("previousInvoices") or invoice.get("payments")
        or _d(invoice.get("retention_percent")) or _d(invoice.get("cash_discount_percent"))
    )
    story.append(Spacer(1, 0 if complex_summary else 115))

    # The monetary result stays in the same right-hand column as the position total (GP).
    calc = []
    strong_rows = []
    def calc_row(label, rate, amount, strong=False):
        if strong:
            strong_rows.append(len(calc))
        calc.append([
            Paragraph(label, heading if strong else base), "", "", rate,
            money(amount) if amount != "" else "",
        ])
    calc_row("Rechnungszwischensumme Netto:", "", invoice.get("line_subtotal_net"), strong=True)
    if _d(invoice.get("retention_percent")):
        calc_row("Deckungsrücklass:", percent(invoice.get("retention_percent")), -_d(invoice.get("retention_net")))
    if _d(invoice.get("discount_percent")):
        calc_row("Rabatt:", percent(invoice.get("discount_percent")), -_d(invoice.get("discount_net")))
    if _d(invoice.get("retention_percent")) or _d(invoice.get("discount_percent")):
        calc_row("Nettosumme:", "", invoice.get("cumulative_net"), strong=True)
    if _d(invoice.get("vat_rate")):
        calc_row("Mehrwertsteuer:", percent(invoice.get("vat_rate")), invoice.get("cumulative_vat"))
    gross_row = len(calc)
    calc_row("Bruttosumme:", "", invoice.get("cumulative_gross"), strong=True)
    if _d(invoice.get("cash_discount_percent")):
        calc_row("Skonto:", percent(invoice.get("cash_discount_percent")), -_d(invoice.get("cash_discount_gross")))
        calc_row("Brutto mit Skonto:", "", invoice.get("cumulative_gross_discounted"), strong=True)
    calc_style = [
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("FONTNAME", (0, 0), (-1, -1), regular_font),
        ("FONTSIZE", (0, 0), (-1, -1), 9.92), ("LEADING", (0, 0), (-1, -1), 11.9),
        ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("RIGHTPADDING", (4, 0), (4, -1), 0),
        ("LINEABOVE", (0, 0), (-1, 0), .75, colors.black),
        ("LINEABOVE", (0, gross_row), (-1, gross_row), .75, colors.black),
    ]
    calc_style.extend(("FONTNAME", (0, row), (-1, row), bold_font) for row in strong_rows)
    calc_table = Table(calc, colWidths=[80 * mm, 18 * mm, 26 * mm, 26 * mm, 25 * mm], hAlign="RIGHT")
    calc_table.setStyle(TableStyle(calc_style))
    story.append(KeepTogether([calc_table, Spacer(1, 1.5 * mm)]))

    previous = invoice.get("previousInvoices") or []
    if previous and invoice.get("kind") in {"TR", "SR"}:
        rows = [[Paragraph("Übersicht der bisher gestellten Rechnungen:", heading), "", "", "", ""],
                ["Rech.Nr.", "Datum", "Netto", "USt", "Brutto"]]
        for old in previous:
            rows.append([old.get("invoiceNumber") or "", de_date(old.get("issueDate")), money(old.get("net")), money(old.get("vat")), money(old.get("gross"))])
        rows.append(["Summe bisher:", "", money(invoice.get("prior_net")), money(invoice.get("prior_vat")), money(invoice.get("prior_gross"))])
        rows.append(["Zuwachs mit dieser Rechnung:", "", money(invoice.get("increment_net")), money(invoice.get("increment_vat")), money(invoice.get("increment_gross"))])
        rows.append(["Summe:", "", money(invoice.get("cumulative_net")), money(invoice.get("cumulative_vat")), money(invoice.get("cumulative_gross"))])
        t = Table(rows, colWidths=[60 * mm, 27 * mm, 29 * mm, 29 * mm, 30 * mm], repeatRows=2)
        t.setStyle(TableStyle([
            ("SPAN", (0, 0), (-1, 0)), ("FONTNAME", (0, 0), (-1, 1), bold_font),
            ("FONTNAME", (0, 2), (-1, -1), regular_font),
            ("ALIGN", (2, 1), (-1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 8.3),
            ("LINEBELOW", (0, 1), (-1, 1), .4, colors.black),
            ("LINEABOVE", (0, -3), (-1, -3), .4, colors.black),
            ("LINEABOVE", (0, -2), (-1, -2), .4, colors.black),
            ("FONTNAME", (0, -2), (-1, -1), bold_font), ("TOPPADDING", (0, 0), (-1, -1), 1.2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1.2),
        ]))
        story.append(t)
        story.append(Spacer(1, 1.5 * mm))

    payments = invoice.get("payments") or []
    if payments:
        rows = [[Paragraph("Bereits erhaltene Zahlungen Brutto:", heading), "", "", "", ""],
                ["", "Datum", "Netto", "USt", "Brutto"]]
        for index, pay in enumerate(payments, 1):
            label = "In WW verbucht" if str(pay.get("source") or "").upper() == "WW" else (pay.get("reference") or f"{index}. Zahlung")
            rows.append([label, de_date(pay.get("paymentDate")), money(pay.get("net")), money(pay.get("vat")), money(pay.get("gross"))])
        rows.append(["Summe Zahlungen:", "", money(invoice.get("paid_net_snapshot")), money(invoice.get("paid_vat_snapshot")), money(invoice.get("paid_gross_snapshot"))])
        t = Table(rows, colWidths=[60 * mm, 27 * mm, 29 * mm, 29 * mm, 30 * mm], repeatRows=2)
        t.setStyle(TableStyle([
            ("SPAN", (0, 0), (-1, 0)), ("FONTNAME", (0, 0), (-1, 1), bold_font),
            ("FONTNAME", (0, 2), (-1, -1), regular_font),
            ("ALIGN", (2, 1), (-1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 8.3),
            ("LINEBELOW", (0, 1), (-1, 1), .4, colors.black), ("LINEABOVE", (0, -1), (-1, -1), .4, colors.black),
            ("FONTNAME", (0, -1), (-1, -1), bold_font),
            ("TOPPADDING", (0, 0), (-1, -1), 1.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.2),
        ]))
        story.append(t)
        story.append(Spacer(1, 1.5 * mm))

    if invoice.get("kind") not in {"ST", "GS"}:
        due_rows = []
        if _d(invoice.get("cash_discount_percent")):
            due_rows.append([
                f"Offener Betrag mit Skonto bis {de_date(invoice.get('cash_discount_until'))}",
                money(_d(invoice.get("open_with_discount")) / (Decimal("1") + _d(invoice.get("vat_rate")) / Decimal("100"))) if _d(invoice.get("vat_rate")) else money(invoice.get("open_with_discount")),
                money(_d(invoice.get("open_with_discount")) - (_d(invoice.get("open_with_discount")) / (Decimal("1") + _d(invoice.get("vat_rate")) / Decimal("100")))) if _d(invoice.get("vat_rate")) else money(0),
                money(invoice.get("open_with_discount")),
            ])
        due_label = (
            f"Betrag nach der Skontofrist fällig am {de_date(invoice.get('due_date'))}"
            if _d(invoice.get("cash_discount_percent"))
            else f"Betrag fällig am {de_date(invoice.get('due_date'))}"
        )
        due_rows.append([
            due_label,
            money(_d(invoice.get("open_after_discount")) / (Decimal("1") + _d(invoice.get("vat_rate")) / Decimal("100"))) if _d(invoice.get("vat_rate")) else money(invoice.get("open_after_discount")),
            money(_d(invoice.get("open_after_discount")) - (_d(invoice.get("open_after_discount")) / (Decimal("1") + _d(invoice.get("vat_rate")) / Decimal("100")))) if _d(invoice.get("vat_rate")) else money(0),
            money(invoice.get("open_after_discount")),
        ])
        due = Table(due_rows, colWidths=[87 * mm, 29 * mm, 29 * mm, 30 * mm])
        due.setStyle(TableStyle([
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("FONTNAME", (0, 0), (-1, -1), bold_font),
            ("FONTSIZE", (0, 0), (-1, -1), 8.1), ("LINEABOVE", (0, 0), (-1, 0), .75, colors.black),
            ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        story.append(KeepTogether([due, Spacer(1, 1.5 * mm)]))

        full_amount = _d(invoice.get("open_after_discount"))
        has_cash_discount = _d(invoice.get("cash_discount_percent")) > 0
        payment_options = []
        if has_cash_discount:
            payment_options.append((
                f"Mit {percent(invoice.get('cash_discount_percent'))} Skonto",
                _d(invoice.get("open_with_discount")),
                f"zahlbar bis {de_date(invoice.get('cash_discount_until'))}",
            ))
        payment_options.append((
            "Voller Betrag" if has_cash_discount else "Bezahlen per Banking-App",
            full_amount,
            f"fällig am {de_date(invoice.get('due_date'))}",
        ))
        payment_cards = []
        for qr_title, qr_amount, qr_deadline in payment_options:
            qr_payload = _epc_payment_payload(invoice, settings, qr_amount)
            if not qr_payload:
                continue
            qr_copy = [
                Paragraph(qr_title, heading),
                Paragraph(f"Zahlbetrag<br/><b>EUR {money(qr_amount)}</b>", base),
                Paragraph(f"{qr_deadline}<br/>Rechnung {number}", small),
            ]
            card = Table([
                [_payment_qr_drawing(qr_payload, 28 * mm), qr_copy],
            ], colWidths=[31 * mm, 51.5 * mm], hAlign="CENTER")
            card.setStyle(TableStyle([
                ("ALIGN", (0, 0), (0, 0), "CENTER"),
                ("ALIGN", (1, 0), (1, 0), "LEFT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (0, 0), 2),
                ("RIGHTPADDING", (0, 0), (0, 0), 3),
                ("LEFTPADDING", (1, 0), (1, 0), 3),
                ("RIGHTPADDING", (1, 0), (1, 0), 2),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            payment_cards.append(card)
        if payment_cards:
            qr_block = Table([payment_cards], colWidths=[87.5 * mm] * len(payment_cards))
            qr_block.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 2),
                ("RIGHTPADDING", (0, 0), (-1, -1), 2),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("BOX", (0, 0), (-1, -1), .45, colors.HexColor("#b8b8b8")),
                ("INNERGRID", (0, 0), (-1, -1), .35, colors.HexColor("#d0d0d0")),
            ]))
            story.append(KeepTogether([qr_block, Spacer(1, 1.5 * mm)]))

    if invoice.get("tax_note"):
        story.append(Paragraph(invoice.get("tax_note"), heading))
        story.append(Spacer(1, 2 * mm))
    if invoice.get("recipient_uid"):
        story.append(Paragraph(f"Ihre UStIDNr.: {invoice.get('recipient_uid')}", base))
    notes = str(invoice.get("notes") or "").strip()
    if notes.casefold() == "nach tagen sowie räumen/bauteilen gegliedert; alle werte sind bearbeitbar.":
        notes = ""
    if notes:
        story.append(Paragraph(notes.replace("\n", "<br/>"), note))
    if invoice.get("kind") not in {"ST", "GS"}:
        if _d(invoice.get("cash_discount_percent")):
            story.append(Paragraph(
                f"Bei Zahlung bis zum {de_date(invoice.get('cash_discount_until'))} können Sie {percent(invoice.get('cash_discount_percent'))} Skonto abziehen. Danach ist der volle offene Betrag bis zum {de_date(invoice.get('due_date'))} fällig.",
                base,
            ))
        else:
            story.append(Paragraph(f"Bitte zahlen Sie bis zum {de_date(invoice.get('due_date'))} ohne Abzug.", base))

    doc.build(story)
    return destination


def render_dunning_pdf(dunning, settings, destination):
    """Erstellt eine Mahnung im gleichen ruhigen WW-Briefbild wie die Rechnung."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_RIGHT
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle
    except ImportError as exc:
        raise RuntimeError("ReportLab fehlt für die Mahnungserstellung.") from exc

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    width, height = A4
    regular_font, bold_font = "Helvetica", "Helvetica-Bold"
    arial = Path(r"C:\Windows\Fonts\arial.ttf")
    arial_bold = Path(r"C:\Windows\Fonts\arialbd.ttf")
    if arial.exists() and arial_bold.exists():
        try:
            if "KristaArial" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("KristaArial", str(arial)))
            if "KristaArialBold" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("KristaArialBold", str(arial_bold)))
            regular_font, bold_font = "KristaArial", "KristaArialBold"
        except Exception:
            pass

    snapshot = dunning.get("snapshot") or {}
    item = snapshot.get("openItem") or {}
    run = snapshot.get("run") or {}
    invoice = snapshot.get("invoice") or {}
    level = max(1, min(3, int(dunning.get("level") or 1)))
    title_text = f"{level}. Mahnung"
    dunning_date = str(dunning.get("dunning_date") or date.today().isoformat())[:10]
    try:
        requested_date = (date.fromisoformat(dunning_date) + timedelta(days=7)).isoformat()
    except ValueError:
        requested_date = dunning_date

    styles = getSampleStyleSheet()
    base = ParagraphStyle("Dunning", parent=styles["Normal"], fontName=regular_font, fontSize=10, leading=13)
    small = ParagraphStyle("DunningSmall", parent=base, fontSize=7.8, leading=9.2)
    heading = ParagraphStyle("DunningHeading", parent=base, fontName=bold_font, fontSize=12.8, leading=16)
    right = ParagraphStyle("DunningRight", parent=base, alignment=TA_RIGHT)

    def page(canvas, doc):
        canvas.saveState()
        _draw_krista_wordmark(canvas, height)
        customer_names = run.get("customer_name_lines") if isinstance(run.get("customer_name_lines"), list) else [run.get("customer_name") or ""]
        recipient = [
            run.get("customer_company") or "", *customer_names,
            run.get("customer_street") or "",
            " ".join(x for x in [run.get("customer_postal_code") or "", run.get("customer_city") or ""] if x),
            run.get("customer_country") or "",
        ]
        canvas.setFont(regular_font, 9.92)
        y = height - 168
        for line in (x for x in recipient if x):
            canvas.drawString(56.6, y, str(line))
            y -= 11.9
        canvas.setFont(bold_font, 10.8)
        if run.get("project_number"):
            canvas.drawString(350.0, height - 169, f"Projekt: {run.get('project_number')}")
        canvas.setFont(regular_font, 7.92)
        canvas.drawString(
            36.7, 48.0,
            f"Hypo Vorarlberg Bank AG  |  IBAN {settings.get('bank_iban','')}  |  BIC {settings.get('bank_bic','')}  |  {settings.get('company_uid','')}",
        )
        canvas.setFont(regular_font, 6.84)
        canvas.drawString(36.5, 32.5, settings.get("company_name", ""))
        canvas.drawString(168.6, 32.5, f"T {settings.get('company_phone','')}")
        canvas.drawString(249.1, 32.5, settings.get("company_fn", ""))
        canvas.drawString(36.5, 22.7, f"{settings.get('company_street','')}  |  {settings.get('company_postal_city','')}")
        canvas.drawString(168.6, 22.7, settings.get("company_email", ""))
        canvas.drawString(249.1, 22.7, settings.get("company_web", ""))
        canvas.restoreState()

    doc = BaseDocTemplate(
        str(destination), pagesize=A4, leftMargin=17 * mm, rightMargin=18 * mm,
        topMargin=100 * mm, bottomMargin=27 * mm,
        title=f"{title_text} {item.get('invoiceNumber') or ''}",
        author=settings.get("company_name", "KRISTINE"), creator="KRISTINE",
    )
    frame = Frame(17 * mm, 27 * mm, width - 35 * mm, height - 127 * mm, id="normal", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates(PageTemplate(id="ww-dunning", frames=[frame], onPage=page))

    intro = {
        1: "Bei Durchsicht unserer offenen Posten haben wir festgestellt, dass die unten angeführte Rechnung noch nicht ausgeglichen ist.",
        2: "Trotz unserer ersten Mahnung ist die unten angeführte Rechnung weiterhin offen.",
        3: "Trotz unserer bisherigen Mahnungen ist die unten angeführte Rechnung weiterhin offen. Wir ersuchen um unverzügliche Erledigung.",
    }[level]
    story = [
        Table([[Paragraph(title_text, heading), Paragraph(de_date_long(dunning_date), right)]], colWidths=[90 * mm, 85 * mm], style=TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("ALIGN", (1, 0), (1, 0), "RIGHT"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("LINEBELOW", (0, 0), (-1, 0), .65, colors.black),
        ])),
        Spacer(1, 9 * mm),
        Paragraph(intro, base),
        Spacer(1, 7 * mm),
    ]
    rows = [
        ["Rechnungsnummer", "Rechnungsdatum", "Fällig seit", "Offener Betrag"],
        [
            escape(str(item.get("invoiceNumber") or invoice.get("invoice_number") or "")),
            de_date(item.get("issueDate") or invoice.get("issue_date")),
            de_date(item.get("dueDate") or invoice.get("due_date")),
            money(dunning.get("open_gross") or item.get("openGross")) + " EUR",
        ],
    ]
    table = Table(rows, colWidths=[49 * mm, 40 * mm, 40 * mm, 46 * mm])
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), bold_font), ("FONTNAME", (0, 1), (-1, 1), regular_font),
        ("FONTSIZE", (0, 0), (-1, -1), 9.4), ("ALIGN", (3, 0), (3, -1), "RIGHT"),
        ("LINEABOVE", (0, 0), (-1, 0), .6, colors.black), ("LINEBELOW", (0, -1), (-1, -1), .6, colors.black),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (-1, 0), (-1, -1), 0),
    ]))
    story.extend([
        table,
        Spacer(1, 9 * mm),
        Paragraph(
            f"Bitte überweisen Sie den offenen Betrag bis spätestens <b>{de_date(requested_date)}</b> auf unser unten angeführtes Konto. Geben Sie als Zahlungsreferenz die Rechnungsnummer <b>{escape(str(item.get('invoiceNumber') or ''))}</b> an.",
            base,
        ),
        Spacer(1, 6 * mm),
        Paragraph("Sollte Ihre Zahlung inzwischen erfolgt sein, betrachten Sie dieses Schreiben bitte als gegenstandslos.", base),
        Spacer(1, 12 * mm),
        Paragraph("Mit freundlichen Grüßen<br/>Farben Krista GmbH &amp; Co KG", base),
    ])
    doc.build(story)
    return destination
