"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const ROOT = path.join(DATA_DIR, "_kristine");
const CONFIG_FILE = path.join(ROOT, "access-admin.json");
const STATUS_FILE = path.join(ROOT, "access-local-status.json");
const LEARN_FILE = path.join(ROOT, "access-chip-learn.json");
const LEARN_SECONDS = 120;

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
  const tmp = `${file}.tmp.multi`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tmp, file);
}
function nowIso(){ return new Date().toISOString(); }
function clean(value){ return String(value || "").trim(); }
function eventFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const hardwareId = clean(obj.hardwareId ?? obj.uid ?? obj.badgeId ?? obj.cardId ?? obj.ident ?? obj.transponder);
  const internalChipNo = clean(obj.internalChipNo ?? obj.chipNo ?? obj.chip);
  if (!hardwareId && !internalChipNo) return null;
  return {
    hardwareId,
    internalChipNo,
    legacyEmployeeNo: clean(obj.legacyEmployeeNo ?? obj.employeeNo ?? obj.personnelNo),
    legacyName: clean(obj.legacyName ?? obj.name ?? obj.personName),
    terminalId: clean(obj.terminalId ?? obj.terminal ?? obj.readerId ?? obj.reader),
    at: clean(obj.at ?? obj.time ?? obj.timestamp) || nowIso(),
  };
}
function eventKey(event) {
  return `${event.hardwareId || ""}|${event.internalChipNo || ""}|${event.terminalId || ""}|${event.at || ""}`;
}
function sameChip(a, b) {
  if (a?.hardwareId && b?.hardwareId && String(a.hardwareId) === String(b.hardwareId)) return true;
  return Boolean(a?.internalChipNo && b?.internalChipNo && String(a.internalChipNo) === String(b.internalChipNo));
}
async function ensureChip(event) {
  const cfg = await readJson(CONFIG_FILE, { version:2, groups:[], chips:[], history:[], syncQueue:[] });
  cfg.chips = Array.isArray(cfg.chips) ? cfg.chips : [];
  cfg.history = Array.isArray(cfg.history) ? cfg.history : [];
  let chip = event.hardwareId ? cfg.chips.find(c => String(c.hardwareId || "") === event.hardwareId) : null;
  if (!chip && event.internalChipNo) chip = cfg.chips.find(c => String(c.internalChipNo || "") === event.internalChipNo);
  let created = false;
  if (!chip) {
    created = true;
    const id = event.internalChipNo || `neu-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
    chip = {
      legacyEmployeeNo: event.legacyEmployeeNo || "",
      internalChipNo: id,
      hardwareId: event.hardwareId || "",
      legacyName: event.legacyName || "Unbekannter Chip",
      name: "",
      groupId: "1",
      status: "inactive",
      employeeId: "",
      employeeName: "",
      discoveredAt: nowIso(),
      updatedAt: null,
    };
    cfg.chips.push(chip);
    cfg.history.unshift({ at:nowIso(), type:"discover", actor:"GAT Leser", detail:`Neuer Chip erkannt: ${event.hardwareId || id} · sicher gesperrt angelegt` });
    cfg.history = cfg.history.slice(0, 500);
    cfg.revision = Number(cfg.revision || 0) + 1;
    await writeJson(CONFIG_FILE, cfg);
  }
  return { chip, created };
}
async function captureEvent(event) {
  const session = await readJson(LEARN_FILE, null);
  if (!session || session.state !== "waiting") return { matched:false, reason:"no_waiting_session" };
  const expires = Date.parse(session.expiresAt || "");
  if (!Number.isFinite(expires) || Date.now() > expires) {
    session.state = (session.results || []).length ? "done" : "expired";
    session.finishedAt = nowIso();
    await writeJson(LEARN_FILE, session);
    return { matched:false, reason:"expired", session };
  }
  const eventAt = Date.parse(event.at || "");
  const startedAt = Date.parse(session.startedAt || "");
  if (Number.isFinite(eventAt) && Number.isFinite(startedAt) && eventAt + 1000 < startedAt) return { matched:false, reason:"old_event" };
  if (session.terminalId && event.terminalId && String(session.terminalId) !== String(event.terminalId)) return { matched:false, reason:"wrong_terminal" };

  session.results = Array.isArray(session.results) ? session.results : [];
  session.eventKeys = Array.isArray(session.eventKeys) ? session.eventKeys : [];
  const key = eventKey(event);
  if (session.eventKeys.includes(key)) return { matched:true, duplicate:true, session };
  session.eventKeys.push(key);
  session.eventKeys = session.eventKeys.slice(-100);

  const { chip, created } = await ensureChip(event);
  const result = {
    internalChipNo: String(chip.internalChipNo || ""),
    hardwareId: String(chip.hardwareId || event.hardwareId || ""),
    legacyName: String(chip.legacyName || ""),
    name: String(chip.name || chip.employeeName || ""),
    created,
    terminalId: event.terminalId || "",
    at: event.at || nowIso(),
  };
  const existing = session.results.find(x => sameChip(x, result));
  if (!existing) session.results.push(result);
  else {
    existing.lastSeenAt = result.at;
    existing.scanCount = Number(existing.scanCount || 1) + 1;
  }
  session.lastEvent = event;
  session.lastFoundAt = nowIso();
  await writeJson(LEARN_FILE, session);
  return { matched:true, duplicate:Boolean(existing), session, result };
}
async function captureFromStatus(session) {
  if (!session || session.state !== "waiting") return session;
  const status = await readJson(STATUS_FILE, null);
  const candidates = [status?.gantner?.lastChipRead, status?.gantner?.lastEvent, status?.lastChipRead, status?.lastEvent];
  for (const raw of candidates) {
    const event = eventFromObject(raw);
    if (event) { await captureEvent(event); break; }
  }
  return await readJson(LEARN_FILE, session);
}

function installRoutes(app) {
  if (!app || app.__kristaAccessLearnMultiInstalled) return;
  app.__kristaAccessLearnMultiInstalled = true;

  app.post("/admin/api/access/learn/start", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const session = {
        id:`learn_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
        state:"waiting",
        startedAt:nowIso(),
        expiresAt:new Date(Date.now() + LEARN_SECONDS * 1000).toISOString(),
        terminalId:String(req.body?.terminalId || "3"),
        results:[],
        eventKeys:[],
      };
      await writeJson(LEARN_FILE, session);
      res.json({ ok:true, session, seconds:LEARN_SECONDS, multi:true });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  app.get("/admin/api/access/learn/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      let session = await readJson(LEARN_FILE, null);
      if (!session || String(session.id) !== String(req.params.id)) return res.status(404).json({ ok:false, error:"Einlesevorgang nicht gefunden" });
      if (session.state === "waiting") session = await captureFromStatus(session);
      if (session.state === "waiting" && Date.now() > Date.parse(session.expiresAt || "")) {
        session.state = (session.results || []).length ? "done" : "expired";
        session.finishedAt = nowIso();
        await writeJson(LEARN_FILE, session);
      }
      res.json({ ok:true, session, multi:true });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  app.post("/admin/api/access/learn/finish", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const session = await readJson(LEARN_FILE, null);
      if (!session || (req.body?.id && String(req.body.id) !== String(session.id))) return res.status(404).json({ ok:false, error:"Einlesevorgang nicht gefunden" });
      session.state = "done";
      session.finishedAt = nowIso();
      await writeJson(LEARN_FILE, session);
      res.json({ ok:true, session, multi:true });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  app.post("/admin/api/access/chip-read", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const event = eventFromObject(req.body || {});
      if (!event) return res.status(400).json({ ok:false, error:"hardwareId oder chipNo fehlt" });
      const out = await captureEvent(event);
      res.json({ ok:true, matchedLearnSession:out.matched, duplicate:Boolean(out.duplicate), session:out.session || null, count:(out.session?.results || []).length });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  console.log("KRISADMIN Chip-Sammeleinlesen aktiv · 120 Sekunden · mehrere Chips");
}

const expressPath = require.resolve("express"), originalExpress = require(expressPath);
function wrappedExpress(...args) {
  const app = originalExpress(...args), originalUse = app.use.bind(app); let inserted = false;
  app.use = function (...useArgs) {
    const result = originalUse(...useArgs);
    if (!inserted) { inserted = true; installRoutes(app); }
    return result;
  };
  return app;
}
Object.assign(wrappedExpress, originalExpress);
wrappedExpress.application = originalExpress.application;
wrappedExpress.request = originalExpress.request;
wrappedExpress.response = originalExpress.response;
require.cache[expressPath].exports = wrappedExpress;
module.exports = { installRoutes };
