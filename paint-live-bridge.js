"use strict";

const fsp = require("fs/promises");
const path = require("path");

function registerPaintLiveBridge(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const bridgeToken = String(process.env.KRISTINE_LG_BRIDGE_TOKEN || "").trim();
  const root = path.join(dataDir, "_kristine", "paint");
  const stateFile = path.join(root, "live-mix-bridge.json");
  const articlesFile = path.join(root, "articles.json");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return false;
    }
    return true;
  }

  function requireBridge(req, res) {
    if (!bridgeToken) {
      res.status(503).json({ ok: false, error: "KRISTINE_LG_BRIDGE_TOKEN ist auf Render noch nicht gesetzt" });
      return false;
    }
    const token = String(req.headers["x-lg-bridge-token"] || "");
    if (token !== bridgeToken) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return false;
    }
    return true;
  }

  async function ensureRoot() { await fsp.mkdir(root, { recursive: true }); }
  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await ensureRoot();
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }
  async function readState() {
    const state = await readJson(stateFile, { bridge: {}, requests: [] });
    if (!state || typeof state !== "object") return { bridge: {}, requests: [] };
    if (!state.bridge || typeof state.bridge !== "object") state.bridge = {};
    if (!Array.isArray(state.requests)) state.requests = [];
    cleanState(state);
    return state;
  }
  function cleanState(state) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    state.requests = (state.requests || []).filter(row => {
      if (row.status !== "done") return true;
      const done = Date.parse(row.doneAt || row.createdAt || 0);
      return !Number.isFinite(done) || done >= cutoff;
    });
  }
  function requestId() {
    return `lg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }
  async function enqueue(operation, extra = {}) {
    const state = await readState();
    const item = {
      requestId: requestId(),
      operation,
      ...extra,
      status: "pending",
      createdAt: new Date().toISOString(),
      sentAt: null,
      doneAt: null,
      result: null,
      error: null,
    };
    state.requests.push(item);
    await writeJson(stateFile, state);
    return item;
  }

  const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
  const norm = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const baseKey = value => {
    const n = norm(value);
    if (["h", "hi", "hiwhite"].includes(n)) return "hiwhite";
    if (["m", "medium"].includes(n)) return "medium";
    if (["d", "deep"].includes(n)) return "deep";
    if (["xd", "x", "extradeep"].includes(n)) return "extradeep";
    if (["t", "transparent"].includes(n)) return "transparent";
    if (["y", "yellow"].includes(n)) return "yellow";
    if (["p", "pastel"].includes(n)) return "pastel";
    if (["w", "white", "whiteasp"].includes(n)) return "whiteasp";
    if (["bc", "bluebc"].includes(n)) return "bluebc";
    if (["tc", "bluetc"].includes(n)) return "bluetc";
    return n;
  };
  const sizeMl = value => {
    const s = clean(value, 50).toLowerCase().replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "").replace(",", ".");
    const ml = s.match(/^([0-9.]+)ml$/);
    if (ml) return Number(ml[1]) || 0;
    const l = s.match(/^([0-9.]+)l$/);
    if (l) return (Number(l[1]) || 0) * 1000;
    return 0;
  };

  async function enrichProducts(item) {
    const articles = await readJson(articlesFile, []);
    const rows = Array.isArray(item.result) ? item.result : [];
    const list = Array.isArray(articles) ? articles : [];

    const products = rows.map(row => {
      const productName = clean(row.name || row.productName, 180);
      const machineBase = clean(row.baseCode || row.baseName, 80);
      const wantedProduct = norm(productName);
      const wantedBase = baseKey(machineBase);

      const matching = list.filter(article => {
        if (!article || article.active === false) return false;
        if (norm(article.product) !== wantedProduct) return false;
        return baseKey(article.baseCode || article.baseName) === wantedBase;
      });

      const sizes = matching.map(article => ({
        size: clean(article.size, 50),
        nominalAmount: Number(article.sizeMl || sizeMl(article.size) || 0),
        stock: Number(article.stock || 0),
        minimumStock: Number(article.minimumStock || 0),
        targetStock: Number(article.targetStock ?? article.minimumStock ?? 0),
        purchasePrice: Number(article.purchasePrice || 0),
        salePrice: Number(article.salePrice || 0),
        ean: clean(article.ean, 100),
        stockCode: clean(article.stockCode, 100),
        articleId: clean(article.id, 220),
        orderQuantityOverride: article.orderQuantityOverride ?? null,
      })).sort((a, b) => Number(b.nominalAmount || 0) - Number(a.nominalAmount || 0));

      return {
        productId: Number(row.id || row.productId || 0),
        productName,
        baseCode: machineBase,
        baseName: machineBase,
        sizes,
        recipeAvailable: false,
        live: true,
      };
    });

    return {
      color: {
        id: Number(item.colourId || item.color?.id || 0),
        system: "LG",
        name: clean(item.color?.code || item.color?.name || "", 160),
        code: clean(item.color?.code || item.color?.name || "", 160),
        card: clean(item.color?.card || "Little Greene", 120),
        rgb: item.color?.rgb ?? null,
      },
      products,
      live: true,
    };
  }

  app.post("/admin/api/paint/bridge/heartbeat", async (req, res) => {
    if (!requireBridge(req, res)) return;
    try {
      const state = await readState();
      state.bridge = {
        machine: clean(req.body?.machine, 120),
        innovatintOnline: !!req.body?.innovatintOnline,
        bridgeVersion: clean(req.body?.bridgeVersion, 40),
        heartbeatAt: new Date().toISOString(),
        sourceTimestamp: clean(req.body?.timestamp, 80),
      };
      await writeJson(stateFile, state);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/paint/bridge/next", async (req, res) => {
    if (!requireBridge(req, res)) return;
    try {
      const state = await readState();
      const retryBefore = Date.now() - 30 * 1000;
      const item = state.requests.find(row => row.status === "pending" || (row.status === "sent" && Date.parse(row.sentAt || 0) < retryBefore));
      if (!item) {
        await writeJson(stateFile, state);
        return res.json({ ok: true, requestId: null });
      }
      item.status = "sent";
      item.sentAt = new Date().toISOString();
      await writeJson(stateFile, state);
      res.json({
        ok: true,
        requestId: item.requestId,
        operation: item.operation,
        query: item.query || "",
        colourId: item.colourId || null,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/bridge/result", async (req, res) => {
    if (!requireBridge(req, res)) return;
    try {
      const id = clean(req.body?.requestId, 120);
      if (!id) return res.status(400).json({ ok: false, error: "requestId fehlt" });
      const state = await readState();
      const item = state.requests.find(row => row.requestId === id);
      if (!item) return res.status(404).json({ ok: false, error: "Request nicht gefunden" });
      item.status = "done";
      item.doneAt = new Date().toISOString();
      item.result = req.body?.ok === false ? null : req.body?.data;
      item.error = req.body?.ok === false ? clean(req.body?.error || "Unbekannter Fehler", 500) : null;
      state.bridge.lastResultAt = item.doneAt;
      state.bridge.machine = clean(req.body?.machine || state.bridge.machine, 120);
      await writeJson(stateFile, state);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/paint/live/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const state = await readState();
      const heartbeat = Date.parse(state.bridge?.heartbeatAt || 0);
      const heartbeatFresh = Number.isFinite(heartbeat) && Date.now() - heartbeat < 2 * 60 * 1000;
      res.json({
        ok: true,
        configured: !!bridgeToken,
        online: !!bridgeToken && heartbeatFresh && state.bridge?.innovatintOnline === true,
        bridge: state.bridge || {},
        pending: state.requests.filter(row => row.status !== "done").length,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/live/search", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!bridgeToken) return res.status(503).json({ ok: false, error: "Mischmaschinen-Bridge ist noch nicht konfiguriert" });
      const query = clean(req.body?.query, 120);
      if (!query) return res.status(400).json({ ok: false, error: "Suchtext fehlt" });
      const item = await enqueue("searchColours", { query });
      res.json({ ok: true, requestId: item.requestId });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/live/products", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!bridgeToken) return res.status(503).json({ ok: false, error: "Mischmaschinen-Bridge ist noch nicht konfiguriert" });
      const colourId = Number(req.body?.colourId || 0);
      if (!Number.isInteger(colourId) || colourId <= 0) return res.status(400).json({ ok: false, error: "colourId fehlt" });
      const color = req.body?.color && typeof req.body.color === "object" ? {
        id: colourId,
        code: clean(req.body.color.code || req.body.color.name, 160),
        name: clean(req.body.color.name || req.body.color.code, 160),
        card: clean(req.body.color.card, 120),
        rgb: req.body.color.rgb ?? null,
      } : { id: colourId };
      const item = await enqueue("productsForColour", { colourId, color });
      res.json({ ok: true, requestId: item.requestId });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/paint/live/request/:requestId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const state = await readState();
      const item = state.requests.find(row => row.requestId === String(req.params.requestId || ""));
      if (!item) return res.status(404).json({ ok: false, error: "Request nicht gefunden" });
      if (item.status !== "done") return res.json({ ok: true, requestId: item.requestId, status: item.status });
      if (item.error) return res.json({ ok: true, requestId: item.requestId, status: "done", error: item.error, result: null });
      const result = item.operation === "productsForColour" ? await enrichProducts(item) : item.result;
      res.json({ ok: true, requestId: item.requestId, status: "done", result, error: null });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintLiveBridge };
