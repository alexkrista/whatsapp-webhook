const fs = require("fs");
const path = require("path");

const PORTAL_STATUSES = new Set(["off", "prepared", "active"]);
const PORTAL_MODULES = ["projectFile", "regie", "communication", "projectPoints"];

function sanitizeCustomerPortal(value = {}, existing = {}) {
  const source = value && typeof value === "object" ? value : {};
  const old = existing && typeof existing === "object" ? existing : {};
  const incomingModules = source.modules && typeof source.modules === "object" ? source.modules : {};
  const oldModules = old.modules && typeof old.modules === "object" ? old.modules : {};
  const modules = {};
  for (const key of PORTAL_MODULES) modules[key] = Boolean(incomingModules[key] ?? oldModules[key]);
  const status = PORTAL_STATUSES.has(source.status) ? source.status : (PORTAL_STATUSES.has(old.status) ? old.status : "off");
  const mode = source.mode === "collection" ? "collection" : (source.mode === "single" ? "single" : (old.mode === "collection" ? "collection" : "single"));
  const rawIncluded = Array.isArray(source.includedJobIds) ? source.includedJobIds : (Array.isArray(old.includedJobIds) ? old.includedJobIds : []);
  const includedJobIds = [...new Set(rawIncluded.map(id => String(id || "").trim()).filter(id => /^[A-Za-z0-9_-]+$/.test(id)))].slice(0, 50);
  return {
    status,
    mode,
    modules,
    includedJobIds: mode === "collection" ? includedJobIds : [],
    customerName: String(source.customerName ?? old.customerName ?? "").trim().slice(0, 120),
    customerEmail: String(source.customerEmail ?? old.customerEmail ?? "").trim().slice(0, 180),
    customerPhone: String(source.customerPhone ?? old.customerPhone ?? "").trim().slice(0, 60),
    updatedAt: source.updatedAt ?? old.updatedAt ?? null,
  };
}

function registerCustomerPortal(app, options) {
  const { dataDir, requireAdmin, readJobMeta, writeJobMeta, appendJobHistory } = options;
  const portalBaseUrl = String(options.portalBaseUrl || "https://kristine-kundenportal.krista-alex.chatgpt.site").replace(/\/$/, "");
  const jobExists = jobId => fs.existsSync(path.join(dataDir, jobId));
  const isSafeJobId = jobId => /^[A-Za-z0-9_-]+$/.test(jobId);
  const portalUrl = jobId => `${portalBaseUrl}/?project=${encodeURIComponent(jobId)}`;

  app.get("/admin/api/job/:jobId/customer-portal", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const jobId = String(req.params.jobId || "");
      if (!isSafeJobId(jobId) || !jobExists(jobId)) return res.status(404).json({ ok: false, error: "Baustelle nicht gefunden." });
      const meta = await readJobMeta(jobId);
      res.json({ ok: true, jobId, portal: sanitizeCustomerPortal(meta.customerPortal), portalUrl: portalUrl(jobId) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/admin/api/job/:jobId/customer-portal", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const jobId = String(req.params.jobId || "");
      if (!isSafeJobId(jobId) || !jobExists(jobId)) return res.status(404).json({ ok: false, error: "Baustelle nicht gefunden." });
      const beforeMeta = await readJobMeta(jobId);
      const portal = sanitizeCustomerPortal(req.body, beforeMeta.customerPortal);
      const collectionMemberJobIds = Array.isArray(beforeMeta.collectionMemberJobIds)
        ? beforeMeta.collectionMemberJobIds.filter(id => id !== jobId && jobExists(id))
        : [];
      if (portal.mode === "collection" && !collectionMemberJobIds.length) {
        return res.status(400).json({ ok: false, error: "Diese Baustelle ist keine Sammelmappe." });
      }
      portal.includedJobIds = portal.mode === "collection" ? collectionMemberJobIds : [];
      portal.updatedAt = new Date().toISOString();
      await writeJobMeta(jobId, { customerPortal: portal });
      await appendJobHistory(jobId, {
        type: "customer_portal_updated",
        title: "Kundenportal aktualisiert",
        detail: `${portal.status} · ${portal.mode === "collection" ? "Sammelmappe" : "Einzelbaustelle"} · ${PORTAL_MODULES.filter(key => portal.modules[key]).length} Freigabe(n)`,
        source: "admin",
        data: { status: portal.status, mode: portal.mode, modules: portal.modules, includedJobIds: portal.includedJobIds },
      });
      res.json({ ok: true, jobId, portal, portalUrl: portalUrl(jobId) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { PORTAL_MODULES, sanitizeCustomerPortal, registerCustomerPortal };
