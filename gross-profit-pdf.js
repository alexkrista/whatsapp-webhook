"use strict";

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const clean = value => String(value ?? "")
  .replace(/[–—]/g, "-")
  .replace(/€/g, "EUR")
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
const number = (value, digits = 2) => Number(value || 0).toLocaleString("de-AT", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const money = value => `${number(value)} EUR`;

async function createGrossProfitPdf(data = {}) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize = [841.89, 595.28];
  const left = 34;
  const right = 808;
  const rowHeight = 18;
  const columns = [34, 218, 290, 376, 468, 540, 630, 808];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const totalHours = rows.reduce((sum, row) => sum + Number(row.hours || 0), 0);
  const projectWageRate = totalHours > 0 ? Number(data.wageTotal || 0) / totalHours : 0;
  const projectGkRate = totalHours > 0 ? Number(data.gkTotal || 0) / totalHours : 0;
  const employeePerHour = totalHours > 0 ? Number(data.employeeTotal || 0) / totalHours : 0;
  const materialPerHour = totalHours > 0 ? Number(data.materialEk || 0) / totalHours : 0;
  const grossProfitPerHour = totalHours > 0 ? Number(data.grossProfit || 0) / totalHours : 0;
  const green = rgb(.15, .36, .22);
  const dark = rgb(.12, .16, .13);
  const muted = rgb(.40, .43, .40);
  const line = rgb(.84, .84, .81);
  let page;
  let y;

  const drawRight = (text, boundary, atY, font = regular, size = 8, color = dark) => {
    const label = clean(text);
    const width = font.widthOfTextAtSize(label, size);
    page.drawText(label, { x: Math.max(left, boundary - width - 4), y: atY, size, font, color });
  };
  const drawTableHeader = () => {
    for (let i = 0; i < 7; i++) {
      page.drawRectangle({ x: columns[i], y: y - 4, width: columns[i + 1] - columns[i], height: rowHeight, color: rgb(.91, .93, .90) });
    }
    const labels = ["Mitarbeiter", "Stunden", "Lohn EUR/h", "DN-Lohnkosten", "GK EUR/h", "GK-Kosten", "Gesamtkosten"];
    labels.forEach((label, index) => {
      if (index === 0) page.drawText(label, { x: columns[index] + 4, y: y + 3, size: 8, font: bold, color: dark });
      else drawRight(label, columns[index + 1], y + 3, bold, 8, dark);
    });
    y -= rowHeight;
  };
  const addPage = (showTableHeader = true) => {
    page = pdf.addPage(pageSize);
    y = 556;
    page.drawText("Rohertragsberechnung", { x: left, y, size: 18, font: bold, color: green });
    const jobLine = clean([data.jobId, data.jobName].filter(Boolean).join(" - "));
    if (jobLine) page.drawText(jobLine.slice(0, 125), { x: left, y: y - 22, size: 10, font: bold, color: dark });
    page.drawText(clean(`Stand: ${data.createdAt || new Date().toLocaleString("de-AT")}`), { x: left, y: y - 38, size: 8, font: regular, color: muted });
    y -= 69;
    page.drawText("Stunden x Lohnkostensatz + Stunden x GK-Satz = Mitarbeiter-Gesamtkosten", { x: left, y, size: 9, font: regular, color: dark });
    page.drawText("Lohnsatz = Monatsbrutto x 18 / 1.650; GK-Satz = jaehrliche Gemeinkosten / produktive Jahresstunden.", { x: left, y: y - 14, size: 8, font: regular, color: muted });
    y -= 42;
    if (showTableHeader) drawTableHeader();
  };

  addPage();
  if (!rows.length) {
    page.drawText("Noch keine Mitarbeiterstunden zugeordnet.", { x: left + 4, y: y + 3, size: 9, font: regular, color: muted });
    y -= rowHeight;
  }
  for (const row of rows) {
    if (y < 115) addPage();
    const name = `${clean(row.name || "Unbekannt")}${row.matched === false ? " (Durchschnittssaetze)" : ""}`;
    page.drawText(name.slice(0, 38), { x: columns[0] + 4, y: y + 3, size: 8, font: regular, color: row.matched === false ? rgb(.55, .34, .10) : dark });
    const values = [
      `${number(row.hours, 1)} h`,
      money(row.wageRate),
      money(row.wageCost),
      money(row.gkRate),
      money(row.gkCost),
      money(row.totalCost),
    ];
    values.forEach((value, index) => drawRight(value, columns[index + 2], y + 3, index === 5 ? bold : regular));
    page.drawLine({ start: { x: left, y: y - 4 }, end: { x: right, y: y - 4 }, thickness: .4, color: line });
    y -= rowHeight;
  }

  if (y < 150) addPage(false);
  y -= 5;
  page.drawRectangle({ x: left, y: y - 4, width: right - left, height: rowHeight, color: rgb(.95, .95, .92) });
  page.drawText("Summen / DN-Lohn", { x: left + 4, y: y + 3, size: 9, font: bold, color: dark });
  drawRight(`${number(totalHours, 1)} h`, columns[2], y + 3, bold, 9);
  drawRight(`${number(projectWageRate)} EUR/h`, columns[3], y + 3, bold, 9);
  drawRight(money(data.wageTotal), columns[4], y + 3, bold, 9);
  drawRight(`${number(projectGkRate)} EUR/h`, columns[5], y + 3, bold, 9);
  drawRight(money(data.gkTotal), columns[6], y + 3, bold, 9);
  drawRight(money(data.employeeTotal), columns[7], y + 3, bold, 9);
  y -= 17;
  page.drawText(clean(`Baustellen-Lohnkostensatz: ${money(data.wageTotal)} DN-Lohn / ${number(totalHours, 1)} h = ${number(projectWageRate)} EUR/h`), { x: left + 4, y: y + 3, size: 8, font: regular, color: muted });
  y -= 29;
  const summaryRows = [
    ["Rechnungen netto", data.documentNet],
    ["Mitarbeiter-Gesamtkosten", -Number(data.employeeTotal || 0)],
    ["Material-EK gesamt", -Number(data.materialEk || 0)],
    ["Rohertrag", data.grossProfit],
  ];
  for (const [label, value] of summaryRows) {
    const isTotal = label === "Rohertrag";
    if (isTotal) page.drawRectangle({ x: left, y: y - 5, width: right - left, height: 23, color: rgb(.89, .94, .90) });
    page.drawText(label, { x: left + 4, y: y + 2, size: isTotal ? 11 : 9, font: isTotal ? bold : regular, color: isTotal ? green : dark });
    drawRight(`${Number(value) < 0 ? "- " : ""}${money(Math.abs(Number(value || 0)))}`, right, y + 2, isTotal ? bold : regular, isTotal ? 11 : 9, isTotal ? green : dark);
    y -= isTotal ? 27 : 20;
  }

  if (y < 105) addPage(false);
  y -= 4;
  const tileGap = 8;
  const tileWidth = (right - left - tileGap * 2) / 3;
  const tileHeight = 55;
  const tileData = [
    ["Mitarbeiterkosten je Stunde", employeePerHour, data.employeeTotal, "Lohn + GK"],
    ["Material-EK je Stunde", materialPerHour, data.materialEk, "Materialkosten"],
    ["Rohertrag je Stunde", grossProfitPerHour, data.grossProfit, "Rohertrag"],
  ];
  tileData.forEach(([label, value, numerator, description], index) => {
    const x = left + index * (tileWidth + tileGap);
    page.drawRectangle({ x, y: y - tileHeight, width: tileWidth, height: tileHeight, color: rgb(.94, .97, .94), borderColor: rgb(.80, .87, .81), borderWidth: .7 });
    page.drawText(label, { x: x + 10, y: y - 15, size: 8, font: bold, color: muted });
    page.drawText(clean(`${number(value)} EUR/h`), { x: x + 10, y: y - 34, size: 13, font: bold, color: index === 2 ? green : dark });
    page.drawText(clean(`${description}: ${money(numerator)} / Summe ${number(totalHours, 1)} h`), { x: x + 10, y: y - 48, size: 7, font: regular, color: muted });
  });
  y -= tileHeight + 8;

  const pages = pdf.getPages();
  pages.forEach((current, index) => {
    current.drawLine({ start: { x: left, y: 35 }, end: { x: right, y: 35 }, thickness: .5, color: line });
    current.drawText("Farben Krista - interne Wirtschaftsauswertung", { x: left, y: 21, size: 7, font: regular, color: muted });
    const footer = `Seite ${index + 1} / ${pages.length}`;
    const width = regular.widthOfTextAtSize(footer, 7);
    current.drawText(footer, { x: right - width, y: 21, size: 7, font: regular, color: muted });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { createGrossProfitPdf };
