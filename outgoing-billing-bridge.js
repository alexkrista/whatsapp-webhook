"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const DEFAULT_CONNECTOR = "http://127.0.0.1:5051";

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function roundMoney(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function cleanConnector(value) {
  return String(value || DEFAULT_CONNECTOR).trim().replace(/\/+$/, "");
}

function cleanProgressBilling(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reportIdsToBill = [...new Set((Array.isArray(value.reportIdsToBill) ? value.reportIdsToBill : [])
    .map((id) => String(id || "").trim()).filter((id) => id && id.length <= 160))].slice(0, 2000);
  return {
    jobId: String(value.jobId || "").trim().slice(0, 40),
    reportIdsToBill,
  };
}

function buildBillingSummary(project, runDetails) {
  const runs = [];
  const invoices = [];
  const payments = [];

  for (const raw of Array.isArray(runDetails) ? runDetails : []) {
    const run = raw?.run || raw || {};
    const runPayments = (Array.isArray(run.payments) ? run.payments : []).map((payment) => ({
      id: number(payment.id),
      invoiceId: payment.invoiceId == null ? null : number(payment.invoiceId),
      paymentDate: String(payment.paymentDate || "").slice(0, 10),
      net: roundMoney(payment.net),
      vat: roundMoney(payment.vat),
      gross: roundMoney(payment.gross),
      source: String(payment.source || "KRISTINE").toUpperCase() === "WW" ? "WW" : "KRISTINE",
    }));
    const paidByInvoice = new Map();
    for (const payment of runPayments) {
      if (payment.invoiceId == null) continue;
      paidByInvoice.set(payment.invoiceId, roundMoney((paidByInvoice.get(payment.invoiceId) || 0) + payment.gross));
    }

    const runInvoices = (Array.isArray(run.invoices) ? run.invoices : [])
      .filter((invoice) => String(invoice.status || "draft").toLowerCase() !== "cancelled")
      .map((invoice) => {
        const id = number(invoice.id);
        const status = String(invoice.status || "draft").toLowerCase();
        const gross = roundMoney(invoice.increment_gross);
        const paidGross = roundMoney(paidByInvoice.get(id) || 0);
        const progressBilling = cleanProgressBilling(invoice.progressBilling);
        return {
          id,
          runId: number(run.id),
          invoiceNumber: String(invoice.invoice_number || ""),
          status,
          kind: ["TR", "SR", "RE", "GS", "ST"].includes(String(invoice.kind || "").toUpperCase())
            ? String(invoice.kind).toUpperCase()
            : "RE",
          issueDate: String(invoice.issue_date || "").slice(0, 10),
          dueDate: String(invoice.due_date || "").slice(0, 10),
          net: roundMoney(invoice.increment_net),
          ...(invoice.regieNet == null ? {} : { regieNet: roundMoney(invoice.regieNet) }),
          vat: roundMoney(invoice.increment_vat),
          gross,
          paidGross,
          openGross: status === "issued" ? roundMoney(Math.max(0, gross - paidGross)) : 0,
          source: String(invoice.source || "KRISTINE").toUpperCase() === "WW" ? "WW" : "KRISTINE",
          sourceId: String(invoice.source_id || invoice.sourceId || ""),
          ...(progressBilling ? { progressBilling } : {}),
        };
      });

    const issuedInvoices = runInvoices.filter((invoice) => invoice.status === "issued");
    invoices.push(...runInvoices);
    payments.push(...runPayments);
    runs.push({
      id: number(run.id),
      label: String(run.label || "Rechnungslauf"),
      status: String(run.status || "open") === "closed" ? "closed" : "open",
      billedNet: roundMoney(issuedInvoices.reduce((sum, invoice) => sum + invoice.net, 0)),
      billedGross: roundMoney(issuedInvoices.reduce((sum, invoice) => sum + invoice.gross, 0)),
      paidGross: roundMoney(runPayments.reduce((sum, payment) => sum + payment.gross, 0)),
      openGross: roundMoney(Math.max(0, number(run.currentOpen))),
    });
  }

  invoices.sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.id - b.id);
  payments.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.id - b.id);
  const issuedInvoices = invoices.filter((invoice) => invoice.status === "issued");
  const draftInvoices = invoices.filter((invoice) => invoice.status === "draft");
  return {
    found: true,
    projectNumber: String(project?.projectNumber || ""),
    projectIndex: number(project?.projectIndex),
    summary: {
      invoiceCount: issuedInvoices.length,
      draftCount: draftInvoices.length,
      documentCount: invoices.length,
      draftNet: roundMoney(draftInvoices.reduce((sum, invoice) => sum + invoice.net, 0)),
      draftGross: roundMoney(draftInvoices.reduce((sum, invoice) => sum + invoice.gross, 0)),
      billedNet: roundMoney(issuedInvoices.reduce((sum, invoice) => sum + invoice.net, 0)),
      billedGross: roundMoney(issuedInvoices.reduce((sum, invoice) => sum + invoice.gross, 0)),
      paidGross: roundMoney(payments.reduce((sum, payment) => sum + payment.gross, 0)),
      openGross: roundMoney(runs.reduce((sum, run) => sum + run.openGross, 0)),
    },
    invoices,
    payments,
    runs,
  };
}

