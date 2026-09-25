"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { isAlexander } = require("./kristine-user-access");

const { personalLoginEnabled, personalLoginAllowed } = require('./employee-login-policy');

const COOKIE = "kristine_user_session";
const THIRTY_DAYS = 30 * 86400000;
const root = () => path.join(process.env.DATA_DIR || "/var/data", "_kristine");
const sessionDir = () => path.join(root(), "browser-sessions");
const sessionPath = value => path.join(sessionDir(), crypto.createHash("sha256").update(value).digest("hex") + ".json");

function cookieValue(req) {
  return String(req.headers?.cookie || "").split(";").map(s => s.trim())
    .find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) || "";
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function employeeId(row) { return String(row?.id || row?.employeeId || "").trim(); }
function employeeName(row) { return String(row?.nickname || row?.rufname || row?.name || row?.employeeName || employeeId(row)).trim(); }
function currentActor(req) {
  // Personal login stays unavailable until explicit KRISTINE entitlements are in place.
  if (!personalLoginEnabled()) return null;
  const token = cookieValue(req);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const session = readJson(sessionPath(token), null);
  if (!session || session.expiresAt <= Date.now()) return null;
  const people = readJson(path.join(process.env.DATA_DIR || "/var/data", "_system", "employees.json"), []);
  const employee = (Array.isArray(people) ? people : []).find(row => employeeId(row) === session.employeeId && row.active !== false);
  if (!personalLoginAllowed(employee)) return null;
  const alex = isAlexander(employee);
  const stored = readJson(path.join(root(), "user-access.json"), { users:{} }).users?.[session.employeeId] || {};
  const role = alex ? "admin" : stored.role === "office" ? "office" : "user";
  const permissions = {
    taskViewAll:true, taskCreate:true, planningEdit:alex || role === "office",
    employeeAdmin:alex, brainAccess:alex || employee.brainAccess === true || employee.canUseBrain === true,
    userAdmin:alex, financeApproval:alex,
  };
  for (const key of ["taskViewAll", "taskCreate", "planningEdit", "employeeAdmin", "brainAccess"]) {
    if (typeof stored.permissions?.[key] === "boolean") permissions[key] = stored.permissions[key];
  }
  if (alex) permissions.employeeAdmin = true;
  return { id: session.employeeId, name: employeeName(employee), role, permissions, isAlexander: alex };
}
async function issueSession(res, employee) {
  const token = crypto.randomBytes(32).toString("base64url");
  await fsp.mkdir(sessionDir(), { recursive:true });
  await fsp.writeFile(sessionPath(token), JSON.stringify({ employeeId:employeeId(employee), expiresAt:Date.now()+THIRTY_DAYS }), { mode:0o600, flag:"wx" });
  res.cookie(COOKIE, token, { httpOnly:true, secure:true, sameSite:"lax", path:"/", maxAge:THIRTY_DAYS });
}
async function revokeSession(req, res) {
  const token = cookieValue(req);
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) await fsp.rm(sessionPath(token), { force:true });
  res.clearCookie(COOKIE, { httpOnly:true, secure:true, sameSite:"lax", path:"/" });
}
module.exports = { currentActor, issueSession, revokeSession };
