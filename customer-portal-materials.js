"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { dedupeReports } = require("./public/ui/regie-billing-state");
const { mapLimit } = require("./public/ui/baustellen-data");
const list = value => Array.isArray(value) ? value : [];
const clean = (value, max = 250) => String(value ?? "").trim().slice(0, max);
const lower = value => clean(value).toLocaleLowerCase("de-AT");
const surfaceKey = (name, unit) => `${lower(name)}|${lower(unit)}`;
const quantity = value => {
  if (value === null || value === undefined || clean(value) === "") return null;
  const text = clean(value).replace(/[\s\u00a0]/g, "");
  const number = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
  return Number.isFinite(number) ? number : null;
};

// Read the same durable sources as the internal project file. This never calls
// an admin HTTP endpoint or returns the global material ledger to the customer.
async function readMaterialSources({ dataDir, jobIds, canonicalId = id => id, listDaysForJob, regiePathForDay }) {
  const allowed = new Set(jobIds), bookings = new Map(jobIds.map(id => [id, []]));
  const days = new Map(jobIds.map(id => [id, []])), unavailable = [];
  try {
    let contents = "";
    try { contents = await fs.readFile(path.join(dataDir, "_kristine/paint/job-materials.jsonl"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const seen = new Set();
    for (const line of contents.split(/\r?\n/).filter(line => line.trim())) {
      let row;
      try { row = JSON.parse(line); } catch { unavailable.push({ source: "Materialbuchungen" }); continue; }
      const jobId = canonicalId(String(row?.jobId || ""));
      if (!allowed.has(jobId)) continue;
      const id = row.id ? `${jobId}|${row.id}` : `${jobId}|${line}`;
      if (seen.has(id)) continue;
      seen.add(id); bookings.get(jobId).push(row);
    }
  } catch { unavailable.push({ source: "Materialbuchungen" }); }
  const results = await mapLimit(jobIds, 4, async jobId => {
    if (!listDaysForJob || !regiePathForDay) return;
    const dates = [...new Set(await listDaysForJob(jobId))];
    const loaded = await mapLimit(dates, 4, async day => {
      try {
        const regie = JSON.parse(await fs.readFile(regiePathForDay(jobId, day), "utf8"));
        return { day, regie };
      } catch (error) { if (error.code !== "ENOENT") throw error; return null; }
    });
    days.set(jobId, loaded.flatMap(row => row.status === "fulfilled" && row.value ? [row.value] : []));
    if (loaded.some(row => row.status === "rejected")) unavailable.push({ jobId, source: "Tageserfassungen" });
  });
  results.forEach((row, index) => { if (row.status === "rejected") unavailable.push({ jobId: jobIds[index], source: "Tageserfassungen" }); });
  return { bookings, days, unavailable };
}

function collectCustomerMaterials({ jobId, metaRows = [], documents = [], days = [], bookings = [] }) {
  const metadata = new Map(list(metaRows).map(row => [String(row?.key || ""), row]));
  const materials = new Map(), seen = new Set(), usedMetadata = new Set();
  function add(material, evidence, metadataKey, colourTone = "") {
    const name = clean(material?.name), unit = clean(material?.unit, 30);
    if (!name || seen.has(evidence.id)) return;
    seen.add(evidence.id);
    const key = metadataKey || surfaceKey(name, unit), saved = metadata.get(key) || {};
    usedMetadata.add(key);
    const use = clean(saved.use || material.use), grouping = `${surfaceKey(name, unit)}|${lower(use)}`;
    let item = materials.get(grouping);
    if (!item) {
      item = { jobId, name, unit, use, colourTone: clean(colourTone), category: clean(saved.category), sources: [] };
      materials.set(grouping, item);
    }
    // Quantities are evidence per source, never a sum of stock and consumption.
    item.sources.push({ source: evidence.source, reference: clean(evidence.reference, 120), date: clean(evidence.date, 10), quantity: quantity(material.quantity), unit });
  }
  for (const [reportIndex, report] of dedupeReports(list(documents).filter(row => row?.type === "regie_report")).entries()) {
    for (const [index, material] of list(report.materials).entries()) add(material, {
      id: `report:${reportIndex}:${material.sourceId || index}`, source: "Regiebericht",
      reference: report.reportNumber || report.name, date: report.reportDate,
    });
  }
  for (const day of list(days)) {
    for (const [index, material] of list(day.regie?.materials).entries()) add(material, { id: `day:${day.day}:${index}`, source: "Tageserfassung", date: day.day });
    if (clean(day.regie?.specialMaterial)) add({ name: day.regie.specialMaterial }, { id: `day:${day.day}:special`, source: "Materialangabe im Tagesbericht", date: day.day });
  }
  for (const [index, booking] of list(bookings).entries()) {
    const tone = lower(booking.colourTone) === "ungemischt" ? "" : clean(booking.colourTone);
    const product = clean(booking.product);
    if (!product) continue;
    const name = [product, tone].filter(Boolean).join(" · "), liters = quantity(booking.liters), unit = liters > 0 ? "l" : "Stk", use = clean(booking.component);
    add({ name, quantity: liters > 0 ? liters : booking.quantity, unit, use }, {
      id: `booking:${booking.id || index}`,
      source: booking.knowledgeOnly ? "Farbton aus Altbestand" : booking.source === "innovatint-history" ? "Mischmaschine" : "Lager → Baustelle",
      date: booking.mixedAt || booking.at,
    }, `paint:${surfaceKey(name, unit)}|${lower(use)}`, tone);
  }
  for (const [index, material] of list(metaRows).entries()) {
    if (!material || usedMetadata.has(String(material.key || ""))) continue;
    if (material.custom || clean(material.name)) add(material, { id: `manual:${material.key || index}`, source: "In der Akte erfasst" }, material.key);
  }
  return [...materials.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
}

module.exports = { readMaterialSources, collectCustomerMaterials };
