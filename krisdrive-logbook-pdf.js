"use strict";

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { displayDate, decimal, categoryLabel } = require("./krisdrive-logbook");
const clean = value => String(value ?? "").replace(/[–—]/g, "-").replace(/\u202f/g, " ").replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");

async function createLogbookPdf(data) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Fahrtenbuch ${data.vehicle.label} ${data.range.from} - ${data.range.to}`);
  pdf.setAuthor("Farben Krista");
  const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(.06, .14, .25), muted = rgb(.38, .44, .49), line = rgb(.83, .87, .90);
  const widths = [94, 112, 160, 169, 85, 85, 69];
  const labels = ["Beginn / Ende", "Fahrer / Fahrtart", "Start / Ziel", "Zweck / Kunde / Baustelle", "km Beginn", "km Ende", "Strecke km"];
  const xs = [34]; widths.forEach(width => xs.push(xs.at(-1) + width));
  let page, y, bodyTopY;
  function wrap(value, width, font = regular, size = 8) {
    const words = clean(value).split(/\s+/).filter(Boolean), lines = [];
    let current = "";
    for (let word of words) {
      if (current && font.widthOfTextAtSize(current + " " + word, size) <= width) { current += " " + word; continue; }
      if (current) { lines.push(current); current = ""; }
      while (font.widthOfTextAtSize(word, size) > width) {
        let take = 1;
        while (take < word.length && font.widthOfTextAtSize(word.slice(0, take + 1), size) <= width) take++;
        lines.push(word.slice(0, take)); word = word.slice(take);
      }
      current = word;
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }
  const draw = (value, x, atY, size = 8, font = regular, color = ink) => page.drawText(clean(value), { x, y: atY, font, size, color });
  function addPage() {
    page = pdf.addPage([841.89, 595.28]);
    draw("Fahrtenbuch", 34, 551, 23, bold);
    let headingSize = 11;
    const heading = clean(`${data.vehicle.label}  |  ${data.vehicle.plate}`);
    while (bold.widthOfTextAtSize(heading, headingSize) > 774 && headingSize > 6) headingSize -= .5;
    draw(heading, 34, 529, headingSize, bold);
    draw(`${data.range.from} bis ${data.range.to}  |  Stand ${displayDate(data.generatedAt)} (Wien)`, 34, 511, 8, regular, muted);
    draw(`${data.totals.count} Fahrten  |  Gesamt ${decimal(data.totals.km)} km  |  Geschäftlich ${decimal(data.totals.businessKm)} km  |  Privat ${decimal(data.totals.privateKm)} km  |  Nicht zugeordnet ${decimal(data.totals.unassignedKm)} km`, 34, 493, 9, bold);
    y = 477;
    const notes = ["Kilometerstände: Trackerwerte bzw. erfasste Korrekturen. Privatfahrten ohne Ziel- und Zweckangaben."];
    if (data.totals.open) notes.push(`${data.totals.open} Fahrt(en) mit offenen Ergänzungen${data.totals.missingKm ? `; ${data.totals.missingKm} ohne Kilometerangabe` : ""}.`);
    if (data.warning) notes.push(`${data.warning} Letzter GPS-Abruf: ${displayDate(data.lastSync) || "-"}`);
    for (const note of notes) for (const part of wrap(note, 774, regular, 8)) { draw(part, 34, y, 8, regular, muted); y -= 11; }
    y -= 10;
    page.drawRectangle({ x: 34, y: y - 21, width: 774, height: 24, color: rgb(.92, .95, .97) });
    labels.forEach((label, i) => draw(label, xs[i] + 6, y - 12, 8, bold));
    y -= 28;
    bodyTopY = y;
  }
  addPage();
  if (!data.rows.length) { draw("Keine Fahrten in diesem Zeitraum.", 40, y - 15, 10, regular, muted); }
  for (const row of data.rows) {
    const parts = [
      [displayDate(row.startedAt), displayDate(row.closedAt)],
      [row.driver?.employeeName || "Fahrer offen", categoryLabel(row.category)],
      row.category === "private" ? ["Privatfahrt"] : [`Von: ${row.startLocation || "offen"}${row.inferredStart ? " (aus vorheriger Fahrt)" : ""}`, `Nach: ${row.endLocation || "offen"}${row.inferredEnd ? " (aus naechster Fahrt)" : ""}`],
      [row.category === "private" ? "" : row.purpose, row.missing.length ? `Offen: ${row.missing.join(", ")}` : ""],
      [decimal(row.odometerStartKm) || "-"], [decimal(row.odometerEndKm) || "-"], [decimal(row.distanceKm) || "-"],
    ];
    const cells = parts.map((values, i) => values.filter(Boolean).flatMap(value => wrap(value, widths[i] - 12)));
    const totalLines = Math.max(...cells.map(cell => cell.length));
    const fullHeight = Math.max(39, totalLines * 11 + 14);
    if (y - fullHeight < 50 && y < bodyTopY) addPage();
    let offset = 0;
    while (offset < totalLines) {
      if (y < 90) addPage();
      const count = Math.min(totalLines - offset, Math.floor((y - 50 - 14) / 11));
      cells.forEach((lines, i) => lines.slice(offset, offset + count).forEach((value, j) => draw(value, xs[i] + 6, y - 12 - j * 11, 8, i === 6 ? bold : regular)));
      if (offset > 0 && offset >= cells[0].length) draw("(Fortsetzung)", xs[0] + 6, y - 12, 8, regular, muted);
      y -= Math.max(39, count * 11 + 14);
      page.drawLine({ start: { x: 34, y }, end: { x: 808, y }, thickness: .5, color: line });
      offset += count;
      if (offset < totalLines) addPage();
    }
  }
  pdf.getPages().forEach((sheet, index, pages) => {
    page = sheet;
    page.drawLine({ start: { x: 34, y: 36 }, end: { x: 808, y: 36 }, thickness: .5, color: line });
    draw("Farben Krista  |  KRISDRIVE 1.4", 34, 23, 7, regular, muted);
    const label = `Seite ${index + 1} / ${pages.length}`;
    draw(label, 808 - regular.widthOfTextAtSize(label, 7), 23, 7, regular, muted);
  });
  return Buffer.from(await pdf.save());
}

module.exports = { createLogbookPdf };
