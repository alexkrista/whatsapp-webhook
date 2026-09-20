"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const { cleanDate, cleanTime } = require("./order-schedule-workflow");

const CLOSING = "Vielen Dank für Ihren Auftrag und Ihr Vertrauen. Wir bestätigen die Ausführung der oben angeführten Leistungen zu den vereinbarten Konditionen und zum bestätigten Termin.";
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const clone = value => JSON.parse(JSON.stringify(value));

// Reconstruct the print view exclusively from the accepted order, never the editable offer.
function buildConfirmationDraft(order) {
  if (!order?.offerNumber || !order.positions?.length) throw failure("Bitte zuerst das Angebot als Auftrag übernehmen.");
  const groupDiscounts = {};
  const positions = order.positions.map(row => {
    if (row.groupName) groupDiscounts[row.groupName] = Number(row.groupDiscountPercent || 0);
    return { ...clone(row), text:row.text || "", unitPrice:Number(row.enteredUnitPrice ?? row.unitPriceNet ?? 0), isAlternative:false };
  });
  return {
    ...clone(order.presentation || {}),
    offerNumber:order.offerNumber,
    offerRevision:order.offerRevision,
    offerCreatedAt:order.acceptedAt,
    offerType:order.offerType,
    intro:order.intro || "",
    scopeDescription:order.subject || "",
    showQuantities:order.presentation?.showQuantities !== false,
    financials:clone(order.financials || {}),
    groupDiscounts,
    positions,
    orderConfirmationTotals:clone(order.totals || {}),
  };
}

function confirmedSlot(schedule) {
  const date = cleanDate(schedule?.confirmedDate), from = cleanTime(schedule?.confirmedFrom), to = cleanTime(schedule?.confirmedTo);
  if (schedule?.status !== "confirmed" || !date || !from || !to || to <= from) {
    throw failure("Bitte zuerst den Ausführungstermin bestätigen und eintragen.");
  }
  return { date, from, to };
}

