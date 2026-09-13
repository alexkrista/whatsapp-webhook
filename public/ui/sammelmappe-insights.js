"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SammelmappeInsights = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const num = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
  const amount = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const sum = (rows, key) => rows.reduce((total, row) => total + num(row[key]), 0);
  const list = value => Array.isArray(value) ? value : [];
  const key = value => String(value || "").trim().toLowerCase();

  function reportMaterials(reports) {
    const items = [], missing = [], flat = [];
    let sales = 0, purchase = 0;
    reports.forEach((report, reportIndex) => {
      const materials = list(report.materials), seen = new Set();
      const reportedSales = amount(report.materialCost ?? report.materialTotal);
      const positionSales = sum(materials, "cost");
      sales += reportedSales ?? positionSales;
      if (num(report.materialFlatPercent) > 0) flat.push({ report, reportIndex, percent: num(report.materialFlatPercent) });
      for (const [index, material] of materials.entries()) {
        // A report may have both a WW row and a signed PDF copy. The caller
        // deduplicates reports first; within one report retain distinct lines.
        const identity = material.sourceId ? String(material.sourceId) : String(index);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const quantity = amount(material.quantity), unitPurchase = amount(material.purchaseUnitPrice);
        let purchaseCost = amount(material.purchaseCost);
        if (!(purchaseCost > 0) && unitPurchase > 0 && quantity !== null) purchaseCost = unitPurchase * quantity;
        // Old imports normalize absent EK values to zero. Do not present those
        // as confirmed free material or calculate a fictitious profit from them.
        if (!(purchaseCost > 0) && !(unitPurchase > 0) && (num(quantity) !== 0 || num(material.cost) !== 0 || quantity === null)) purchaseCost = null;
        const item = { ...material, quantity, purchaseCost, jobId: report.jobId, reportIndex, reportNumber: report.reportNumber || report.name, reportDate: report.reportDate };
        items.push(item); purchase += num(purchaseCost);
        if (purchaseCost === null) missing.push(item);
      }
      if ((reportedSales ?? 0) - positionSales > .02) missing.push({ jobId: report.jobId, reportIndex, reportNumber: report.reportNumber, name: "Materialbetrag ohne vollständige Einzelpositionen" });
    });
    return { items, sales, purchase, missing, flat };
  }

  function additionalMaterials(rows, bookings = []) {
    const items = [];
    for (const row of rows) {
      for (const day of list(row.regies)) {
        for (const material of list(day.regie?.materials)) items.push({ ...material, jobId: row.jobId, date: day.day, source: "Tageserfassung" });
        if (String(day.regie?.specialMaterial || "").trim()) items.push({ name: day.regie.specialMaterial, jobId: row.jobId, date: day.day, source: "Materialnotiz" });
      }
      for (const material of list(row.job?.surfaceMaterialMeta).filter(item => item.custom)) items.push({ ...material, jobId: row.jobId, source: "Manuell in der Akte" });
    }
    for (const row of bookings) items.push({
      name: [row.product, row.colourTone && key(row.colourTone) !== "ungemischt" ? row.colourTone : ""].filter(Boolean).join(" · "),
      quantity: num(row.liters) > 0 ? row.liters : row.quantity, unit: num(row.liters) > 0 ? "l" : "Stk",
      jobId: row.jobId, date: row.mixedAt || row.at, source: row.source === "innovatint-history" ? "Mischmaschine" : "Lager → Baustelle",
      note: [row.component, row.baseName, row.size, row.knowledgeOnly ? "Altbestand / Farbwissen" : ""].filter(Boolean).join(" · ")
    });
    return items;
  }

  function monthlyHours(personDays, total, target) {
    const byMonth = new Map();
    let first = "", last = "";
    for (const row of personDays) {
      const date = String(row.date || "").slice(0, 10);
      if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date) || num(row.hours) <= 0) continue;
      if (!first || date < first) first = date;
      if (!last || date > last) last = date;
      const month = date.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) || 0) + num(row.hours));
    }
    const months = [];
    if (first) {
      let year = Number(first.slice(0, 4)), month = Number(first.slice(5, 7));
      const endYear = Number(last.slice(0, 4)), endMonth = Number(last.slice(5, 7));
      while (year < endYear || year === endYear && month <= endMonth) {
        const id = `${year}-${String(month).padStart(2, "0")}`;
        months.push({ month: id, hours: byMonth.get(id) || 0 });
        month++; if (month === 13) { year++; month = 1; }
      }
    }
    const dated = sum(months, "hours"), difference = num(total) - dated;
    const consistent = difference >= -.02, unassigned = consistent ? Math.max(0, difference) : 0;
    let cumulative = 0;
    for (const row of months) { cumulative += row.hours; row.cumulative = cumulative; row.balance = num(target) - cumulative; }
    return { months, first, last, dated, total: num(total), target: num(target), unassigned, consistent, balance: num(target) - num(total) };
  }

  function issuedInvoices(invoices) {
    const latest = new Map();
    for (const [index, invoice] of invoices.entries()) {
      if (invoice.status !== "issued") continue;
      const identity = invoice.invoiceNumber ? `${invoice.projectNumber || invoice.jobId}|${invoice.invoiceNumber}` : `${invoice.source || ""}|${invoice.sourceId || invoice.id || index}`;
      const previous = latest.get(identity);
      const stamp = row => String(row.changedAt || row.updatedAt || row.issueDate || "");
      if (!previous || stamp(invoice) > stamp(previous) || stamp(invoice) === stamp(previous) && num(invoice.id) >= num(previous.id)) latest.set(identity, invoice);
    }
    return [...latest.values()];
  }

  function economy(data, snapshot, cost, material, ready) {
    const invoices = issuedInvoices(list(data.billing?.invoices)), revenue = sum(invoices, "net");
    const full = !!ready && !!snapshot.complete && !data.billing?.partial && data.rows.every(row => !row.errors.length);
    const actual = num(snapshot.total), fixedMaterial = data.rows.reduce((total, row) => total + num(row.job?.calculation?.materialAmount) * .6, 0);
    const materialEk = fixedMaterial + material.purchase;
    const hoursCovered = Math.abs(num(cost?.totalHours) - actual) <= .02;
    const costsComplete = !!cost?.ratesAvailable && hoursCovered && material.missing.length === 0 && material.flat.length === 0;
    const profit = full && costsComplete ? revenue - cost.total - materialEk : null;
    return { revenue, actual, full, fixedMaterial, materialEk, costsComplete, hoursCovered, profit,
      revenuePerHour: full && actual > 0 ? revenue / actual : null,
      profitPerHour: profit !== null && actual > 0 ? profit / actual : null,
      estimated: fixedMaterial > 0 || list(cost?.rows).some(row => !row.matched),
      unassignedHours: Math.max(0, actual - num(cost?.totalHours)) };
  }
  return { reportMaterials, additionalMaterials, monthlyHours, issuedInvoices, economy };
});
