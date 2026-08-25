"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { identityKey, readLatestStockMap, stockForArticle } = require("./paint-stock-ledger");

function registerPaintMixHistory(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const bridgeToken = String(process.env.KRISTINE_LG_BRIDGE_TOKEN || "").trim();
  const root = path.join(dataDir, "_kristine", "paint");
  const kristineRoot = path.join(dataDir, "_kristine");
  const articlesFile = path.join(root, "articles.json");
  const movementsFile = path.join(root, "movements.jsonl");
  const historyFile = path.join(root, "mix-history.json");
  const syncStateFile = path.join(root, "mix-history-sync.json");
  const tasksFile = path.join(kristineRoot, "tasks.json");
  const jobMaterialsFile = path.join(root, "job-materials.jsonl");

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
      res.status(503).json({ ok: false, error: "KRISTINE_LG_BRIDGE_TOKEN fehlt" });
      return false;
    }
    if (String(req.headers["x-lg-bridge-token"] || "") !== bridgeToken) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return false;
    }
    return true;
  }

  async function ensureDir(file) { await fsp.mkdir(path.dirname(file), { recursive: true }); }
  async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; } }
  async function writeJson(file, value) {
    await ensureDir(file);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }
  async function appendJsonl(file, value) {
    await ensureDir(file);
    await fsp.appendFile(file, JSON.stringify(value) + "\n", "utf8");
  }
  async function readJsonl(file) {
    try {
      return (await fsp.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
  const norm = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const number = (value, fallback = 0) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    const parsed = Number(clean(value, 80).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const get = (obj, dotted) => {
    let current = obj;
    for (const part of String(dotted).split(".")) {
      if (current === null || current === undefined || typeof current !== "object") return undefined;
      current = current[part];
    }
    return current;
  };
  const pick = (obj, paths, fallback = "") => {
    for (const candidate of paths) {
      const value = get(obj, candidate);
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
    return fallback;
  };

  function viennaDate(value = new Date()) {
    const d = value instanceof Date ? value : new Date(value);
    const date = Number.isNaN(d.getTime()) ? new Date() : d;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function normalizeTimestamp(value, row) {
    let raw = clean(value, 120);
    if (!raw) {
      const date = clean(pick(row, ["date", "orderDate", "createdDate", "dispenseDate"]), 40);
      const time = clean(pick(row, ["time", "orderTime", "createdTime", "dispenseTime"]), 40);
      raw = [date, time].filter(Boolean).join(" ");
    }
    const parsed = raw ? new Date(raw) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return raw || new Date().toISOString();
  }

  function sizeLiters(value) {
    const raw = clean(value, 50).toLowerCase().replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "").replace(",", ".");
    const ml = raw.match(/^([0-9.]+)ml$/);
    if (ml) return Math.max(0, Number(ml[1]) || 0) / 1000;
    const l = raw.match(/^([0-9.]+)l$/);
    if (l) return Math.max(0, Number(l[1]) || 0);
    return 0;
  }

  function compactRaw(row) {
    try {
      const text = JSON.stringify(row);
      return text.length <= 12000 ? row : { truncated: true, preview: text.slice(0, 12000) };
    } catch { return null; }
  }

  function normalizeHistoryRow(raw) {
    const row = raw && typeof raw === "object" ? raw : {};
    const mixedAt = normalizeTimestamp(pick(row, [
      "dispensedAt", "dispenseAt", "dispenseDateTime", "tintedAt", "completedAt", "createdAt", "orderDateTime", "timestamp", "modifiedAt"
    ]), row);
    const colourCode = clean(pick(row, [
      "colour.code", "color.code", "colourCode", "colorCode", "code", "colour.uniqueCode", "color.uniqueCode"
    ]), 180);
    const colourName = clean(pick(row, [
      "colour.name", "color.name", "colourName", "colorName", "colour", "color"
    ]), 180) || colourCode;
    const productName = clean(pick(row, [
      "product.name", "productName", "product", "basePaint.product.name", "basepaint.product.name"
    ]), 180);
    const baseCode = clean(pick(row, [
      "base.code", "baseCode", "basePaint.code", "basepaint.code", "base.codeName"
    ]), 80);
    const baseName = clean(pick(row, [
      "base.name", "baseName", "basePaint.name", "basepaint.name", "base"
    ]), 120) || baseCode;
    const size = clean(pick(row, [
      "canSize.name", "cansize.name", "can.size", "canSize", "canSizeName", "size", "packageSize"
    ]), 60);
    const quantity = Math.max(1, Math.round(Math.abs(number(pick(row, ["quantity", "qty", "canCount", "cans"], 1), 1))));
    const externalId = clean(pick(row, [
      "historyId", "dispenseId", "tintingId", "orderLineId", "orderItemId", "id", "orderId", "orderID", "ORDERID"
    ]), 160);
    const orderNo = clean(pick(row, ["orderNo", "orderNumber", "order.number", "number"]), 120);
    const stable = [externalId, orderNo, mixedAt, colourCode || colourName, productName, baseCode || baseName, size, quantity].join("|");
    const historyId = externalId || `mix_${crypto.createHash("sha1").update(stable).digest("hex").slice(0, 20)}`;
    const statusText = norm(pick(row, ["status", "orderStatus", "state"], ""));
    const clearlyCancelled = /cancel|void|abgebroch|deleted/.test(statusText);
    return {
      id: historyId, externalId, orderNo, mixedAt,
      colourId: number(pick(row, ["colour.id", "color.id", "colourId", "colorId"], 0), 0),
      colourCode, colourName, productName, baseCode, baseName, size, quantity,
      liters: Number((sizeLiters(size) * quantity).toFixed(3)),
      sourceStatus: clean(pick(row, ["status", "orderStatus", "state"], ""), 80),
      cancelled: clearlyCancelled,
      raw: compactRaw(row),
    };
  }

  function taskTitle(row) {
    const tone = row.colourCode || row.colourName || "Farbton";
    return `Mischung zuordnen · ${tone}${row.size ? ` · ${row.size}` : ""}`.slice(0, 180);
  }

  function makeTask(row) {
    const parts = [
      row.productName, row.baseName || row.baseCode, row.size, row.colourCode || row.colourName,
      row.mixedAt ? new Date(row.mixedAt).toLocaleString("de-AT", { timeZone: "Europe/Vienna" }) : "",
      "Zuordnen: Verkauf / Baustelle / Lager / Fehlmischung",
      "Farben & Lager → Scan Abgang → Misch-History",
    ].filter(Boolean);
    return {
      id: `mix_task_${crypto.createHash("sha1").update(row.id).digest("hex").slice(0, 18)}`,
      title: taskTitle(row), assigneeId: "", assigneeName: "", jobId: "", jobName: "",
      taskType: "Sonstiges", priority: "heute", creatorId: "mixing-machine", creatorName: "Mischmaschine",
      address: "", contactName: "", contactPhone: "", contactEmail: "",
      dueDate: viennaDate(row.mixedAt), reminder: parts.join(" · ").slice(0, 500),
      status: "open", createdAt: new Date().toISOString(), completedAt: null,
    };
  }

  async function createTasksForNewRows(newRows) {
    if (!newRows.length) return 0;
    const tasks = await readJson(tasksFile, []);
    const list = Array.isArray(tasks) ? tasks : [];
    const byId = new Set(list.map(task => String(task?.id || "")));
    let created = 0;
    for (const row of newRows) {
      const task = makeTask(row);
      row.taskId = task.id;
      if (byId.has(task.id)) continue;
      list.push(task); byId.add(task.id); created += 1;
    }
    if (created) await writeJson(tasksFile, list.slice(-10000));
    return created;
  }

  async function ingest(rows, machine = "", options = {}) {
    const existing = await readJson(historyFile, []);
    const list = Array.isArray(existing) ? existing : [];
    const known = new Set(list.map(row => String(row?.id || "")));
    const additions = [];
    let skippedCancelled = 0;
    for (const raw of Array.isArray(rows) ? rows : []) {
      const normalized = normalizeHistoryRow(raw);
      if (normalized.cancelled) { skippedCancelled += 1; continue; }
      if (!normalized.id || known.has(normalized.id)) continue;
      normalized.status = options.baseline ? "baseline" : "open";
      normalized.resolution = options.baseline ? "baseline" : null;
      normalized.jobId = ""; normalized.jobName = "";
      normalized.importedAt = new Date().toISOString();
      normalized.machine = clean(machine, 120); normalized.taskId = "";
      list.push(normalized); additions.push(normalized); known.add(normalized.id);
    }
    const tasksCreated = options.baseline || options.createTasks === false ? 0 : await createTasksForNewRows(additions);
    if (additions.length) await writeJson(historyFile, list.slice(-20000));
    const now = new Date().toISOString();
    const state = await readJson(syncStateFile, {});
    const newest = additions.map(row => row.mixedAt).filter(Boolean).sort().at(-1) || state.lastHistoryAt || null;
    await writeJson(syncStateFile, {
      ...state, lastSyncAt: now, lastHistoryAt: newest, lastMachine: clean(machine, 120),
      lastReceivedRows: Array.isArray(rows) ? rows.length : 0, lastNewRows: additions.length,
      lastTasksCreated: tasksCreated, lastSkippedCancelled: skippedCancelled,
      lastMode: options.baseline ? "baseline" : "incremental", updatedAt: now,
    });
    return { received: Array.isArray(rows) ? rows.length : 0, added: additions.length, tasksCreated, skippedCancelled, newest };
  }

  async function markTaskDone(taskId) {
    if (!taskId) return;
    const tasks = await readJson(tasksFile, []);
    if (!Array.isArray(tasks)) return;
    const task = tasks.find(row => String(row?.id || "") === String(taskId));
    if (!task || task.status === "done") return;
    task.status = "done"; task.completedAt = new Date().toISOString();
    await writeJson(tasksFile, tasks);
  }

  async function findArticleForMix(row, articles) {
    const wanted = identityKey({ product: row.productName, baseCode: row.baseCode || row.baseName, baseName: row.baseName, size: row.size });
    let candidates = (Array.isArray(articles) ? articles : []).filter(article => article && article.active !== false && identityKey(article) === wanted);
    if (candidates.length === 1) return { article: candidates[0], candidates };
    const wantedProduct = norm(row.productName), wantedBase = norm(row.baseCode || row.baseName);
    candidates = (Array.isArray(articles) ? articles : []).filter(article => {
      if (!article || article.active === false || norm(article.product) !== wantedProduct) return false;
      return norm(article.baseCode || article.baseName) === wantedBase;
    });
    if (candidates.length === 1) return { article: candidates[0], candidates };
    return { article: null, candidates };
  }

  async function appendProjectMaterial(row, article, resolution, jobId, jobName, movement) {
    if (resolution !== "project") return;
    const booking = {
      id: `mixmat_${crypto.createHash("sha1").update(`${row.id}|${jobId}`).digest("hex").slice(0, 18)}`,
      at: movement.at, mixedAt: row.mixedAt, historyId: row.id, jobId, jobName,
      articleId: article.id || "", product: article.product || row.productName || "",
      baseCode: article.baseCode || row.baseCode || "", baseName: article.baseName || row.baseName || "",
      size: article.size || row.size || "", colourTone: row.colourCode || row.colourName || "",
      quantity: movement.quantity, liters: Number((sizeLiters(article.size || row.size) * movement.quantity).toFixed(3)),
      purchasePrice: Number(article.purchasePrice || 0), salePrice: Number(article.salePrice || 0), source: "innovatint-history",
    };
    await appendJsonl(jobMaterialsFile, booking);
    const jobDir = path.join(dataDir, String(jobId));
    try {
      const stat = await fsp.stat(jobDir);
      if (stat.isDirectory()) await appendJsonl(path.join(jobDir, "_chronik", "material-bookings.jsonl"), booking);
    } catch {}
  }

  async function resolveMix(id, body) {
    const history = await readJson(historyFile, []);
    if (!Array.isArray(history)) throw new Error("Misch-History ist beschädigt");
    const row = history.find(item => String(item?.id || "") === String(id));
    if (!row) return { statusCode: 404, error: "Mischung nicht gefunden" };
    if (row.status === "resolved") return { statusCode: 200, row, alreadyResolved: true };
    if (row.status === "baseline") return { statusCode: 409, error: "Historischer Baseline-Eintrag wird nicht gebucht" };

    const aliases = { verkauf: "sale", baustelle: "project", lager: "stock", fehlmischung: "waste", waste: "waste", stock: "stock", sale: "sale", project: "project" };
    const resolution = aliases[norm(body?.resolution)] || "";
    if (!resolution) return { statusCode: 400, error: "Verkauf, Baustelle, Lager oder Fehlmischung wählen" };
    const jobId = resolution === "project" ? clean(body?.jobId, 80) : "";
    const jobName = resolution === "project" ? clean(body?.jobName, 180) : "";
    if (resolution === "project" && !jobId) return { statusCode: 400, error: "Baustelle fehlt" };

    const articles = await readJson(articlesFile, []);
    const match = await findArticleForMix(row, articles);
    if (!match.article) {
      return { statusCode: 409, error: "Lagerartikel zur Mischung nicht eindeutig gefunden",
        mix: { product: row.productName, base: row.baseName || row.baseCode, size: row.size },
        matches: match.candidates.map(article => ({ id: article.id, product: article.product, base: article.baseName || article.baseCode, size: article.size, stockCode: article.stockCode })) };
    }

    const article = match.article;
    const stockMap = await readLatestStockMap(root);
    const resolvedStock = stockForArticle(article, stockMap);
    const quantity = Math.max(1, Math.round(Math.abs(Number(row.quantity || 1))));
    const before = Number(resolvedStock.stock || 0), after = before - quantity;
    if (after < 0) return { statusCode: 409, error: `Nicht genug Bestand (${before})`, articleId: article.id };

    const at = new Date().toISOString();
    article.stock = after; article.updatedAt = at;
    await writeJson(articlesFile, articles);
    const reason = resolution === "project" ? "project" : resolution === "sale" ? "sale" : resolution === "stock" ? "mixed_stock" : "waste";
    const movement = {
      at, articleId: article.id || "", ean: article.ean || "", stockCode: article.stockCode || "",
      product: article.product || row.productName || "", baseCode: article.baseCode || row.baseCode || "",
      baseName: article.baseName || row.baseName || row.baseCode || "", size: article.size || row.size || "",
      direction: "out", quantity, delta: -quantity, before, after, reason, jobId, jobName,
      colourTone: row.colourCode || row.colourName || "", historyId: row.id, mixedAt: row.mixedAt,
      source: "innovatint-history", user: clean(body?.user || "KRISTINE Misch-History", 120),
      purchasePrice: Number(article.purchasePrice || 0), salePrice: Number(article.salePrice || 0),
    };
    await appendJsonl(movementsFile, movement);
    await appendProjectMaterial(row, article, resolution, jobId, jobName, movement);

    row.status = "resolved"; row.resolution = resolution; row.jobId = jobId; row.jobName = jobName;
    row.resolvedAt = at; row.resolvedBy = movement.user; row.articleId = article.id || "";
    row.stockBefore = before; row.stockAfter = after;
    await writeJson(historyFile, history);
    await markTaskDone(row.taskId);
    return { statusCode: 200, row, article, movement };
  }

  function aggregateStats(movements, articles, year) {
    const articleById = new Map((Array.isArray(articles) ? articles : []).map(article => [String(article?.id || ""), article]));
    const groups = { sale: [], project: [], waste: [], mixed_stock: [] };
    for (const movement of movements) {
      if (String(movement?.direction || "") !== "out") continue;
      const at = String(movement?.at || "");
      if (!at.startsWith(`${year}-`)) continue;
      const reason = String(movement?.reason || "");
      if (groups[reason]) groups[reason].push(movement);
    }
    const summarize = rows => {
      let pieces = 0, liters = 0, value = 0;
      const products = new Map(), colours = new Map();
      for (const row of rows) {
        const qty = Math.max(0, Number(row.quantity || 0));
        const article = articleById.get(String(row.articleId || "")) || {};
        pieces += qty; liters += sizeLiters(row.size || article.size) * qty;
        value += qty * Number(row.salePrice || article.salePrice || 0);
        const product = clean(row.product || article.product || "Unbekannt", 180) || "Unbekannt";
        const colour = clean(row.colourTone || "ungemischt", 180) || "ungemischt";
        products.set(product, (products.get(product) || 0) + qty);
        colours.set(colour, (colours.get(colour) || 0) + qty);
      }
      return { pieces: Number(pieces.toFixed(3)), liters: Number(liters.toFixed(3)), value: Number(value.toFixed(2)),
        products: [...products.entries()].map(([name, quantity]) => ({ name, quantity })).sort((a,b) => b.quantity - a.quantity),
        colours: [...colours.entries()].map(([name, quantity]) => ({ name, quantity })).sort((a,b) => b.quantity - a.quantity) };
    };
    return { year, sale: summarize(groups.sale), project: summarize(groups.project), waste: summarize(groups.waste), mixedStock: summarize(groups.mixed_stock) };
  }

  app.post("/admin/api/paint/bridge/history", async (req, res) => {
    if (!requireBridge(req, res)) return;
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 5000) : [];
      const result = await ingest(rows, req.body?.machine || "", { baseline: req.body?.baseline === true, createTasks: req.body?.createTasks !== false });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });

  app.get("/admin/api/paint/mix-history", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const status = clean(req.query.status || "open", 20).toLowerCase();
      const rows = await readJson(historyFile, []);
      const items = (Array.isArray(rows) ? rows : []).filter(row => status === "all" || String(row.status || "open") === status)
        .sort((a,b) => String(b.mixedAt || b.importedAt || "").localeCompare(String(a.mixedAt || a.importedAt || "")));
      res.json({ ok: true, items, count: items.length, status });
    } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });

  app.get("/admin/api/paint/mix-history/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const [state, rows] = await Promise.all([readJson(syncStateFile, {}), readJson(historyFile, [])]);
      const list = Array.isArray(rows) ? rows : [];
      res.json({ ok: true, state, open: list.filter(row => row.status === "open").length, total: list.length, schedule: "Mo-Fr 06:00-18:00 / 15 Minuten" });
    } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });

  app.post("/admin/api/paint/mix-history/:id/resolve", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await resolveMix(req.params.id, req.body || {});
      if (result.error) return res.status(result.statusCode || 400).json({ ok: false, ...result });
      res.status(result.statusCode || 200).json({ ok: true, ...result });
    } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });

  app.get("/admin/api/paint/sales-stats", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const year = /^20\d{2}$/.test(String(req.query.year || "")) ? String(req.query.year) : viennaDate().slice(0,4);
      const [movements, articles] = await Promise.all([readJsonl(movementsFile), readJson(articlesFile, [])]);
      res.json({ ok: true, ...aggregateStats(movements, articles, year) });
    } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });

  app.get("/admin/api/paint/job-materials", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const jobId = clean(req.query.jobId, 80);
      const rows = await readJsonl(jobMaterialsFile);
      const items = jobId ? rows.filter(row => String(row.jobId || "") === jobId) : rows;
      res.json({ ok: true, items, count: items.length });
    } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });
}

module.exports = { registerPaintMixHistory };
