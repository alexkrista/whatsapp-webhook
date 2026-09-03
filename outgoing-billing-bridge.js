"use strict";

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
      .filter((invoice) => String(invoice.status || "") === "issued")
      .map((invoice) => {
        const id = number(invoice.id);
        const gross = roundMoney(invoice.increment_gross);
        const paidGross = roundMoney(paidByInvoice.get(id) || 0);
        return {
          id,
          runId: number(run.id),
          invoiceNumber: String(invoice.invoice_number || ""),
          kind: ["TR", "SR", "RE", "GS", "ST"].includes(String(invoice.kind || "").toUpperCase())
            ? String(invoice.kind).toUpperCase()
            : "RE",
          issueDate: String(invoice.issue_date || "").slice(0, 10),
          dueDate: String(invoice.due_date || "").slice(0, 10),
          net: roundMoney(invoice.increment_net),
          vat: roundMoney(invoice.increment_vat),
          gross,
          paidGross,
          openGross: roundMoney(Math.max(0, gross - paidGross)),
          source: String(invoice.source || "KRISTINE").toUpperCase() === "WW" ? "WW" : "KRISTINE",
        };
      });

    invoices.push(...runInvoices);
    payments.push(...runPayments);
    runs.push({
      id: number(run.id),
      label: String(run.label || "Rechnungslauf"),
      status: String(run.status || "open") === "closed" ? "closed" : "open",
      billedNet: roundMoney(runInvoices.reduce((sum, invoice) => sum + invoice.net, 0)),
      billedGross: roundMoney(runInvoices.reduce((sum, invoice) => sum + invoice.gross, 0)),
      paidGross: roundMoney(runPayments.reduce((sum, payment) => sum + payment.gross, 0)),
      openGross: roundMoney(Math.max(0, number(run.currentOpen))),
    });
  }

  invoices.sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.id - b.id);
  payments.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.id - b.id);
  return {
    found: true,
    projectNumber: String(project?.projectNumber || ""),
    projectIndex: number(project?.projectIndex),
    summary: {
      invoiceCount: invoices.length,
      billedNet: roundMoney(invoices.reduce((sum, invoice) => sum + invoice.net, 0)),
      billedGross: roundMoney(invoices.reduce((sum, invoice) => sum + invoice.gross, 0)),
      paidGross: roundMoney(payments.reduce((sum, payment) => sum + payment.gross, 0)),
      openGross: roundMoney(runs.reduce((sum, run) => sum + run.openGross, 0)),
    },
    invoices,
    payments,
    runs,
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
        return res.json({
          ok: true,
          billing: {
            found: false,
            projectNumber: jobId,
            projectIndex: 0,
            summary: { invoiceCount: 0, billedNet: 0, billedGross: 0, paidGross: 0, openGross: 0 },
            invoices: [], payments: [], runs: [],
          },
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
      return res.json({ ok: true, billing: buildBillingSummary(project, runDetails) });
    } catch (error) {
      console.error("Ausgangsrechnungen für Baustelle:", String(error?.message || error));
      return res.status(502).json({
        ok: false,
        error: `Rechnungsstand konnte nicht aus dem Brain geladen werden: ${String(error?.message || error)}`,
      });
    }
  });
}

module.exports = { buildBillingSummary, registerOutgoingBillingBridge };
