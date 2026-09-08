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
const LEARN_SECONDS = 300;
const READ_JOB_FILE = path.join(ROOT, "access-manual-read.json");

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
function parseAccessEventTime(value) {
  const raw = clean(value);
  if (!raw) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return Date.parse(raw);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) return Date.parse(raw);
  const utcGuess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), Number(`0.${match[7] || "0"}`) * 1000);
  const offsetName = new Intl.DateTimeFormat("en", { timeZone:"Europe/Vienna", timeZoneName:"longOffset" })
    .formatToParts(new Date(utcGuess)).find(part => part.type === "timeZoneName")?.value || "GMT+00:00";
  const offset = offsetName.match(/GMT([+-])(\d{2}):(\d{2})/);
  const offsetMinutes = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  return utcGuess - offsetMinutes * 60000;
}
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
  if (!session || !["waiting", "reading"].includes(session.state)) return { matched:false, reason:"no_waiting_session" };
  const expires = Date.parse(session.expiresAt || "");
  if (!Number.isFinite(expires) || Date.now() > expires + 180000) {
    session.state = (session.results || []).length ? "done" : "expired";
    session.finishedAt = nowIso();
    await writeJson(LEARN_FILE, session);
    return { matched:false, reason:"expired", session };
  }
  const eventAt = parseAccessEventTime(event.at);
  const startedAt = Date.parse(session.startedAt || "");
  if (Number.isFinite(eventAt) && Number.isFinite(startedAt) && eventAt + 1000 < startedAt) return { matched:false, reason:"old_event" };
  if (Number.isFinite(eventAt) && eventAt > expires + 1000) return { matched:false, reason:"after_window" };
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
  let operations = Promise.resolve();
  function route(method, path, handler) {
    app[method](path, (req, res) => {
      const result = operations.then(() => handler(req, res));
      operations = result.catch(() => {});
      return result;
    });
  }

  route("post", "/admin/api/access/learn/start", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const active = await readJson(LEARN_FILE, null);
      if (active && ["waiting", "reading"].includes(active.state) && Date.now() < Date.parse(active.expiresAt) + 180000)
        return res.status(409).json({ok:false,error:"Einlesevorgang laeuft bereits"});
      const session = {
        localState:"queued",
        id:`learn_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
        state:"waiting",
        startedAt:nowIso(),
        expiresAt:new Date(Date.now() + LEARN_SECONDS * 1000).toISOString(),
        terminalId:"3",
        results:[],
        eventKeys:[],
      };
      await writeJson(LEARN_FILE, session);
      res.json({ ok:true, session, seconds:LEARN_SECONDS, multi:true });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  route("get", "/admin/api/access/learn/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      let session = await readJson(LEARN_FILE, null);
      if (!session || String(session.id) !== String(req.params.id)) return res.status(404).json({ ok:false, error:"Einlesevorgang nicht gefunden" });
      // Records arrive through the durable bridge queue, never from a stale status snapshot.
      if (session.state === "waiting" && Date.now() > Date.parse(session.expiresAt || "")) {
        session.state = "reading";
        await writeJson(LEARN_FILE, session);
      }
      res.json({ ok:true, session, multi:true });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  route("post", "/admin/api/access/learn/finish", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const session = await readJson(LEARN_FILE, null);
      if (!session || (req.body?.id && String(req.body.id) !== String(session.id))) return res.status(404).json({ ok:false, error:"Einlesevorgang nicht gefunden" });
      if (session.state === "waiting") session.state = "reading";
      session.expiresAt = new Date(Math.min(Date.now(), Date.parse(session.expiresAt))).toISOString();
      await writeJson(LEARN_FILE, session);
      res.json({ ok:true, session, multi:true });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  // This endpoint is polled in the cloud only. It never polls GAT hardware.
  route("get", "/admin/api/access/local-job", async (req, res) => {
    if (!requireAdmin(req,res)) return;
    try {
      const session = await readJson(LEARN_FILE, null);
      if (session && ["waiting", "reading"].includes(session.state)) {
        if (Date.now() > Date.parse(session.expiresAt) + 180000) {
          session.state="error"; session.error="Lokaler Abschluss nicht bestaetigt";
          await writeJson(LEARN_FILE,session);
        } else {
          const finishing=session.state==="reading" || Date.now() >= Date.parse(session.expiresAt);
          return res.json({ok:true,job:{id:session.id+(finishing?":finish":":read"),sessionId:session.id,
            type:finishing?"learn-finish":"learn-read",terminalId:session.terminalId || "3",expiresAt:session.expiresAt}});
        }
      }
      const read = await readJson(READ_JOB_FILE,null);
      res.json({ok:true,job:read?.state==="queued" ? read : null});
    } catch(e) {res.status(500).json({ok:false,error:String(e.message||e)});}
  });
  route("post", "/admin/api/access/bookings/read", async (req,res)=>{
    if (!requireAdmin(req,res)) return;
    try {
      const existing=await readJson(READ_JOB_FILE,null);
      if(existing?.state==="queued")return res.json({ok:true,job:existing});
      const job={id:"read_"+crypto.randomBytes(12).toString("hex"),type:"bookings-read",state:"queued",at:nowIso()};
      await writeJson(READ_JOB_FILE,job);res.json({ok:true,job});
    }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
  });
  route("get", "/admin/api/access/bookings/read", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    res.json({ok:true,job:await readJson(READ_JOB_FILE,null)});
  });
  route("post", "/admin/api/access/local-job/ack",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const job=req.body||{};
      if(job.type==="bookings-read"){
        const read=await readJson(READ_JOB_FILE,null);
        if(read?.id!==job.id)return res.status(409).json({ok:false,error:"Auftrag stimmt nicht ueberein"});
        Object.assign(read,{state:job.ok?"done":"error",result:job.result,error:job.error,finishedAt:nowIso()});
        await writeJson(READ_JOB_FILE,read);
      }else{
        const session=await readJson(LEARN_FILE,null);
        if(session?.id!==job.sessionId)return res.status(409).json({ok:false,error:"Einlesevorgang stimmt nicht ueberein"});
        if(!job.ok){session.state="error";session.error=job.error||"Lokaler Vorgang fehlgeschlagen";}
        else if(job.type==="learn-read"){session.localState="waiting";}
        else if(job.type==="learn-finish"){
          session.localState="complete";session.state="done";session.finishedAt=nowIso();session.read=job.result;
        }else return res.status(400).json({ok:false,error:"Unbekannte Aktion"});
        await writeJson(LEARN_FILE,session);
      }
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
  });

  route("post", "/admin/api/access/chip-read", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const event = eventFromObject(req.body || {});
      if (!event) return res.status(400).json({ ok:false, error:"hardwareId oder chipNo fehlt" });
      const out = await captureEvent(event);
      res.json({ ok:true, matchedLearnSession:out.matched, duplicate:Boolean(out.duplicate), session:out.session || null, count:(out.session?.results || []).length });
    } catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
  });

  console.log("KRISADMIN Chip-Sammeleinlesen aktiv · 300 Sekunden · mehrere Chips");
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
module.exports = { installRoutes, parseAccessEventTime };
