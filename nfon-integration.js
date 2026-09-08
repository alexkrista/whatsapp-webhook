"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { NfonCtiClient, NfonApiError } = require("./nfon-cti-client");

function parseOfficeExtensions(value = process.env.NFON_OFFICE_EXTENSIONS || "") {
  return String(value || "").split(",").map((entry) => {
    const [name, ...extensionParts] = entry.split(":");
    return { name: String(name || "").trim(), extension: extensionParts.join(":").trim() };
  }).filter(row => row.name && /^\d+$/.test(row.extension));
}

function publicError(error) {
  const status = error instanceof NfonApiError && error.status >= 400 && error.status < 600 ? error.status : 500;
  return {
    status,
    payload: {
      ok: false,
      error: String(error?.message || error),
      requestId: error instanceof NfonApiError ? error.requestId : "",
    },
  };
}

function phoneKeys(value) {
  const source = String(value || "").trim();
  const digits = source.replace(/\D/g, "");
  if (digits.length < 6) return [];
  const keys = new Set([digits]);
  if (digits.startsWith("00") && digits.length > 8) keys.add(digits.slice(2));
  if ((source.startsWith("+") || digits.startsWith("0043")) && digits.replace(/^00/, "").startsWith("43")) {
    const national = digits.replace(/^00/, "").slice(2);
    keys.add(`43${national}`);
    keys.add(`0${national}`);
    keys.add(national);
  } else if (digits.startsWith("0") && digits.length > 6) {
    keys.add(`43${digits.slice(1)}`);
    keys.add(digits.slice(1));
  }
  return [...keys];
}

function phonesMatch(left, right) {
  const wanted = new Set(phoneKeys(left));
  return phoneKeys(right).some(key => wanted.has(key));
}

function contactDisplayName(row, fallback = "Unbekannter Kontakt") {
  return [row?.title, row?.firstName, row?.lastName].map(value => String(value || "").trim()).filter(Boolean).join(" ")
    || String(row?.company || row?.customer || fallback).trim();
}

