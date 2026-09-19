const fs = require("fs");
const path = require("path");
const { portalRecipientOptions, sanitizePortalRecipient } = require("./workflow-contacts");

const PORTAL_STATUSES = new Set(["off", "prepared", "active"]);
const PORTAL_MODULES = ["projectFile", "regie", "communication", "projectPoints"];

function customerContactDefaults(meta = {}) {
  const master = meta.customerMaster || {}, owner = meta.projectContacts?.owner || {};
  const clean = value => String(value || "").trim();
  const unique = values => [...new Set(values.map(clean).filter(Boolean))];
  const personName = person => clean([person?.title, person?.firstName, person?.lastName].map(clean).filter(Boolean).join(" ") || person?.company);
  const ownerNames = unique([
    [owner.womanTitle, owner.womanFirstName || owner.firstName, owner.womanLastName || owner.sharedLastName].map(clean).filter(Boolean).join(" "),
    [owner.manTitle, owner.manFirstName, owner.manLastName || owner.sharedLastName].map(clean).filter(Boolean).join(" "),
  ]);
  const recipients = meta.projectContacts?.deliveryRecipients?.offer;
  const selectionExplicit = !!(recipients && typeof recipients === "object");
  const selectedGroups = ["owner", "siteManager", "architect"].filter(group => recipients?.[group] ?? (group === "owner"));
  const groups = selectedGroups.length ? selectedGroups : ["owner"];
  const contacts = [];
  if (groups.includes("owner")) contacts.push({
    names: ownerNames.length ? ownerNames : [clean(meta.contactName || master.name || owner.customer || meta.name)],
    emails: unique([owner.womanEmail, owner.manEmail, owner.email, meta.contactEmail, master.email]),
    phones: unique([owner.phoneOwnerWoman, owner.phoneOwnerMan, meta.contactPhone, master.phone]),
  });
  for (const group of ["siteManager", "architect"]) if (groups.includes(group)) {
    const person = meta.projectContacts?.[group] || {};
    contacts.push({ names: [personName(person)], emails: [clean(person.email)], phones: [clean(person.phone)] });
  }
  const names = unique(contacts.flatMap(contact => contact.names));
  const emails = unique(contacts.flatMap(contact => contact.emails));
  const phones = unique(contacts.flatMap(contact => contact.phones));
  const selectionKey = JSON.stringify({ groups, names, emails, phones });
  return {
    customerName: names.join(" und ") || clean(meta.contactName || master.name || owner.customer || meta.name),
    customerEmail: (!selectionExplicit && clean(meta.contactEmail || master.email)) || (emails.length === 1 ? emails[0] : ""),
    customerPhone: (!selectionExplicit && clean(meta.contactPhone || master.phone)) || (phones.length === 1 ? phones[0] : ""),
    emails, phones, selectedGroups: groups, selectionExplicit, selectionKey,
  };
}

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
  const rawRecipients = Array.isArray(source.recipients) ? source.recipients : (Array.isArray(old.recipients) ? old.recipients : []);
  const recipientMap = new Map();
  for (const value of rawRecipients.slice(0, 20)) {
    const recipient = sanitizePortalRecipient(value);
    if (recipient.id && (recipient.name || recipient.email || recipient.phone)) recipientMap.set(recipient.id, recipient);
  }
  const recipients = [...recipientMap.values()];
  const rawSelected = Array.isArray(source.selectedRecipientIds) ? source.selectedRecipientIds : (Array.isArray(old.selectedRecipientIds) ? old.selectedRecipientIds : []);
  const selectedRecipientIds = [...new Set(rawSelected.map(id => String(id || "").replace(/[^A-Za-z0-9_-]/g, "")).filter(id => recipientMap.has(id)))].slice(0, 20);
  return {
    status,
    mode,
    modules,
    includedJobIds: mode === "collection" ? includedJobIds : [],
    customerName: String(source.customerName ?? old.customerName ?? "").trim().slice(0, 120),
    customerEmail: String(source.customerEmail ?? old.customerEmail ?? "").trim().slice(0, 180),
    customerPhone: String(source.customerPhone ?? old.customerPhone ?? "").trim().slice(0, 60),
    contactSelectionKey: String(source.contactSelectionKey ?? old.contactSelectionKey ?? "").slice(0, 1000),
    recipients,
    selectedRecipientIds,
    updatedAt: source.updatedAt ?? old.updatedAt ?? null,
  };
}

function customerPortalRecipientOptions(meta = {}, portalValue = {}) {
  const portal = sanitizeCustomerPortal(portalValue);
  const options = new Map(portalRecipientOptions(meta).map(row => [row.id, sanitizePortalRecipient(row)]));
  for (const recipient of portal.recipients) if (!options.has(recipient.id) || recipient.role === "manual") options.set(recipient.id, recipient);
  return [...options.values()];
}

function registerCustomerPortal(app, options) {
  const { dataDir, requireAdmin, readJobMeta, writeJobMeta, appendJobHistory } = options;
  const portalBaseUrl = String(options.portalBaseUrl || "https://protokoll.krista.at/kundenportal").replace(/\/$/, "");
  const jobExists = jobId => fs.existsSync(path.join(dataDir, jobId));
  const isSafeJobId = jobId => /^[A-Za-z0-9_-]+$/.test(jobId);
  const portalUrl = () => portalBaseUrl;

  app.get("/admin/api/job/:jobId/customer-portal", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const jobId = String(req.params.jobId || "");
      if (!isSafeJobId(jobId) || !jobExists(jobId)) return res.status(404).json({ ok: false, error: "Baustelle nicht gefunden." });
      const meta = await readJobMeta(jobId);
      const portal=sanitizeCustomerPortal(meta.customerPortal),recipientOptions=customerPortalRecipientOptions(meta,portal),invitationStatuses=await options.listInvitations?.(jobId) || [];
      res.json({ ok: true, jobId, portal, contactDefaults: customerContactDefaults(meta), recipientOptions, invitationStatuses, portalUrl: portalUrl(jobId) });
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
      const members = await options.collectionMembers?.(jobId) || beforeMeta.collectionMemberJobIds || [];
      const collectionMemberJobIds = members.filter(id => id !== jobId && jobExists(id));
      if (portal.mode === "collection" && !collectionMemberJobIds.length) {
        return res.status(400).json({ ok: false, error: "Diese Baustelle ist keine Sammelmappe." });
      }
      portal.includedJobIds = portal.mode === "collection" ? collectionMemberJobIds : [];
      portal.updatedAt = new Date().toISOString();
      await writeJobMeta(jobId, { customerPortal: portal });
      const beforePortal=sanitizeCustomerPortal(beforeMeta.customerPortal);
      if(portal.status === "off" || ["customerName","customerPhone","customerEmail"].some(key => portal[key] !== beforePortal[key]) || JSON.stringify(portal.recipients)!==JSON.stringify(beforePortal.recipients) || JSON.stringify(portal.selectedRecipientIds)!==JSON.stringify(beforePortal.selectedRecipientIds)) await options.revokeAccess?.(jobId);
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

module.exports = { PORTAL_MODULES, sanitizeCustomerPortal, customerContactDefaults, customerPortalRecipientOptions, registerCustomerPortal };
