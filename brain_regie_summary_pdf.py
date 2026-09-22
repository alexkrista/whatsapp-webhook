"""Create the customer-facing Regie summary appendix."""

from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


GREEN = colors.HexColor("#315e3e")
LIGHT_GREEN = colors.HexColor("#eef4ea")
LINE = colors.HexColor("#cfd8ca")
MUTED = colors.HexColor("#66736a")


def _number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _money(value):
    text = f"{_number(value):,.2f}"
    return "EUR " + text.replace(",", "X").replace(".", ",").replace("X", ".")


def _hours(value):
    return (f"{_number(value):.2f}".rstrip("0").rstrip(".").replace(".", ",") + " h")


def _date(value):
    text = str(value or "")[:10]
    parts = text.split("-")
    return ".".join(reversed(parts)) if len(parts) == 3 else text


def _text(value, fallback="-"):
    text = str(value or "").strip()
    return text or fallback


def render_regie_summary_pdf(invoice, destination):
    """Render one concise appendix for a summarized Regie invoice."""
    progress = invoice.get("progressBilling") or {}
    summary = progress.get("regieSummary") or {}
    days = summary.get("days") or []
    if progress.get("regieBillingMode") != "summary" or not days:
        raise ValueError("Für diese Rechnung ist keine Regie-Zusammenfassung hinterlegt.")

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=styles["BodyText"], fontName="Helvetica", fontSize=8.5, leading=11)
    small = ParagraphStyle("small", parent=body, fontSize=7.5, leading=9, textColor=MUTED)
    right = ParagraphStyle("right", parent=body, alignment=TA_RIGHT)
    title = ParagraphStyle("title", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=18, leading=22, textColor=GREEN, spaceAfter=5 * mm)
    heading = ParagraphStyle("heading", parent=body, fontName="Helvetica-Bold", fontSize=10.5, leading=13)

    run = invoice.get("run") or {}
    number = _text(invoice.get("invoice_number"), "Entwurf")
    project = _text(run.get("project_number"), "ohne Projektnummer")
    story = [
        Paragraph("Zusammenfassung Regieleistungen", title),
        Table([
            [Paragraph("Rechnung", small), Paragraph(number, heading), Paragraph("Projekt", small), Paragraph(project, heading)],
            [Paragraph("Leistungszeitraum", small), Paragraph(f"{_date(invoice.get('service_from'))} bis {_date(invoice.get('service_to'))}", body), Paragraph("Baustelle", small), Paragraph(_text(run.get("project_title") or run.get("label")), body)],
        ], colWidths=[31 * mm, 54 * mm, 31 * mm, 64 * mm], style=TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LINEBELOW", (0, -1), (-1, -1), 0.5, LINE),
        ])),
        Spacer(1, 7 * mm),
    ]

    rows = [["Datum", "Rapport", "Arbeiten / Bereich", "Stunden", "Arbeit", "Material", "Gesamt"]]
    total_hours = total_labor = total_material = total = 0.0
    for day in days:
        employees = day.get("employees") or []
        materials = day.get("materials") or []
        hours = _number(day.get("hours")) or sum(_number(row.get("hours")) for row in employees)
        labor = _number(day.get("labor")) or sum(_number(row.get("cost")) for row in employees)
        material = _number(day.get("material")) or sum(_number(row.get("cost")) for row in materials)
        amount = _number(day.get("total")) or labor + material
        total_hours += hours
        total_labor += labor
        total_material += material
        total += amount
        detail = _text(day.get("component"), "Regiearbeiten")
        people = ", ".join(_text(row.get("name"), "Mitarbeiter") for row in employees)
        if people:
            detail += f"<br/><font color='#66736a'>{people}</font>"
        rows.append([
            Paragraph(_date(day.get("date")), body),
            Paragraph(_text(day.get("reportNumber")), body),
            Paragraph(detail, body),
            Paragraph(_hours(hours), right),
            Paragraph(_money(labor), right),
            Paragraph(_money(material), right),
            Paragraph(_money(amount), right),
        ])
    rows.append([
        Paragraph("Gesamt", heading), "", "", Paragraph(_hours(total_hours), right),
        Paragraph(_money(total_labor), right), Paragraph(_money(total_material), right), Paragraph(_money(total), right),
    ])
    widths = [21 * mm, 18 * mm, 50 * mm, 18 * mm, 24 * mm, 24 * mm, 25 * mm]
    table = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 7.5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -2), 0.35, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#f8faf7")]),
        ("SPAN", (0, -1), (2, -1)),
        ("BACKGROUND", (0, -1), (-1, -1), LIGHT_GREEN),
        ("LINEABOVE", (0, -1), (-1, -1), 1, GREEN),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.extend([
        table,
        Spacer(1, 6 * mm),
        Paragraph("Diese Beilage fasst die zur Rechnung gehörenden, freigegebenen Regieberichte zusammen. Die unterschriebenen Originalrapporte bleiben in der Projektakte erhalten.", small),
    ])

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(LINE)
        canvas.line(15 * mm, 12 * mm, 195 * mm, 12 * mm)
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(15 * mm, 8 * mm, f"Regiebeilage zu Rechnung {number} - Projekt {project}")
        canvas.drawRightString(195 * mm, 8 * mm, f"Seite {doc.page}")
        canvas.restoreState()

    document = SimpleDocTemplate(
        str(destination), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=16 * mm, bottomMargin=18 * mm, title=f"Regiebeilage {number}",
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return destination
