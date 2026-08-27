"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const ROOT = path.join(DATA_DIR, "_kristine");
const CONFIG_FILE = path.join(ROOT, "access-admin.json");
const EVENTS_FILE = path.join(ROOT, "access-events.json");
const MAX_EVENTS = 1000;

function secureEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) { res.status(503).json({ ok:false, error:"ADMIN_TOKEN fehlt" }); return false; }
  const token = String(req.headers["x-admin-token"] || req.query?.token || "");
  if (!secureEqual(token, ADMIN_TOKEN)) { res.status(403).json({ ok:false, error:"Forbidden" }); return false; }
  return true;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive:true });
  const tmp = `${file}.tmp.access-events`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tmp, file);
}
function clean(v) { return String(v ?? "").trim(); }
function nowIso() { return new Date().toISOString(); }
function terminalName(id) {
  return ({ "1":"Haupteingang", "2":"Lager", "3":"Büro 1.OG" })[String(id || "")] || (id ? `Terminal ${id}` : "Leser");
}
function explicitOutcome(body) {
  if (body?.allowed === true || body?.granted === true || body?.accessGranted === true) return "allowed";
  if (body?.allowed === false || body?.granted === false || body?.accessGranted === false) return "denied";
  const raw = clean(body?.outcome ?? body?.result ?? body?.decision ?? body?.accessResult ?? body?.status).toLowerCase();
  if (/abgew|denied|deny|reject|blocked|gesperrt|kein zutritt|not allowed/.test(raw)) return "denied";
  if (/erlaubt|allowed|granted|zutritt ok|access ok|success|freigegeben/.test(raw)) return "allowed";
  return "";
}
async function buildEvent(body) {
  const hardwareId = clean(body?.hardwareId ?? body?.uid ?? body?.badgeId ?? body?.cardId ?? body?.ident ?? body?.transponder);
  const internalChipNo = clean(body?.internalChipNo ?? body?.chipNo ?? body?.chip);
  if (!hardwareId && !internalChipNo) return null;
  const terminalId = clean(body?.terminalId ?? body?.terminal ?? body?.readerId ?? body?.reader);
  const at = clean(body?.at ?? body?.time ?? body?.timestamp) || nowIso();
  const cfg = await readJson(CONFIG_FILE, { chips:[] });
  const chips = Array.isArray(cfg?.chips) ? cfg.chips : [];
  let chip = hardwareId ? chips.find(c => clean(c?.hardwareId) === hardwareId) : null;
  if (!chip && internalChipNo) chip = chips.find(c => clean(c?.internalChipNo) === internalChipNo);
  const outcome = explicitOutcome(body) || (!chip ? "unknown" : "read");
  const name = clean(chip?.name || chip?.employeeName || chip?.legacyName || body?.legacyName || body?.name || body?.personName) || (chip ? "Bekannter Chip" : "Unbekannter Chip");
  const reason = clean(body?.reason ?? body?.detail ?? body?.message);
  return {
    id:`evt_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    key:`${hardwareId}|${internalChipNo}|${terminalId}|${at}|${outcome}`,
    at, receivedAt:nowIso(), terminalId, terminalName:terminalName(terminalId),
    hardwareId:hardwareId || clean(chip?.hardwareId),
    internalChipNo:internalChipNo || clean(chip?.internalChipNo),
    name, outcome, reason,
  };
}
let writeChain = Promise.resolve();
function recordAccessEvent(body) {
  writeChain = writeChain.then(async () => {
    const event = await buildEvent(body);
    if (!event) return null;
    const store = await readJson(EVENTS_FILE, { events:[] });
    store.events = Array.isArray(store?.events) ? store.events : [];
    if (store.events.some(x => String(x?.key || "") === event.key)) return null;
    store.events.unshift(event);
    store.events = store.events.slice(0, MAX_EVENTS);
    store.updatedAt = nowIso();
    await writeJson(EVENTS_FILE, store);
    return event;
  });
  return writeChain;
}

const expressPath = require.resolve("express"), originalExpress = require(expressPath);
function wrappedExpress(...args) {
  const app = originalExpress(...args);

  // Eigener Lesekanal für die Zutritts-Historie.
  app.get("/admin/api/access/access-events", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const store = await readJson(EVENTS_FILE, { events:[] });
      const events = Array.isArray(store?.events) ? store.events : [];
      res.json({ ok:true, events:events.slice(0, 500), updatedAt:store?.updatedAt || null });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  // access-learn-multi registriert /chip-read später beim ersten app.use().
  // Wir wickeln genau diesen Handler ein und protokollieren den Leservorgang,
  // ohne den bestehenden Lern-/Zutrittsablauf zu verändern.
  const originalPost = app.post.bind(app);
  app.post = function(route, ...handlers) {
    if (String(route) === "/admin/api/access/chip-read") {
      handlers = handlers.map(handler => {
        if (typeof handler !== "function") return handler;
        return async function accessEventWrappedHandler(req, res, next) {
          try { await recordAccessEvent(req.body || {}); }
          catch (e) { console.warn("KRISADMIN Zutrittsprotokoll:", e?.message || e); }
          return handler(req, res, next);
        };
      });
    }
    return originalPost(route, ...handlers);
  };
  return app;
}
Object.assign(wrappedExpress, originalExpress);
wrappedExpress.application = originalExpress.application;
wrappedExpress.request = originalExpress.request;
wrappedExpress.response = originalExpress.response;
require.cache[expressPath].exports = wrappedExpress;
console.log("KRISADMIN Zutritts-Historie aktiv · Erlaubt / Abgewiesen / Unbekannt");