function phoneContactsFromJob(jobId, meta) {
  const result = [];
  const project = meta?.projectContacts || {};
  const owner = project.owner || {};
  const address = [meta?.street, meta?.houseNumber, [meta?.postalCode, meta?.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || meta?.addressExtra || "";
  const add = (phone, name, role) => {
    if (!phoneKeys(phone).length) return;
    result.push({ phone: String(phone), name: String(name || "Unbekannter Kontakt"), role, kind: "job", jobId, jobName: String(meta?.name || ""), address });
  };
  add(meta?.contactPhone, meta?.contactName || meta?.customerMaster?.name || owner.customer, "Kunde / Bauherr");
  add(meta?.customerMaster?.phone, meta?.customerMaster?.name || meta?.contactName || owner.customer, "Kunde / Bauherr");
  add(owner.phoneOwnerWoman, [owner.womanTitle, owner.womanFirstName, owner.womanLastName].filter(Boolean).join(" ") || owner.customer, "Bauherrin");
  add(owner.phoneOwnerMan, [owner.manTitle, owner.manFirstName, owner.manLastName].filter(Boolean).join(" ") || owner.customer, "Bauherr");
  add(project.siteManager?.phone, contactDisplayName(project.siteManager), "Bauleiter");
  add(project.architect?.phone, contactDisplayName(project.architect), "Architekt");
  for (const [role, rows] of [["Bauherrschaft", owner.extraLines], ["Bauleiter", project.siteManager?.extraLines], ["Architekt", project.architect?.extraLines]]) {
    for (const row of Array.isArray(rows) ? rows : []) add(row?.value, row?.label || owner.customer, role);
  }
  return result;
}

async function lookupPhone(options, phone) {
  if (!phoneKeys(phone).length) return [];
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const readJobMeta = options.readJobMeta || (async jobId => {
    const file = path.join(dataDir, jobId, ".meta.json");
    return JSON.parse(await fs.readFile(file, "utf8"));
  });
  const matches = [];
  if (dataDir && typeof readJobMeta === "function") {
    const entries = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => []);
    const jobIds = entries.filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name) && !entry.name.startsWith("_") && entry.name !== "unknown").map(entry => entry.name);
    for (const jobId of jobIds) {
      const meta = await readJobMeta(jobId).catch(() => null);
      if (!meta) continue;
      matches.push(...phoneContactsFromJob(jobId, meta).filter(row => phonesMatch(phone, row.phone)));
    }
  }
  if (dataDir) {
    const taskFile = path.join(dataDir, "_kristine", "tasks.json");
    const tasks = await fs.readFile(taskFile, "utf8").then(JSON.parse).catch(() => []);
    const roleNames = { customer: "Kunde / Bauherr", architect: "Architekt", site_manager: "Bauleiter", supplier: "Lieferant", other: "Kontakt" };
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const numbers = [task?.contactPhone, task?.customerMaster?.phone].filter(Boolean);
      if (!numbers.some(number => phonesMatch(phone, number))) continue;
      matches.push({
        phone: String(numbers.find(number => phonesMatch(phone, number)) || ""),
        name: String(task?.contactName || task?.customerMaster?.name || "Unbekannter Kontakt"),
        role: roleNames[task?.customerMaster?.role] || "Kontakt",
        kind: "task", taskId: String(task?.id || ""), taskTitle: String(task?.title || ""),
        jobId: String(task?.jobId || ""), jobName: String(task?.jobName || ""), address: String(task?.address || ""),
      });
    }
  }
  const seen = new Set();
  return matches.filter(row => {
    const key = [row.kind, row.jobId, row.taskId, row.role, row.name, phoneKeys(row.phone)[0]].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function registerNfonIntegration(app, options = {}) {
  const requireAdmin = options.requireAdmin || (() => true);
  const officeExtensions = parseOfficeExtensions(options.officeExtensions);
  const allowed = new Set(officeExtensions.map(row => row.extension));
  const client = options.client || new NfonCtiClient({ appName: "kristine", appVersion: options.appVersion || "2.0.0" });

  function guard(req, res) {
    if (!requireAdmin(req, res)) return false;
    if (!client.configured()) {
      res.status(503).json({ ok: false, error: "NFON-Zugang ist noch nicht vollständig konfiguriert." });
      return false;
    }
    return true;
  }

  function allowedExtension(value) {
    const extension = String(value || "").trim();
    if (!allowed.size) throw new Error("NFON_OFFICE_EXTENSIONS ist noch nicht konfiguriert");
    if (!allowed.has(extension)) throw new Error("Diese NFON-Nebenstelle ist für Kristine nicht freigegeben");
    return extension;
  }

  app.get("/kristine/api/nfon/status", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({
      ok: true,
      configured: client.configured(),
      ready: client.configured() && officeExtensions.length > 0,
      extensionDiscoveryReady: client.configured(),
      officeExtensions,
      capabilities: {
        extensions: true, states: true, liveCallEvents: true, clickToDial: true, cancelCall: true,
        voicemail: false, callHistory: false, routingWrite: false,
      },
    });
  });

  app.get("/kristine/api/nfon/lookup", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const phone = String(req.query?.phone || "").trim().slice(0, 80);
      if (!phoneKeys(phone).length) return res.status(400).json({ ok: false, error: "Ungültige Telefonnummer." });
      res.json({ ok: true, phone, matches: await lookupPhone(options, phone) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/nfon/extensions", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const rows = await client.getPhoneExtensions();
      const apiRows = Array.isArray(rows) ? rows : [];
      const byExtension = new Map(apiRows.map(row => [String(row.extension_number || ""), row]));
      const extensions = officeExtensions.length
        ? officeExtensions.map(config => ({ ...config, ...(byExtension.get(config.extension) || {}), configuredName: config.name, allowed: true }))
        : apiRows.map(row => ({ ...row, extension: String(row.extension_number || ""), configuredName: String(row.name || ""), allowed: false }));
      res.json({ ok: true, extensions, selectionRequired: officeExtensions.length === 0 });
    } catch (error) {
      const out = publicError(error); res.status(out.status).json(out.payload);
    }
  });

  app.get("/kristine/api/nfon/states", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const extensions = officeExtensions.map(row => row.extension);
      if (!extensions.length) throw new Error("NFON_OFFICE_EXTENSIONS ist noch nicht konfiguriert");
      res.json({ ok: true, states: await client.getStates(extensions) });
    } catch (error) {
      const out = publicError(error); res.status(out.status).json(out.payload);
    }
  });

  app.post("/kristine/api/nfon/calls", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const extension = allowedExtension(req.body?.extension);
      const call = await client.originateCall({
        caller: extension,
        extension,
        callerContext: client.kAccount,
        callee: req.body?.phone,
        calleeContext: "global",
        timeout: req.body?.timeout,
      });
      res.status(202).json({ ok: true, call });
    } catch (error) {
      const out = publicError(error); res.status(out.status).json(out.payload);
    }
  });

  app.delete("/kristine/api/nfon/calls/:uuid", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      await client.cancelCall(req.params.uuid);
      res.status(204).end();
    } catch (error) {
      const out = publicError(error); res.status(out.status).json(out.payload);
    }
  });

  console.log("NFON CTI Integration", { credentialsConfigured: client.configured(), officeExtensionsConfigured: officeExtensions.length });
  return { client, officeExtensions };
}

module.exports = { registerNfonIntegration, parseOfficeExtensions, phoneKeys, phonesMatch, lookupPhone };