async function addLocalPrepaymentDraft(billing, dataDir, jobId) {
  if (!dataDir) return billing;
  const draft = await fs.readFile(path.join(dataDir, String(jobId), ".prepayment-invoice-draft.json"), "utf8").then(JSON.parse).catch(() => null);
  if (!draft || draft.status !== "draft") return billing;
  const sourceId = String(draft.id || `vorkassa-${jobId}`);
  if ((billing.invoices || []).some(row => row.sourceId === sourceId)) return billing;
  const invoice = {
    id: `local:${sourceId}`,
    runId: 0,
    invoiceNumber: "Entwurf",
    status: "draft",
    kind: "TR",
    issueDate: String(draft.createdAt || "").slice(0, 10),
    dueDate: "",
    net: roundMoney(draft.netAmount),
    vat: roundMoney(draft.vatAmount),
    gross: roundMoney(draft.grossAmount),
    paidGross: 0,
    openGross: 0,
    source: "KRISTINE",
    sourceId,
    localDraft: true,
    subject: String(draft.subject || "Vorkassa-Rechnungsentwurf"),
  };
  const invoices = [...(billing.invoices || []), invoice];
  return {
    ...billing,
    found: true,
    projectNumber: String(billing.projectNumber || jobId),
    invoices,
    summary: {
      ...(billing.summary || {}),
      draftCount: number(billing.summary?.draftCount) + 1,
      documentCount: number(billing.summary?.documentCount) + 1,
      draftNet: roundMoney(number(billing.summary?.draftNet) + invoice.net),
      draftGross: roundMoney(number(billing.summary?.draftGross) + invoice.gross),
    },
  };
}

function registerOutgoingBillingBridge(app, options = {}) {
  const requireAdmin = options.requireAdmin;
  const connector = cleanConnector(
    options.connector || process.env.OUTGOING_CONNECTOR || process.env.ARCHIVE_CONNECTOR
  );
  const fetchImpl = options.fetchImpl || fetch;

  async function brainJson(path, init = {}) {
    const response = await fetchImpl(`${connector}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Brain-Verbindung HTTP ${response.status}`);
    }
    return data;
  }

  app.post("/admin/api/job/:jobId/outgoing-sync", async (req, res) => {
    if (typeof requireAdmin === "function" && !requireAdmin(req, res)) return;
    try {
      const jobId = String(req.params.jobId || "").trim();
      if (!/^\d{2,12}$/.test(jobId)) {
        return res.status(400).json({ ok: false, error: "Ungültige Baustellennummer." });
      }

      const search = await brainJson(`/api/outgoing/project-search?q=${encodeURIComponent(jobId)}`);
      const matches = (Array.isArray(search.projects) ? search.projects : [])
        .filter((project) => String(project.projectNumber || "").trim() === jobId);
      if (!matches.length) {
        const billing = await addLocalPrepaymentDraft({
          found: false,
          projectNumber: jobId,
          projectIndex: 0,
          summary: { invoiceCount: 0, draftCount: 0, documentCount: 0, draftNet: 0, draftGross: 0, billedNet: 0, billedGross: 0, paidGross: 0, openGross: 0 },
          invoices: [], payments: [], runs: [],
        }, options.dataDir, jobId);
        return res.json({
          ok: true,
          billing,
        });
      }
      if (matches.length > 1) {
        return res.status(409).json({ ok: false, error: "Baustellennummer ist in WinWorker nicht eindeutig." });
      }

      const project = matches[0];
      const projectIndex = number(project.projectIndex);
      if (!projectIndex) throw new Error("WinWorker-Projektindex fehlt.");
      await brainJson(`/api/outgoing/projects/${projectIndex}/sync-history`, {
        method: "POST",
        body: "{}",
      });
      const runList = await brainJson(`/api/outgoing/runs?projectIndex=${projectIndex}`);
      const runDetails = await Promise.all((runList.runs || []).map((run) =>
        brainJson(`/api/outgoing/runs/${number(run.id)}`)
      ));
      const billing = await addLocalPrepaymentDraft(buildBillingSummary(project, runDetails), options.dataDir, jobId);
      if (typeof options.onIssuedProgressInvoices === "function") {
        await options.onIssuedProgressInvoices({
          jobId,
          invoices: billing.invoices.filter((invoice) => invoice.status === "issued" && invoice.progressBilling?.reportIdsToBill?.length),
        });
      }
      return res.json({ ok: true, billing });
    } catch (error) {
      console.error("Ausgangsrechnungen für Baustelle:", String(error?.message || error));
      return res.status(502).json({
        ok: false,
        error: `Rechnungsstand konnte nicht aus dem Brain geladen werden: ${String(error?.message || error)}`,
      });
    }
  });
}

module.exports = { buildBillingSummary, cleanProgressBilling, addLocalPrepaymentDraft, registerOutgoingBillingBridge };
