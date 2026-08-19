"use strict";

const fsp = require("fs/promises");
const path = require("path");

function installTaskEscalation(app, { dataDir, requireAdmin, sendWhatsApp, readEmployees }) {
  if (!app || app.locals?.__kristaTaskEscalationInstalled) return;
  app.locals.__kristaTaskEscalationInstalled = true;

  const ROOT = path.join(dataDir, "_kristine");
  const TASKS = path.join(ROOT, "tasks.json");
  const ESCALATIONS = path.join(ROOT, "task-escalations.json");

  async function ensureRoot() {
    await fsp.mkdir(ROOT, { recursive: true });
  }

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); }
    catch { return fallback; }
  }

  async function writeJson(file, value) {
    await ensureRoot();
    await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  }

  function viennaParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
  }

  function localDateISO(date = new Date()) {
    const p = viennaParts(date);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function cleanLevel(value) {
    const level = Number(value);
    return level === 2 || level === 3 ? level : 1;
  }

  function employeePhone(employee) {
    return String(
      employee?.phone || employee?.phoneNumber || employee?.whatsapp || employee?.mobile || ""
    ).replace(/\D/g, "");
  }

  function taskLines(task, level) {
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(task?.dueDate || ""))
      ? String(task.dueDate).split("-").reverse().join(".")
      : "";
    const headline = level === 3
      ? "🚨 ESKALATION 3 · Aufgabe weiter offen"
      : "⚠️ Erinnerung · offene Aufgabe";
    return [
      headline,
      level === 3 ? "Diese Erinnerung kommt stündlich, bis die Aufgabe erledigt ist." : "Diese Aufgabe ist noch offen.",
      "",
      task?.title ? `*${task.title}*` : "Aufgabe",
      task?.jobName ? `🏗️ ${task.jobName}${task.jobId ? ` (#${task.jobId})` : ""}` : "",
      due ? `📅 Fällig: ${due}` : "",
      task?.reminder ? `ℹ️ ${task.reminder}` : "",
      "",
      "Bitte erledigen oder in KRISTINE rückmelden.",
    ].filter(Boolean);
  }

  function cadenceKey(level, now = new Date()) {
    const p = viennaParts(now);
    const hour = Number(p.hour);
    if (level === 2) {
      if (hour < 8 || hour >= 18) return "";
      return `daily:${p.year}-${p.month}-${p.day}`;
    }
    if (level === 3) {
      if (hour < 7 || hour >= 18) return "";
      return `hourly:${p.year}-${p.month}-${p.day}T${p.hour}`;
    }
    return "";
  }

  async function sendEscalation(task, employee, level) {
    const phone = employeePhone(employee);
    if (!phone) return { sent: false, reason: "no_employee_phone" };
    if (typeof sendWhatsApp !== "function") return { sent: false, reason: "whatsapp_not_configured" };
    try {
      await sendWhatsApp({
        to: phone,
        reply: taskLines(task, level).join("\n"),
        buttons: [
          ...(task.contactPhone ? [{ id: `task_call:${task.id}`, title: "Anrufen" }] : []),
          { id: `task_done:${task.id}`, title: "Erledigt" },
        ],
      });
      return { sent: true, phoneTail: phone.slice(-5) };
    } catch (error) {
      const message = String(error?.message || error);
      const reason = error?.metaCode === 131047 || /24.?hour|re-engagement|outside.*window/i.test(message)
        ? "outside_24h_window"
        : error?.metaCode ? `meta_${error.metaCode}` : message;
      return { sent: false, reason, detail: message };
    }
  }

  app.get("/kristine/api/task-escalations", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const escalations = await readJson(ESCALATIONS, {});
      res.json({ ok: true, escalations });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/kristine/api/task-escalations", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const taskId = String(req.body?.taskId || "").trim().slice(0, 180);
      const level = cleanLevel(req.body?.level);
      if (!taskId) return res.status(400).json({ ok: false, error: "Aufgabe fehlt." });
      const tasks = await readJson(TASKS, []);
      const task = tasks.find(row => String(row.id) === taskId);
      if (!task) return res.status(404).json({ ok: false, error: "Aufgabe nicht gefunden." });

      const escalations = await readJson(ESCALATIONS, {});
      const previous = escalations[taskId] || {};
      const changed = cleanLevel(previous.level) !== level;
      escalations[taskId] = {
        ...previous,
        taskId,
        level,
        updatedAt: new Date().toISOString(),
        ...(changed ? { lastAttemptKey: null, lastAttemptAt: null, lastResult: null } : {}),
      };
      await writeJson(ESCALATIONS, escalations);
      res.json({ ok: true, escalation: escalations[taskId], escalations });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  let running = false;
  async function escalationTick() {
    if (running) return;
    running = true;
    try {
      const [tasks, employees, escalations] = await Promise.all([
        readJson(TASKS, []),
        typeof readEmployees === "function" ? readEmployees().catch(() => []) : [],
        readJson(ESCALATIONS, {}),
      ]);
      const taskIds = new Set(tasks.map(task => String(task.id || "")).filter(Boolean));
      let dirty = false;

      for (const taskId of Object.keys(escalations)) {
        if (!taskIds.has(taskId)) {
          delete escalations[taskId];
          dirty = true;
        }
      }

      const employeeById = new Map((employees || []).map(employee => [String(employee.id || employee.employeeId || ""), employee]));
      for (const task of tasks) {
        if (!task || task.status === "done") continue;
        const taskId = String(task.id || "");
        const row = escalations[taskId];
        const level = cleanLevel(row?.level);
        if (level < 2) continue;
        const key = cadenceKey(level);
        if (!key || row?.lastAttemptKey === key) continue;

        const employee = employeeById.get(String(task.assigneeId || ""));
        const attemptedAt = new Date().toISOString();
        const result = employee
          ? await sendEscalation(task, employee, level)
          : { sent: false, reason: "employee_not_found" };

        escalations[taskId] = {
          ...(row || {}), taskId, level,
          lastAttemptKey: key,
          lastAttemptAt: attemptedAt,
          lastResult: result,
          ...(result.sent ? { lastSentAt: attemptedAt, lastSentDate: localDateISO() } : {}),
        };
        dirty = true;
        console.log(result.sent ? "✅ Aufgaben-Eskalation versendet" : "⚠️ Aufgaben-Eskalation nicht versendet", {
          taskId, level, assigneeId: task.assigneeId, reason: result.reason || null,
        });
      }

      if (dirty) await writeJson(ESCALATIONS, escalations);
    } catch (error) {
      console.error("Aufgaben-Eskalationsprüfung fehlgeschlagen:", error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(escalationTick, 60 * 1000);
  timer.unref?.();
  setTimeout(escalationTick, 12 * 1000).unref?.();

  console.log("✅ Aufgaben-Eskalation aktiv: Stufe 2 täglich · Stufe 3 stündlich 07–18 Uhr");
}

module.exports = { installTaskEscalation };
