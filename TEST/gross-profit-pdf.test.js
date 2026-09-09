"use strict";

const assert = require("assert");
const fs = require("fs");
const { PDFDocument } = require("pdf-lib");
const { createGrossProfitPdf } = require("../gross-profit-pdf");

(async () => {
  const rows = [
    { name: "Edmund Mock", hours: 60.6, wageRate: 34.2, wageCost: 2072.52, gkRate: 22.7, gkCost: 1375.62, totalCost: 3448.14, matched: true },
    { name: "Cathrin Anna Grabherr", hours: 41.7, wageRate: 29.4, wageCost: 1225.98, gkRate: 22.7, gkCost: 946.59, totalCost: 2172.57, matched: true },
    { name: "Max Krista", hours: 5.4, wageRate: 30.1, wageCost: 162.54, gkRate: 22.7, gkCost: 122.58, totalCost: 285.12, matched: false },
  ];
  const wageTotal = rows.reduce((sum, row) => sum + row.wageCost, 0);
  const gkTotal = rows.reduce((sum, row) => sum + row.gkCost, 0);
  const employeeTotal = wageTotal + gkTotal;
  const documentNet = 16487.84;
  const materialEk = 1161.59;
  const bytes = await createGrossProfitPdf({ jobId: "260510", jobName: "Fink Loos M3", createdAt: "09.09.2026, 18:30", rows, wageTotal, gkTotal, employeeTotal, documentNet, materialEk, grossProfit: documentNet - employeeTotal - materialEk });
  assert.ok(Buffer.isBuffer(bytes));
  assert.ok(bytes.length > 1500);
  const pdf = await PDFDocument.load(bytes);
  assert.strictEqual(pdf.getPageCount(), 1);
  const source = fs.readFileSync(require.resolve("../gross-profit-pdf"), "utf8");
  assert.match(source, /DN-Lohnkosten/);
  assert.match(source, /Baustellen-Lohnkostensatz/);
  assert.match(source, /projectWageRate/);
  assert.match(source, /Mitarbeiterkosten je Stunde/);
  assert.match(source, /Material-EK je Stunde/);
  assert.match(source, /Nachkalkulation/);
  assert.match(source, /Ertrag je Stunde/);
  assert.match(source, /grossProfitPerHour/);
  assert.doesNotMatch(source, /Rohertrag/);
  console.log("gross profit PDF tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
