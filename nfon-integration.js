"use strict";

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

module.exports = { registerNfonIntegration, parseOfficeExtensions };
