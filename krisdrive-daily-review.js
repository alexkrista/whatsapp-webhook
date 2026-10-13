"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { isAlexander } = require("./kristine-user-access");
const PREFIX = "krisdrive-day-";
const fileFor = dir => path.join(dir, "_kristine", "vehicle-tracking", "daily-reviews.json");
async function read(dir) { try { const state = JSON.parse(await fs.readFile(fileFor(dir), "utf8")); if (!state.days || Array.isArray(state.days) || !Array.isArray(state.history)) throw Error("Invalid daily review storage"); return state; } catch (e) { if (e.code === "ENOENT") return { days: {}, history: [] }; throw e; } }
function signature(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows.map(row => Object.fromEntries([
    "vehicleId", "id", "startedAt", "closedAt", "driver", "category", "startLocation", "endLocation", "purpose", "odometerStartKm", "odometerEndKm", "distanceKm", "missing", "activity"
  ].map(key => [key, row[key] ?? null]))).sort((a,b) => `${a.vehicleId}:${a.id}`.localeCompare(`${b.vehicleId}:${b.id}`)))).digest("hex");
}
function task(row) {
  return { id: PREFIX + row.date, title: `Fahrtenbuch ${row.date} kontrollieren und freigeben`, assigneeId: row.assigneeId, assigneeName: row.assigneeName,
    creatorId: "krisdrive", creatorName: "KRISDRIVE", taskType: "Sonstiges", priority: "normal", dueDate: row.dueDate, createdAt: row.createdAt,
    status: row.status === "approved" ? "done" : "open", completedAt: row.status === "approved" ? row.approvedAt : null,
    reminder: `${row.count} Fahrten · ${row.open} zu ergänzen. Tagesfreigabe in KRISDRIVE.`, jobId: "", jobName: "", reviewDate: row.date };
}
async function mergeTasks(dir, tasks) { const state = await read(dir); return [...tasks.filter(t => !String(t.id).startsWith(PREFIX)), ...Object.values(state.days).filter(row => row.count > 0).map(task)]; }
function createDailyReview({ dataDir, collect, day, now = Date.now }) {
  let tail = Promise.resolve();
  function serialized(fn) { const work = tail.catch(() => {}).then(fn); tail = work; return work; }
  async function refresh(state) {
    const at = new Date(now()).toISOString(), today = day(now());
    const yesterday = day(Date.parse(today + "T12:00:00Z") - 86400000);
    state.startedOn ||= yesterday;
    const employees = JSON.parse(await fs.readFile(path.join(dataDir, "_system", "employees.json"), "utf8"));
    const alex = employees.filter(isAlexander);
    if (alex.length !== 1) throw Object.assign(Error("Alex ist im Mitarbeiterstamm nicht eindeutig zugeordnet."), { status: 409 });
    const grouped = new Map();
    for (const row of await collect()) {
      const date = day(row.startedAt);
      if (date >= today || date < state.startedOn || row.activity === "standstill") continue;
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date).push(row);
    }
    for (const [date, rows] of grouped) {
      const warnings = rows.filter(row => Date.parse(row.closedAt) <= Date.parse(row.startedAt) || rows.some(other => other.id !== row.id && other.vehicleId === row.vehicleId && other.startedAt < row.closedAt && other.closedAt > row.startedAt)).length;
      const fingerprint = signature(rows), old = state.days[date];
      const row = state.days[date] ||= { date, createdAt: at, dueDate: day(Date.parse(date + "T12:00:00Z") + 86400000), status: "open" };
      if (old?.status === "approved" && old.fingerprint !== fingerprint) { state.history.push({ date, type: "reopened", at, approvedAt: old.approvedAt }); row.status = "open"; }
      Object.assign(row, { assigneeId: String(alex[0].id || alex[0].employeeId), assigneeName: alex[0].nickname || alex[0].rufname || alex[0].name, fingerprint, warnings, snapshot: rows, count: rows.length, open: rows.filter(r => r.missing.length).length,
        vehicles: [...new Set(rows.map(r => r.vehicleId))], vehicleNames: Object.fromEntries(rows.map(r => [r.vehicleId, r.vehicleLabel || r.vehicleId])), updatedAt: at });
    }
    // Removed/moved trips must also invalidate a previous approval.
    for (const row of Object.values(state.days)) if (!grouped.has(row.date) && row.count) {
      if (row.status === "approved") state.history.push({ date: row.date, type: "reopened", at, approvedAt: row.approvedAt });
      Object.assign(row, { status: "open", count: 0, open: 0, fingerprint: signature([]), vehicles: [], updatedAt: at });
    }
    return state;
  }
  async function save(state) { const file = fileFor(dataDir), tmp = file + "." + crypto.randomUUID() + ".tmp"; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await fs.rename(tmp, file); }
  async function update() { return serialized(async () => { const state = await refresh(await read(dataDir)); await save(state); return Object.values(state.days).map(({snapshot, ...row}) => row).sort((a,b) => b.date.localeCompare(a.date)); }); }
  async function approve(date, fingerprint, actor) { return serialized(async () => {
    const state = await refresh(await read(dataDir)), row = state.days[date];
    const deny = (message, status = 409) => { throw Object.assign(Error(message), { status }); };
    if (!actor || !isAlexander(actor)) deny("Nur Alex darf das Tagesfahrtenbuch freigeben.", 403);
    if (!row || row.date >= day(now())) deny("Dieser Tag ist noch nicht abgeschlossen.");
    if (fingerprint !== row.fingerprint) deny("Die Fahrten wurden inzwischen geändert. Bitte neu laden und erneut prüfen.");
    if (row.open || !row.count) deny("Bitte zuerst die offenen Angaben in den Fahrten ergänzen.");
    if (row.status !== "approved") {
      Object.assign(row, { status: "approved", approvedAt: new Date(now()).toISOString(), approvedBy: String(actor.id || actor.employeeId), approvedName: actor.name || actor.nickname });
      state.history.push({ date, type: "approved", at: row.approvedAt, actorId: row.approvedBy, fingerprint: row.fingerprint, snapshot: structuredClone(row.snapshot) });
    }
    await save(state); return row;
  }); }
  return { update, approve };
}
module.exports = { createDailyReview, mergeTasks, signature, PREFIX };