function registerOrderConfirmation(app, options) {
  const { dataDir, requireAdmin, readJobMeta, readOrderSchedule, readDocumentation, writeDocumentation, appendJobHistory, renderPdf } = options;
  const queues = new Map();
  const validJob = id => /^[A-Za-z0-9_-]+$/.test(String(id || ""));
  const readOrder = id => fs.readFile(path.join(dataDir, id, ".accepted-order.json"), "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") throw failure("Bitte zuerst das Angebot als Auftrag übernehmen.");
    throw error;
  });

  async function context(jobId) {
    const [order, schedule, meta, documents] = await Promise.all([readOrder(jobId), readOrderSchedule(jobId), readJobMeta(jobId), readDocumentation(jobId)]);
    const slot = confirmedSlot(schedule), draft = buildConfirmationDraft(order), layout = await options.readDocumentLayout?.();
    const job = { jobId, name:meta.name, street:meta.street, houseNumber:meta.houseNumber, postalCode:meta.postalCode, city:meta.city, contactName:meta.contactName, customerMaster:meta.customerMaster, projectContacts:meta.projectContacts };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ version:2, order, slot, job, closing:CLOSING, layoutRevision:layout?.revision||"" })).digest("hex");
    const stored = documents.find(row => row.source === "order-confirmation" && row.fingerprint === fingerprint);
    const versions = documents.filter(row => row.source === "order-confirmation");
    const revision = stored?.confirmationRevision || Math.max(0, ...versions.map(row => Number(row.confirmationRevision) || 0)) + 1;
    const documentDate = stored?.documentDate || new Intl.DateTimeFormat("sv-SE", { timeZone:"Europe/Vienna" }).format(new Date());
    const dateLabel = new Intl.DateTimeFormat("de-AT", { timeZone:"Europe/Vienna", weekday:"long", day:"2-digit", month:"2-digit", year:"numeric" }).format(new Date(`${slot.date}T12:00:00Z`));
    return {
      ok:true, jobId, job, draft, schedule,
      confirmation:{ number:`AB-${order.offerNumber}`, offerNumber:order.offerNumber, offerRevision:order.offerRevision, revision, fingerprint, documentDate, slot, scheduleLabel:`${dateLabel}, ${slot.from}–${slot.to} Uhr`, closing:CLOSING },
      item:stored || null, pdfUrl:stored?.url || null,
    };
  }

  async function serialized(jobId, action) {
    const pending = (queues.get(jobId) || Promise.resolve()).catch(() => {}).then(action);
    queues.set(jobId, pending);
    try { return await pending; } finally { if (queues.get(jobId) === pending) queues.delete(jobId); }
  }

  app.get("/admin/api/job/:jobId/order-confirmation", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const jobId = String(req.params.jobId || "");
    if (!validJob(jobId)) return res.status(400).json({ ok:false, error:"Invalid jobId" });
    try { res.json(await context(jobId)); }
    catch (error) { res.status(error.status || 500).json({ ok:false, error:error.message }); }
  });

  app.post("/admin/api/job/:jobId/order-confirmation/pdf", express.text({ type:"text/html", limit:"5mb" }), async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const jobId = String(req.params.jobId || "");
    if (!validJob(jobId)) return res.status(400).json({ ok:false, error:"Invalid jobId" });
    try {
      const result = await serialized(jobId, async () => {
        const view = await context(jobId), fingerprint = String(req.headers["x-confirmation-fingerprint"] || "");
        if (view.confirmation.fingerprint !== fingerprint) throw failure("Auftrag oder Termin wurden inzwischen geändert. Bitte die AB-Vorschau erneut öffnen.");
        if (view.item && await fs.stat(path.join(dataDir, jobId, "_documentation", view.item.storedName)).then(() => true).catch(() => false)) {
          return { ok:true, item:view.item, pdfUrl:view.item.url, alreadyStored:true };
        }
        if (String(req.headers["x-confirmation-date"] || "") !== view.confirmation.documentDate) throw failure("Bitte die AB-Vorschau für das aktuelle Dokumentdatum erneut öffnen.");
        const html = String(req.body || "");
        if (!html.includes('data-order-confirmation="' + fingerprint + '"') || !html.includes("Auftragsbestätigung")) throw failure("Bitte die Auftragsbestätigung aus der aktuellen Vorschau erstellen.", 400);
        const pdf = await renderPdf(html);
        // Rendering takes time; do not file a document for a slot changed in the meantime.
        if ((await context(jobId)).confirmation.fingerprint !== fingerprint) throw failure("Der Auftragstermin wurde während der PDF-Erstellung geändert. Bitte die AB erneut öffnen.");
        const c = view.confirmation, safeNumber = c.number.replace(/[^A-Za-z0-9_-]/g, "_"), storedName = `auftragsbestaetigung-${safeNumber}-v${c.revision}.pdf`;
        const directory = path.join(dataDir, jobId, "_documentation"), file = path.join(directory, storedName), temporary = file + "." + crypto.randomUUID() + ".tmp";
        await fs.mkdir(directory, { recursive:true });
        try { await fs.writeFile(temporary, pdf); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force:true }).catch(() => {}); }
        const now = new Date().toISOString();
        const item = {
          id:`order-confirmation-${fingerprint.slice(0, 20)}`, type:"order", source:"order-confirmation", name:`Auftragsbestätigung ${c.number}.pdf`,
          storedName, fingerprint, confirmationNumber:c.number, confirmationRevision:c.revision, documentDate:c.documentDate,
          offerNumber:c.offerNumber, offerRevision:c.offerRevision, confirmedSchedule:c.slot, customerVisible:true, renderedAt:now, importedAt:now,
          url:`/admin/api/job/${encodeURIComponent(jobId)}/documentation/file?name=${encodeURIComponent(storedName)}`,
        };
        // Read again after rendering to preserve documents added by other workflows.
        const rows = await readDocumentation(jobId);
        await writeDocumentation(jobId, [item, ...rows.filter(row => row.id !== item.id)]);
        await appendJobHistory(jobId, { type:"order_confirmation_created", title:`Auftragsbestätigung ${c.number} erstellt`, detail:`Bestätigter Termin: ${c.scheduleLabel}`, source:"KRISTINE Auftrag", data:{ confirmationNumber:c.number, confirmationRevision:c.revision, storedName, ...c.slot } });
        return { ok:true, item, pdfUrl:item.url, alreadyStored:false };
      });
      res.json(result);
    } catch (error) { res.status(error.status || 500).json({ ok:false, error:error.message }); }
  });
  return { context };
}

module.exports = { CLOSING, buildConfirmationDraft, confirmedSlot, registerOrderConfirmation };
