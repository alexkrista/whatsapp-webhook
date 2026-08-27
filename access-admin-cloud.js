"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const ROOT = path.join(DATA_DIR, "_kristine");
const SYSTEM = path.join(DATA_DIR, "_system");
const CONFIG_FILE = path.join(ROOT, "access-admin.json");
const STATUS_FILE = path.join(ROOT, "access-local-status.json");
const LEARN_FILE = path.join(ROOT, "access-chip-learn.json");
const HOLIDAYS_FILE = path.join(SYSTEM, "holidays.json");
const SEED = require("./access-clockwork-seed.js");
const EMPLOYEE_FILES = [path.join(ROOT, "employees.json"), path.join(SYSTEM, "employees.json")];
const PROFILE_IDS = new Set(["1", "2", "3", "4", "6"]);
const VERSION = "2026-08-27-access-admin-v2";
const LEARN_SECONDS = 90;
const MAX_SYNC_QUEUE = 500;

function secureEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    res.status(503).json({ ok: false, error: "ADMIN_TOKEN fehlt" });
    return false;
  }
  const token = String(req.headers["x-admin-token"] || req.query?.token || "");
  if (!secureEqual(token, ADMIN_TOKEN)) {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }
  return true;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tmp, file);
}
function unwrap(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}
function nowIso() { return new Date().toISOString(); }
function localDate() {
  const parts = new Intl.DateTimeFormat("de-AT", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function tokens(value) {
  const noise = new Set(["neu", "neue", "test", "uhr", "defekt", "reserve", "safe", "2020", "2026"]);
  return new Set(normalizeName(value).split(/\s+/).filter(x => x.length >= 3 && !noise.has(x) && x !== "ex")
    .map(x => x === "alex" ? "alexander" : x));
}
function nameScore(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit += 1;
  return hit / Math.max(A.size, B.size);
}
function employeeName(e) {
  return String(e?.name || e?.employeeName || [e?.firstName, e?.lastName].filter(Boolean).join(" ") || e?.displayName || "").trim();
}
function employeeId(e) {
  return String(e?.id || e?.employeeId || e?.personnelNumber || e?.personnelNo || e?.number || "").trim();
}
function employeeActive(e) {
  if (typeof e?.active === "boolean") return e.active;
  if (typeof e?.isActive === "boolean") return e.isActive;
  const status = normalizeName(e?.status || e?.employmentStatus || e?.state || "");
  if (/inaktiv|inactive|austritt|ausgetreten|archiv|terminated|left/.test(status)) return false;
  const end = String(e?.employmentEnd || e?.endDate || e?.exitDate || e?.austritt || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end <= localDate()) return false;
  return true;
}
async function readEmployees() {
  const map = new Map();
  for (const file of EMPLOYEE_FILES) {
    const raw = await readJson(file, []);
    for (const row of unwrap(raw, ["employees", "rows", "items"])) {
      const id = employeeId(row), name = employeeName(row);
      if (!id && !name) continue;
      const key = id || normalizeName(name);
      map.set(key, { ...map.get(key), ...row });
    }
  }
  return [...map.values()].map(row => ({ id: employeeId(row), name: employeeName(row), active: employeeActive(row) }))
    .filter(x => x.id || x.name).sort((a, b) => a.name.localeCompare(b.name, "de"));
}
function appendHistory(cfg, row) {
  cfg.history = Array.isArray(cfg.history) ? cfg.history : [];
  cfg.history.unshift({ at: nowIso(), ...row });
  cfg.history = cfg.history.slice(0, 500);
}
function defaultGroupRules(group) {
  const p = group.legacyTimeplans || {};
  return { terminals: { "1": String(p["1"] || "1"), "2": String(p["2"] || "1"), "3": String(p["3"] || "1") } };
}
function normalizeStatus(value, fallback = "inactive") {
  const v = String(value || "").toLowerCase();
  return ["active", "reserve", "inactive", "lost"].includes(v) ? v : fallback;
}
function entityKey(entity) {
  return `${String(entity?.type || "all")}:${String(entity?.id || "all")}`;
}
function migrateQueue(cfg) {
  cfg.syncQueue = Array.isArray(cfg.syncQueue) ? cfg.syncQueue.filter(Boolean) : [];
  if (cfg.pendingSync && cfg.syncQueue.length === 0) cfg.syncQueue.push(cfg.pendingSync);
  cfg.syncQueue = cfg.syncQueue.slice(-MAX_SYNC_QUEUE);
  cfg.pendingSync = cfg.syncQueue[0] || null;
}
async function seedConfig() {
  const seed = {
    source: SEED.source,
    profileCatalog: SEED.profileCatalog || {},
    groups: (SEED.groups || []).map(r => ({
      id: String(r[0]), name: String(r[1]),
      legacyTimeplans: { "1": String(r[2]), "2": String(r[3]), "3": String(r[4]) }
    })),
    chips: (SEED.chips || []).map(r => ({
      legacyEmployeeNo: String(r[0]), internalChipNo: String(r[1]), hardwareId: String(r[2]),
      legacyName: String(r[3]), name: "", groupId: String(r[4]), status: String(r[5]),
      employeeId: "", employeeName: ""
    }))
  };
  const cfg = {
    version: 2,
    source: seed.source || "clockWORK",
    importedAt: nowIso(),
    lastImportAt: null,
    revision: 1,
    hardwareWriteEnabled: false,
    profileCatalog: seed.profileCatalog || {},
    groups: seed.groups.map(g => ({ ...g, rules: defaultGroupRules(g) })),
    chips: seed.chips.map(c => ({ ...c, updatedAt: null, discoveredAt: null })),
    syncQueue: [], pendingSync: null, history: []
  };
  appendHistory(cfg, { type: "import", actor: "System", detail: `clockWORK-Import: ${cfg.chips.length} Chips · ${cfg.groups.length} Gruppen` });
  await writeJson(CONFIG_FILE, cfg);
  return cfg;
}
async function readConfig() {
  let cfg = await readJson(CONFIG_FILE, null);
  if (!cfg) return seedConfig();
  cfg.version = Math.max(2, Number(cfg.version || 1));
  cfg.groups = Array.isArray(cfg.groups) ? cfg.groups : [];
  cfg.chips = Array.isArray(cfg.chips) ? cfg.chips : [];
  cfg.history = Array.isArray(cfg.history) ? cfg.history : [];
  cfg.profileCatalog = cfg.profileCatalog || SEED.profileCatalog || {};
  for (const g of cfg.groups) if (!g.rules) g.rules = defaultGroupRules(g);
  for (const c of cfg.chips) {
    if (typeof c.name !== "string") c.name = "";
    if (!c.status) c.status = "inactive";
  }
  migrateQueue(cfg);
  return cfg;
}
async function saveConfig(cfg) {
  cfg.revision = Number(cfg.revision || 0) + 1;
  migrateQueue(cfg);
  await writeJson(CONFIG_FILE, cfg);
  return cfg;
}
function queueSync(cfg, reason, entity) {
  migrateQueue(cfg);
  const key = entityKey(entity);
  const existing = cfg.syncQueue.find(x => entityKey(x.entity) === key && !["done", "cancelled"].includes(String(x.state || "")));
  const item = {
    id: existing?.id || `sync_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    requestedAt: nowIso(), reason: String(reason || "Änderung"), entity: entity || { type: "all" },
    revision: Number(cfg.revision || 0) + 1, state: "waiting_for_local_bridge", error: ""
  };
  if (existing) Object.assign(existing, item);
  else cfg.syncQueue.push(item);
  cfg.syncQueue = cfg.syncQueue.slice(-MAX_SYNC_QUEUE);
  cfg.pendingSync = cfg.syncQueue[0] || null;
  return item;
}
function hasPendingEntity(cfg, type, id) {
  migrateQueue(cfg);
  return cfg.syncQueue.some(x => {
    const e = x.entity || {};
    return (String(e.type) === "all") || (String(e.type) === String(type) && String(e.id) === String(id));
  });
}
function effectiveChip(chip, groups, employees) {
  const group = groups.find(g => String(g.id) === String(chip.groupId)) || null;
  const employee = chip.employeeId ? employees.find(e => String(e.id) === String(chip.employeeId)) : null;
  let suggestion = null;
  if (!employee && !chip.employeeId && chip.legacyName) {
    const ranked = employees.map(e => ({ e, score: nameScore(chip.legacyName, e.name) }))
      .filter(x => x.score >= 0.66).sort((a, b) => b.score - a.score);
    if (ranked.length === 1 || ranked[0]?.score > ranked[1]?.score) suggestion = ranked[0]?.e || null;
  }
  const terminalProfiles = group?.rules?.terminals || group?.legacyTimeplans || {};
  const groupAllows = Object.values(terminalProfiles).some(v => String(v) !== "1");
  const chipState = String(chip.status || "inactive");
  const blockedByEmployee = Boolean(employee && employee.active === false);
  const effectiveAllowed = chipState === "active" && groupAllows && !blockedByEmployee;
  const displayName = String(chip.name || chip.employeeName || chip.legacyName || "Ohne Name");
  return {
    ...chip, displayName, groupName: group?.name || "?", employee: employee || null,
    suggestedEmployee: suggestion, effectiveAllowed, blockedByEmployee, groupAllows
  };
}
async function holidayInfo() {
  const raw = await readJson(HOLIDAYS_FILE, []), rows = unwrap(raw, ["holidays", "rows", "items"]), today = localDate();
  const future = rows.map(x => String(x?.date || x?.day || "").slice(0, 10))
    .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x) && x >= today).sort();
  return { count: rows.length, next: future[0] || null, source: "KRISTINE / _system/holidays.json" };
}
function bridgeInfo(status) {
  const received = Date.parse(status?.receivedAt || "");
  const ageSeconds = Number.isFinite(received) ? Math.max(0, Math.round((Date.now() - received) / 1000)) : null;
  return {
    online: ageSeconds !== null && ageSeconds <= 45,
    ageSeconds,
    syncVersion: String(status?.gantner?.syncVersion || status?.accessSyncVersion || ""),
    lastChipReadAt: String(status?.gantner?.lastChipRead?.at || status?.gantner?.lastEvent?.at || status?.lastChipRead?.at || "")
  };
}
async function bootstrapPayload() {
  const [cfg, employees, holidays, status] = await Promise.all([
    readConfig(), readEmployees(), holidayInfo(), readJson(STATUS_FILE, null)
  ]);
  const groups = cfg.groups.map(g => ({ ...g, rules: g.rules || defaultGroupRules(g) }));
  migrateQueue(cfg);
  return {
    ok: true, version: VERSION, revision: cfg.revision, hardwareWriteEnabled: cfg.hardwareWriteEnabled === true,
    source: cfg.source, profileCatalog: cfg.profileCatalog || {}, groups,
    chips: cfg.chips.map(c => effectiveChip(c, groups, employees)), employees, holidays,
    history: cfg.history.slice(0, 150), pendingSync: cfg.pendingSync || null,
    syncQueue: cfg.syncQueue.slice(0, 100), syncQueueCount: cfg.syncQueue.length,
    lastImportAt: cfg.lastImportAt || cfg.importedAt || null,
    accessStatus: status, bridge: bridgeInfo(status)
  };
}
function pageRedirect(req, res) {
  const token = String(req.query?.token || "");
  res.redirect(302, `/public/access-admin.html${token ? `?token=${encodeURIComponent(token)}` : ""}`);
}
function cleanChipName(value) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80); }
function normalizeImportedChip(row) {
  return {
    internalChipNo: String(row?.internalChipNo ?? row?.chipNo ?? row?.chip ?? row?.cardNo ?? "").trim(),
    hardwareId: String(row?.hardwareId ?? row?.uid ?? row?.badgeId ?? row?.cardId ?? row?.ident ?? "").trim(),
    legacyEmployeeNo: String(row?.legacyEmployeeNo ?? row?.employeeNo ?? row?.personnelNo ?? row?.personalNo ?? "").trim(),
    legacyName: cleanChipName(row?.legacyName ?? row?.name ?? row?.personName ?? ""),
    groupId: String(row?.groupId ?? row?.group ?? "").trim(),
    status: normalizeStatus(row?.status, "active")
  };
}
function normalizeImportedGroup(row) {
  const raw = row?.rules?.terminals || row?.terminals || row?.legacyTimeplans || {};
  return {
    id: String(row?.id ?? row?.groupId ?? "").trim(),
    name: cleanChipName(row?.name ?? row?.groupName ?? ""),
    terminals: { "1": String(raw["1"] || "1"), "2": String(raw["2"] || "1"), "3": String(raw["3"] || "1") }
  };
}
function same(a, b) { return String(a ?? "") === String(b ?? ""); }
async function importSnapshot(payload, actor = "Lokale Bridge") {
  const cfg = await readConfig();
  const rows = Array.isArray(payload?.chips) ? payload.chips.map(normalizeImportedChip) : [];
  const groups = Array.isArray(payload?.groups) ? payload.groups.map(normalizeImportedGroup) : [];
  let added = 0, changed = 0, groupChanges = 0;

  for (const incoming of groups) {
    if (!incoming.id) continue;
    let group = cfg.groups.find(g => String(g.id) === incoming.id);
    if (!group) {
      group = { id: incoming.id, name: incoming.name || `Gruppe ${incoming.id}`, legacyTimeplans: { ...incoming.terminals }, rules: { terminals: { ...incoming.terminals } } };
      cfg.groups.push(group); groupChanges += 1;
      continue;
    }
    if (hasPendingEntity(cfg, "group", incoming.id)) continue;
    let touched = false;
    if (incoming.name && group.name !== incoming.name) { group.name = incoming.name; touched = true; }
    for (const t of ["1", "2", "3"]) {
      if (!PROFILE_IDS.has(String(incoming.terminals[t]))) continue;
      group.rules = group.rules || defaultGroupRules(group);
      group.rules.terminals = group.rules.terminals || {};
      if (!same(group.rules.terminals[t], incoming.terminals[t])) { group.rules.terminals[t] = incoming.terminals[t]; touched = true; }
    }
    if (touched) groupChanges += 1;
  }

  for (const incoming of rows) {
    if (!incoming.hardwareId && !incoming.internalChipNo) continue;
    let chip = incoming.hardwareId ? cfg.chips.find(c => String(c.hardwareId) === incoming.hardwareId) : null;
    if (!chip && incoming.internalChipNo) chip = cfg.chips.find(c => String(c.internalChipNo) === incoming.internalChipNo);
    if (!chip) {
      const id = incoming.internalChipNo || `neu-${Date.now()}-${added + 1}`;
      cfg.chips.push({
        legacyEmployeeNo: incoming.legacyEmployeeNo, internalChipNo: id, hardwareId: incoming.hardwareId,
        legacyName: incoming.legacyName || "Unbekannter Chip", name: "", groupId: "1", status: "inactive",
        employeeId: "", employeeName: "", discoveredAt: nowIso(), updatedAt: null
      });
      added += 1;
      appendHistory(cfg, { type: "discover", actor, detail: `Neuer Chip erkannt: ${incoming.hardwareId || id} · sicher gesperrt angelegt` });
      continue;
    }
    const pending = hasPendingEntity(cfg, "chip", chip.internalChipNo);
    let touched = false;
    for (const key of ["hardwareId", "legacyEmployeeNo", "legacyName"]) {
      if (incoming[key] && !same(chip[key], incoming[key])) { chip[key] = incoming[key]; touched = true; }
    }
    if (!pending) {
      if (incoming.groupId && cfg.groups.some(g => String(g.id) === incoming.groupId) && !same(chip.groupId, incoming.groupId)) {
        chip.groupId = incoming.groupId; touched = true;
      }
      if (incoming.status && !same(chip.status, incoming.status)) { chip.status = incoming.status; touched = true; }
    }
    if (touched) { chip.importedAt = nowIso(); changed += 1; }
  }
  cfg.lastImportAt = String(payload?.sourceAt || nowIso());
  cfg.source = String(payload?.source || cfg.source || "clockWORK");
  if (added || changed || groupChanges) appendHistory(cfg, {
    type: "import", actor,
    detail: `Auto-Einlesen: ${added} neu · ${changed} Chips geändert · ${groupChanges} Gruppen geändert`
  });
  await saveConfig(cfg);
  return { cfg, added, changed, groupChanges };
}
function eventFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const hardwareId = String(obj.hardwareId ?? obj.uid ?? obj.badgeId ?? obj.cardId ?? obj.ident ?? obj.transponder ?? "").trim();
  const internalChipNo = String(obj.internalChipNo ?? obj.chipNo ?? obj.chip ?? "").trim();
  if (!hardwareId && !internalChipNo) return null;
  return {
    hardwareId, internalChipNo,
    legacyEmployeeNo: String(obj.legacyEmployeeNo ?? obj.employeeNo ?? obj.personnelNo ?? "").trim(),
    legacyName: cleanChipName(obj.legacyName ?? obj.name ?? obj.personName ?? ""),
    terminalId: String(obj.terminalId ?? obj.terminal ?? obj.readerId ?? obj.reader ?? "").trim(),
    at: String(obj.at ?? obj.time ?? obj.timestamp ?? nowIso())
  };
}
function chipEventFromStatus(status) {
  const candidates = [
    status?.gantner?.lastChipRead, status?.gantner?.lastEvent, status?.gantner?.event,
    status?.lastChipRead, status?.lastEvent
  ];
  for (const candidate of candidates) {
    const event = eventFromObject(candidate);
    if (event) return event;
  }
  return null;
}
async function ensureChipForRead(event, actor = "GAT Leser") {
  const cfg = await readConfig();
  let chip = event.hardwareId ? cfg.chips.find(c => String(c.hardwareId) === String(event.hardwareId)) : null;
  if (!chip && event.internalChipNo) chip = cfg.chips.find(c => String(c.internalChipNo) === String(event.internalChipNo));
  let created = false;
  if (!chip) {
    const id = event.internalChipNo || `neu-${Date.now()}`;
    chip = {
      legacyEmployeeNo: event.legacyEmployeeNo || "", internalChipNo: id, hardwareId: event.hardwareId || "",
      legacyName: event.legacyName || "Unbekannter Chip", name: "", groupId: "1", status: "inactive",
      employeeId: "", employeeName: "", discoveredAt: nowIso(), updatedAt: null
    };
    cfg.chips.push(chip); created = true;
    appendHistory(cfg, { type: "discover", actor, detail: `Chip ${event.hardwareId || id} am Leser erkannt · sicher gesperrt angelegt` });
    await saveConfig(cfg);
  }
  return { chip, created };
}
async function resolveLearnWithEvent(event) {
  const learn = await readJson(LEARN_FILE, null);
  if (!learn || learn.state !== "waiting") return { matched: false, reason: "no_waiting_session" };
  const expires = Date.parse(learn.expiresAt || "");
  if (!Number.isFinite(expires) || Date.now() > expires) {
    learn.state = "expired"; learn.finishedAt = nowIso(); await writeJson(LEARN_FILE, learn);
    return { matched: false, reason: "expired" };
  }
  const eventAt = Date.parse(event.at || "");
  const startedAt = Date.parse(learn.startedAt || "");
  if (Number.isFinite(eventAt) && Number.isFinite(startedAt) && eventAt + 1000 < startedAt) return { matched: false, reason: "old_event" };
  if (learn.terminalId && event.terminalId && String(learn.terminalId) !== String(event.terminalId)) return { matched: false, reason: "wrong_terminal" };
  const { chip, created } = await ensureChipForRead(event);
  Object.assign(learn, {
    state: "found", finishedAt: nowIso(), created,
    result: { internalChipNo: chip.internalChipNo, hardwareId: chip.hardwareId, legacyName: chip.legacyName || "", name: chip.name || "" },
    event
  });
  await writeJson(LEARN_FILE, learn);
  return { matched: true, learn, chip, created };
}
async function refreshLearnFromStatus(learn) {
  if (!learn || learn.state !== "waiting") return learn;
  const status = await readJson(STATUS_FILE, null);
  const event = chipEventFromStatus(status);
  if (event) await resolveLearnWithEvent(event);
  return await readJson(LEARN_FILE, learn);
}

function installRoutes(app) {
  if (!app || app.__kristaAccessAdminInstalled) return;
  app.__kristaAccessAdminInstalled = true;

  app.get("/admin/access", (req, res) => { if (!requireAdmin(req, res)) return; pageRedirect(req, res); });
  app.get("/admin/api/access/bootstrap", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await bootstrapPayload()); } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.put("/admin/api/access/chips/:chipNo", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const cfg = await readConfig();
      const chip = cfg.chips.find(x => String(x.internalChipNo) === String(req.params.chipNo));
      if (!chip) return res.status(404).json({ ok: false, error: "Chip nicht gefunden" });
      const before = { name: chip.name || "", groupId: chip.groupId, status: chip.status, employeeId: chip.employeeId, employeeName: chip.employeeName };
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "name")) chip.name = cleanChipName(req.body.name);
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "groupId")) {
        const gid = String(req.body.groupId || "");
        if (!cfg.groups.some(g => String(g.id) === gid)) return res.status(400).json({ ok: false, error: "Gruppe unbekannt" });
        chip.groupId = gid;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "status")) {
        const status = String(req.body.status || "");
        if (!["active", "reserve", "inactive", "lost"].includes(status)) return res.status(400).json({ ok: false, error: "Status ungültig" });
        chip.status = status;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "employeeId")) {
        const employees = await readEmployees();
        const eid = String(req.body.employeeId || "");
        const emp = eid ? employees.find(e => String(e.id) === eid) : null;
        chip.employeeId = eid; chip.employeeName = emp?.name || "";
      }
      chip.updatedAt = nowIso();
      const label = chip.name || chip.employeeName || chip.legacyName || chip.internalChipNo;
      appendHistory(cfg, {
        type: "chip", actor: "KRISADMIN",
        detail: `Chip ${chip.internalChipNo} · ${label}: ${before.groupId}/${before.status} → ${chip.groupId}/${chip.status}` +
          (before.name !== (chip.name || "") ? ` · Name: ${before.name || chip.legacyName || "—"} → ${chip.name || "—"}` : "")
      });
      queueSync(cfg, "Chip geändert", { type: "chip", id: String(chip.internalChipNo) });
      await saveConfig(cfg);
      res.json({ ok: true, chip, pendingSync: cfg.pendingSync, syncQueueCount: cfg.syncQueue.length });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.put("/admin/api/access/groups/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const cfg = await readConfig();
      const group = cfg.groups.find(x => String(x.id) === String(req.params.id));
      if (!group) return res.status(404).json({ ok: false, error: "Gruppe nicht gefunden" });
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "name")) group.name = cleanChipName(req.body.name) || group.name;
      const terminals = req.body?.terminals;
      if (terminals && typeof terminals === "object") {
        group.rules = group.rules || defaultGroupRules(group); group.rules.terminals = group.rules.terminals || {};
        for (const term of ["1", "2", "3"]) {
          if (!Object.prototype.hasOwnProperty.call(terminals, term)) continue;
          const p = String(terminals[term]);
          if (!PROFILE_IDS.has(p)) return res.status(400).json({ ok: false, error: `Zeitprofil ${p} nicht freigegeben` });
          group.rules.terminals[term] = p;
        }
      }
      appendHistory(cfg, { type: "group", actor: "KRISADMIN", detail: `Gruppe ${group.id} · ${group.name} geändert` });
      queueSync(cfg, "Gruppe geändert", { type: "group", id: String(group.id) });
      await saveConfig(cfg);
      res.json({ ok: true, group, pendingSync: cfg.pendingSync, syncQueueCount: cfg.syncQueue.length });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post("/admin/api/access/sync/request", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const cfg = await readConfig();
      queueSync(cfg, "Manuelle Synchronisierung", { type: "all", id: "all" });
      appendHistory(cfg, { type: "sync", actor: "KRISADMIN", detail: "GAT-Synchronisierung angefordert" });
      await saveConfig(cfg);
      res.json({ ok: true, pendingSync: cfg.pendingSync, syncQueueCount: cfg.syncQueue.length, hardwareWriteEnabled: cfg.hardwareWriteEnabled === true });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.get("/admin/api/access/pending", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const p = await bootstrapPayload();
      res.json({
        ok: true, revision: p.revision, pendingSync: p.pendingSync, syncQueue: p.syncQueue,
        syncQueueCount: p.syncQueueCount, hardwareWriteEnabled: p.hardwareWriteEnabled,
        groups: p.groups,
        chips: p.chips.map(c => ({
          internalChipNo: c.internalChipNo, legacyEmployeeNo: c.legacyEmployeeNo, hardwareId: c.hardwareId,
          legacyName: c.legacyName, name: c.name || "", displayName: c.displayName,
          groupId: c.groupId, status: c.status, employeeId: c.employeeId, employeeName: c.employeeName,
          effectiveAllowed: c.effectiveAllowed, blockedByEmployee: c.blockedByEmployee
        })), holidays: p.holidays
      });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post("/admin/api/access/sync/ack", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const cfg = await readConfig(); migrateQueue(cfg);
      const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String));
      const ok = req.body?.ok !== false;
      const error = String(req.body?.error || "").slice(0, 1000);
      let affected = 0;
      if (ok) {
        const before = cfg.syncQueue.length;
        cfg.syncQueue = ids.size ? cfg.syncQueue.filter(x => !ids.has(String(x.id))) : [];
        affected = before - cfg.syncQueue.length;
        if (affected) appendHistory(cfg, { type: "sync", actor: "Lokale Bridge", detail: `GAT synchronisiert · ${affected} Änderung(en)` });
      } else {
        for (const item of cfg.syncQueue) {
          if (!ids.size || ids.has(String(item.id))) { item.state = "error"; item.error = error || "Lokaler Sync fehlgeschlagen"; item.lastTriedAt = nowIso(); affected += 1; }
        }
        appendHistory(cfg, { type: "sync", actor: "Lokale Bridge", detail: `GAT-Sync Fehler: ${error || "unbekannt"}` });
      }
      cfg.lastSyncAt = nowIso(); cfg.pendingSync = cfg.syncQueue[0] || null;
      await saveConfig(cfg);
      res.json({ ok: true, affected, syncQueueCount: cfg.syncQueue.length, pendingSync: cfg.pendingSync });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post("/admin/api/access/import", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const out = await importSnapshot(req.body || {}, "Lokale clockWORK-Bridge");
      res.json({ ok: true, added: out.added, changed: out.changed, groupChanges: out.groupChanges, revision: out.cfg.revision });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post("/admin/api/access/learn/start", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const startedAt = nowIso();
      const session = {
        id: `learn_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
        state: "waiting", startedAt,
        expiresAt: new Date(Date.now() + LEARN_SECONDS * 1000).toISOString(),
        terminalId: String(req.body?.terminalId || "3"), result: null
      };
      await writeJson(LEARN_FILE, session);
      res.json({ ok: true, session, seconds: LEARN_SECONDS });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.get("/admin/api/access/learn/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      let learn = await readJson(LEARN_FILE, null);
      if (!learn || String(learn.id) !== String(req.params.id)) return res.status(404).json({ ok: false, error: "Einlesevorgang nicht gefunden" });
      if (learn.state === "waiting" && Date.now() > Date.parse(learn.expiresAt || "")) {
        learn.state = "expired"; learn.finishedAt = nowIso(); await writeJson(LEARN_FILE, learn);
      } else if (learn.state === "waiting") learn = await refreshLearnFromStatus(learn);
      res.json({ ok: true, session: learn });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post("/admin/api/access/learn/cancel", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const learn = await readJson(LEARN_FILE, null);
      if (learn && (!req.body?.id || String(req.body.id) === String(learn.id))) {
        learn.state = "cancelled"; learn.finishedAt = nowIso(); await writeJson(LEARN_FILE, learn);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post("/admin/api/access/chip-read", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const event = eventFromObject(req.body || {});
      if (!event) return res.status(400).json({ ok: false, error: "hardwareId oder chipNo fehlt" });
      const result = await resolveLearnWithEvent(event);
      res.json({ ok: true, matchedLearnSession: result.matched, reason: result.reason || "", session: result.learn || null });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  console.log("KRISADMIN Zutritt V2 aktiv · 30s Sync-Protokoll + Chip-Lernmodus");
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
