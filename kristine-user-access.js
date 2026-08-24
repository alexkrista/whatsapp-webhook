"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function employeeId(employee) {
  return String(employee?.id || employee?.employeeId || "").trim();
}

function employeeName(employee) {
  return String(employee?.nickname || employee?.rufname || employee?.name || employee?.employeeName || employeeId(employee) || "Benutzer").trim();
}

function isAlexander(employee) {
  const text = normalizeName([
    employee?.nickname,
    employee?.rufname,
    employee?.firstName,
    employee?.vorname,
    employee?.name,
    employee?.employeeName,
  ].filter(Boolean).join(" "));
  return /(^| )(alex|alexander)( |$)/.test(text) && (/krista/.test(text) || text === "alex" || text === "alexander");
}

function financeTask(task) {
  return String(task?.creatorId || "") === "brain-finance" || String(task?.reminder || "").includes("[FINANCE_APPROVAL]");
}

function comparableFinanceTask(task) {
  const keys = [
    "id", "title", "assigneeId", "assigneeName", "jobId", "jobName", "taskType", "priority",
    "creatorId", "creatorName", "address", "contactName", "contactPhone", "contactEmail",
    "dueDate", "reminder", "status", "createdAt", "completedAt",
  ];
  return Object.fromEntries(keys.map((key) => [key, task?.[key] ?? null]));
}

function registerKristineUserAccess(app, { dataDir, requireAdmin, readEmployees }) {
  const root = path.join(dataDir, "_kristine");
  const accessFile = path.join(root, "user-access.json");
  const tasksFile = path.join(root, "tasks.json");

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); }
    catch { return fallback; }
  }

  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  }

  async function employees() {
    return typeof readEmployees === "function" ? (await readEmployees().catch(() => [])) : [];
  }

  function defaultPermissions(role, alex, employee = {}) {
    return {
      taskViewAll: true,
      taskCreate: true,
      planningEdit: alex || role === "office",
      employeeAdmin: alex,
      brainAccess: alex || employee.brainAccess === true || employee.canUseBrain === true,
      userAdmin: alex,
      financeApproval: alex,
    };
  }

  function cleanPermissions(source, role, alex, employee = {}) {
    const defaults = defaultPermissions(role, alex, employee);
    const clean = { ...defaults };
    for (const key of ["taskViewAll", "taskCreate", "planningEdit", "employeeAdmin", "brainAccess"]) {
      if (typeof source?.[key] === "boolean") clean[key] = source[key];
    }
    if (alex) {
      clean.userAdmin = true;
      clean.financeApproval = true;
      clean.employeeAdmin = true;
    } else {
      clean.userAdmin = false;
      clean.financeApproval = false;
    }
    return clean;
  }

  async function snapshot() {
    const [stored, people] = await Promise.all([readJson(accessFile, { users: {} }), employees()]);
    const users = (people || [])
      .filter((employee) => employee && employee.active !== false && employeeId(employee))
      .map((employee) => {
        const id = employeeId(employee);
        const alex = isAlexander(employee);
        const saved = stored?.users?.[id] || {};
        const role = alex ? "admin" : (["office", "user"].includes(String(saved.role || "")) ? String(saved.role) : "user");
        return {
          employeeId: id,
          employeeName: employeeName(employee),
          role,
          isAlexander: alex,
          permissions: cleanPermissions(saved.permissions, role, alex, employee),
        };
      })
      .sort((a, b) => (b.isAlexander - a.isAlexander) || a.employeeName.localeCompare(b.employeeName, "de"));
    return { version: 1, users, updatedAt: stored?.updatedAt || null, updatedBy: stored?.updatedBy || "" };
  }

  async function actorFromRequest(req) {
    const actorId = String(req.headers["x-krista-user-id"] || req.body?.actorId || req.query?.actorId || "").trim();
    if (!actorId) return null;
    return (await employees()).find((employee) => employeeId(employee) === actorId) || null;
  }

  async function requireAlexander(req, res) {
    if (!requireAdmin(req, res)) return null;
    const actor = await actorFromRequest(req);
    if (!actor || !isAlexander(actor)) {
      res.status(403).json({ ok: false, error: "Benutzer und Rechte dürfen nur von Alexander geändert werden." });
      return null;
    }
    return actor;
  }

  app.use("/kristine/api/tasks", async (req, res, next) => {
    if (String(req.method || "").toUpperCase() !== "PUT") return next();
    try {
      const incoming = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
      const previous = await readJson(tasksFile, []);
      const previousFinance = previous.filter(financeTask);
      const incomingFinance = incoming.filter(financeTask);
      const incomingById = new Map(incomingFinance.map((task) => [String(task.id || ""), task]));
      let financeChanged = previousFinance.length !== incomingFinance.length;
      if (!financeChanged) {
        for (const before of previousFinance) {
          const after = incomingById.get(String(before.id || ""));
          if (!after || JSON.stringify(comparableFinanceTask(before)) !== JSON.stringify(comparableFinanceTask(after))) {
            financeChanged = true;
            break;
          }
        }
      }
      if (!financeChanged) return next();
      if (!requireAdmin(req, res)) return;
      const actor = await actorFromRequest(req);
      if (!actor || !isAlexander(actor)) {
        return res.status(403).json({ ok: false, error: "Rechnungsfreigaben dürfen nur von Alexander verändert werden." });
      }
      next();
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/user-access", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json({ ok: true, ...(await snapshot()) }); }
    catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });

  app.put("/kristine/api/user-access", async (req, res) => {
    try {
      const actor = await requireAlexander(req, res);
      if (!actor) return;
      const people = await employees();
      const employeeById = new Map((people || []).map((employee) => [employeeId(employee), employee]));
      const incoming = Array.isArray(req.body?.users) ? req.body.users : [];
      const users = {};
      for (const row of incoming) {
        const id = String(row?.employeeId || "").trim();
        const employee = employeeById.get(id);
        if (!employee || employee.active === false) continue;
        const alex = isAlexander(employee);
        const role = alex ? "admin" : (String(row?.role || "") === "office" ? "office" : "user");
        users[id] = {
          role,
          permissions: cleanPermissions(row?.permissions, role, alex, employee),
        };
      }
      for (const employee of people || []) {
        const id = employeeId(employee);
        if (!id || employee.active === false || users[id]) continue;
        const alex = isAlexander(employee);
        const role = alex ? "admin" : "user";
        users[id] = { role, permissions: cleanPermissions(null, role, alex, employee) };
      }
      const payload = {
        version: 1,
        users,
        updatedAt: new Date().toISOString(),
        updatedBy: employeeName(actor),
      };
      await writeJson(accessFile, payload);
      res.json({ ok: true, ...(await snapshot()) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  console.log("✅ KRISTINE Benutzerrollen registriert · Freigaben nur Alexander");
}

module.exports = { registerKristineUserAccess, isAlexander };
