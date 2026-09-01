"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_PRODUCTIVITY = [58, 84, 84, 95, 88, 98, 75, 68, 97, 97, 94, 70];

function number(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function monthValues(value, fallback, min = 0, max = 200) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: 12 }, (_, month) =>
    number(source[month], Array.isArray(fallback) ? fallback[month] : fallback, min, max)
  );
}

function employeeId(employee) {
  return String(employee?.id || employee?.employeeId || "").trim();
}

function employeeName(employee) {
  return String(employee?.nickname || employee?.name || employee?.employeeName || employeeId(employee)).trim();
}

function isProductiveEmployee(employee) {
  const classification = [employee?.role, employee?.team, employee?.department, employee?.area]
    .map(value => String(value || "").trim().toLowerCase())
    .join(" ");
  return !/(^|\s)(büro|buero|office|verwaltung|administration|admin|buchhaltung)(\s|$)/i.test(classification);
}

function cleanPlan(input = {}, employees = [], year = new Date().getFullYear()) {
  const stored = new Map((Array.isArray(input.employees) ? input.employees : [])
    .map(row => [String(row?.employeeId || "").trim(), row])
    .filter(([id]) => id));
  const allLive = (Array.isArray(employees) ? employees : [])
    .filter(row => employeeId(row) && row?.active !== false);
  for (const employee of allLive) {
    if (!isProductiveEmployee(employee)) stored.delete(employeeId(employee));
  }
  const live = allLive
    .filter(isProductiveEmployee)
    .sort((a, b) => employeeName(a).localeCompare(employeeName(b), "de"));
  const rows = live.map(employee => {
    const id = employeeId(employee);
    const existing = stored.get(id) || {};
    const employment = number(employee?.employmentPercent, 100, 0, 200);
    stored.delete(id);
    return {
      employeeId: id,
      employeeName: employeeName(employee),
      monthlyPercent: monthValues(existing.monthlyPercent, employment, 0, 200),
    };
  });
  for (const [id, existing] of stored) {
    rows.push({
      employeeId: id,
      employeeName: String(existing.employeeName || id).trim().slice(0, 120),
      monthlyPercent: monthValues(existing.monthlyPercent, 0, 0, 200),
    });
  }
  return {
    year: Math.trunc(number(year || input.year, new Date().getFullYear(), 2020, 2100)),
    annualHoursPerFte: number(input.annualHoursPerFte, 2028, 1, 4000),
    hoursPerDay: number(input.hoursPerDay, 7.8, 0.1, 24),
    billingRate: number(input.billingRate, 73, 0, 1000),
    materialPercent: number(input.materialPercent, 18, 0, 500),
    holidayDays: number(input.holidayDays, 9, 0, 366),
    vacationDays: number(input.vacationDays, 25, 0, 366),
    sickDays: number(input.sickDays, 3.6, 0, 366),
    otherDays: number(input.otherDays, 4, 0, 366),
    productivityPercent: monthValues(input.productivityPercent, DEFAULT_PRODUCTIVITY, 0, 150),
    employees: rows,
    updatedAt: input.updatedAt || null,
  };
}

function calculatePlan(plan) {
  const monthlyBasePerFte = plan.annualHoursPerFte / 12;
  const monthlyStaffFactor = Array.from({ length: 12 }, (_, month) =>
    plan.employees.reduce((sum, employee) => sum + number(employee.monthlyPercent[month], 0) / 100, 0)
  );
  const monthlyGrossHours = monthlyStaffFactor.map(factor => monthlyBasePerFte * factor);
  const monthlyPlanHours = monthlyGrossHours.map((hours, month) => hours * plan.productivityPercent[month] / 100);
  const monthlyLaborRevenue = monthlyPlanHours.map(hours => hours * plan.billingRate);
  const monthlyMaterialRevenue = monthlyLaborRevenue.map(value => value * plan.materialPercent / 100);
  const monthlyPlanRevenue = monthlyLaborRevenue.map((value, month) => value + monthlyMaterialRevenue[month]);
  const sum = values => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
  const deductionDays = plan.holidayDays + plan.vacationDays + plan.sickDays + plan.otherDays;
  const productiveHoursPerFte = Math.max(0, plan.annualHoursPerFte - deductionDays * plan.hoursPerDay);
  const targetProductivityPercent = plan.annualHoursPerFte > 0 ? productiveHoursPerFte / plan.annualHoursPerFte * 100 : 0;
  return {
    monthlyStaffFactor: monthlyStaffFactor.map(value => Math.round(value * 1000) / 1000),
    monthlyGrossHours: monthlyGrossHours.map(value => Math.round(value * 100) / 100),
    monthlyPlanHours: monthlyPlanHours.map(value => Math.round(value * 100) / 100),
    monthlyLaborRevenue: monthlyLaborRevenue.map(value => Math.round(value * 100) / 100),
    monthlyMaterialRevenue: monthlyMaterialRevenue.map(value => Math.round(value * 100) / 100),
    monthlyPlanRevenue: monthlyPlanRevenue.map(value => Math.round(value * 100) / 100),
    annualGrossHours: sum(monthlyGrossHours),
    annualPlanHours: sum(monthlyPlanHours),
    annualLaborRevenue: sum(monthlyLaborRevenue),
    annualMaterialRevenue: sum(monthlyMaterialRevenue),
    annualPlanRevenue: sum(monthlyPlanRevenue),
    productiveHoursPerFte: Math.round(productiveHoursPerFte * 100) / 100,
    targetProductivityPercent: Math.round(targetProductivityPercent * 100) / 100,
    monthlyProductivityAverage: Math.round(plan.productivityPercent.reduce((sumValue, value) => sumValue + value, 0) / 12 * 100) / 100,
  };
}

function minutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const result = Number(match[1]) * 60 + Number(match[2]);
  return result >= 0 && result <= 24 * 60 ? result : null;
}

function calculateActualHours(events, year) {
  const groups = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const date = String(event?.date || "").slice(0, 10);
    if (!date.startsWith(`${year}-`)) continue;
    const employee = String(event?.employeeId || "");
    const at = minutes(event?.at);
    if (!employee || at === null) continue;
    const key = `${employee}|${date}`;
    const rows = groups.get(key) || [];
    rows.push({ ...event, atMinutes: at });
    groups.set(key, rows);
  }
  const totals = Array(12).fill(0);
  for (const [key, rows] of groups) {
    rows.sort((a, b) => a.atMinutes - b.atMinutes || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const date = key.split("|")[1];
    const month = Number(date.slice(5, 7)) - 1;
    for (let index = 0; index < rows.length - 1; index += 1) {
      const type = String(rows[index].type || "").toLowerCase();
      if (!["start", "weiter"].includes(type)) continue;
      totals[month] += Math.max(0, rows[index + 1].atMinutes - rows[index].atMinutes) / 60;
    }
  }
  return totals.map(value => Math.round(value * 100) / 100);
}

function registerTowerPlanning(app, { dataDir, requireAdmin, readEmployees }) {
  const root = path.join(dataDir, "_kristine");
  const plansFile = path.join(root, "tower-plans.json");
  const eventsFile = path.join(root, "time-events.json");

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); }
    catch { return fallback; }
  }

  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(temporary, file);
  }

  async function responseForYear(year, requestedPlan = null) {
    const employees = typeof readEmployees === "function" ? await readEmployees() : [];
    const store = await readJson(plansFile, { plans: {} });
    const source = requestedPlan || store?.plans?.[String(year)] || {};
    const plan = cleanPlan(source, employees, year);
    const events = fs.existsSync(eventsFile) ? await readJson(eventsFile, []) : [];
    return {
      ok: true,
      plan,
      calculation: calculatePlan(plan),
      actual: {
        monthlyHours: calculateActualHours(events, year),
        monthlyRevenue: null,
        hoursSource: "KRISZEIT",
        revenueSource: "Ausgangsrechnungen noch nicht angebunden",
      },
    };
  }

  app.get("/kristine/api/tower-plan", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const year = Math.trunc(number(req.query.year, new Date().getFullYear(), 2020, 2100));
      res.json(await responseForYear(year));
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/kristine/api/tower-plan", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const requested = req.body?.plan || req.body || {};
      const year = Math.trunc(number(requested.year || req.query.year, new Date().getFullYear(), 2020, 2100));
      const employees = typeof readEmployees === "function" ? await readEmployees() : [];
      const plan = cleanPlan({ ...requested, updatedAt: new Date().toISOString() }, employees, year);
      const store = await readJson(plansFile, { plans: {} });
      store.plans = store.plans && typeof store.plans === "object" ? store.plans : {};
      store.plans[String(year)] = plan;
      await writeJson(plansFile, store);
      res.json(await responseForYear(year, plan));
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerTowerPlanning, cleanPlan, calculatePlan, calculateActualHours, isProductiveEmployee };
