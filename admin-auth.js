"use strict";

const crypto = require("crypto");
const { currentActor } = require("./employee-sessions");

const COOKIE_NAME = "kristine_session";

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sessionFor(secret) {
  return crypto.createHmac("sha256", secret).update("kristine-browser-session-v1").digest("base64url");
}

function cookieFrom(req) {
  const part = String(req.headers?.cookie || "").split(";").map(value => value.trim())
    .find(value => value.startsWith(`${COOKIE_NAME}=`));
  return part ? part.slice(COOKIE_NAME.length + 1) : "";
}

function sameOrigin(req) {
  const origin = String(req.headers?.origin || "");
  const host = String(req.headers?.host || "");
  if (origin && host) {
    try {
      const url = new URL(origin);
      return (url.protocol === "https:" || url.protocol === "http:") && url.host.toLowerCase() === host.toLowerCase();
    } catch { return false; }
  }
  // Browser requests without Origin must identify themselves as same-origin.
  return !origin && req.headers?.["sec-fetch-site"] === "same-origin";
}

function requiredPermission(req) {
  const pathname = String(req.path || "");
  const method = String(req.method || "GET").toUpperCase();
  if (pathname === "/admin/api/brain-permit") return "brainAccess";
  if (pathname.startsWith("/admin/api/access/") && !["GET", "HEAD"].includes(method)) return "employeeAdmin";
  if (pathname === "/kristine/api/user-access" && method !== "GET") return "userAdmin";
  if (/^\/admin\/api\/employees(?:\/|$)/.test(pathname) && !["GET", "HEAD"].includes(method)) return "employeeAdmin";
  if (pathname === "/kristine/api/assignments" && !["GET", "HEAD"].includes(method)) return "planningEdit";
  return "";
}

function rememberBrowser(res, value) {
  const cookie = `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
  if (typeof res.append === "function") res.append("Set-Cookie", cookie);
  else if (typeof res.setHeader === "function") res.setHeader("Set-Cookie", cookie);
}

function requireAdmin(req, res, options = {}) {
  const actor = options.allowBrowserSession === false ? null : currentActor(req);
  if (actor) {
    if (!["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase()) && !sameOrigin(req)) {
      res.status(403).json({ ok:false, error:"Fremder Ursprung abgewiesen" });
      return false;
    }
    const permission = requiredPermission(req);
    if (permission && !actor.permissions[permission]) {
      res.status(403).json({ ok:false, error:"Für diesen Benutzer nicht freigegeben" });
      return false;
    }
    req.kristineActor = actor;
    req.headers["x-krista-user-id"] = actor.id;
    req.headers["x-krista-user-name"] = actor.name;
    return true;
  }
  const secret = String(options.secret ?? process.env.ADMIN_TOKEN ?? "").trim();
  if (!secret) {
    res.status(503).json({ ok: false, error: "ADMIN_TOKEN fehlt" });
    return false;
  }

  const token = req.headers?.["x-admin-token"] || req.headers?.["x-krista-admin-token"] || req.query?.token || "";
  const tokenValid = secureEqual(token, secret);
  const session = sessionFor(secret);
  const cookieValid = options.allowBrowserSession !== false && secureEqual(cookieFrom(req), session);
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase());
  if (!tokenValid && !(cookieValid && (safeMethod || sameOrigin(req)))) {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }
  // A valid legacy link establishes the browser session. Subsequent navigation
  // can use the cookie without copying the admin key into every URL.
  if (tokenValid && safeMethod && options.rememberBrowser !== false && !cookieValid) rememberBrowser(res, session);
  return true;
}

module.exports = { requireAdmin, sameOrigin };
