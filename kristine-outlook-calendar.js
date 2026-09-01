"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const CLIENT_ID = "b4ba8fb2-b833-455c-843b-b59824198dbb";
const TENANT_ID = "5a41643d-fb28-4542-aed2-71672311a92c";
const EXPECTED_ACCOUNT = "alexander.krista@krista.at";
const SCOPES = "openid profile offline_access Calendars.ReadWrite";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const LOGIN_ROOT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0`;
const TIME_ZONE = "Europe/Berlin";

function installOutlookCalendar(app, deps = {}) {
  const dataDir = deps.dataDir || process.env.DATA_DIR || "/var/data";
  const requireAdmin = deps.requireAdmin;
  const publicBaseUrl = String(deps.publicBaseUrl || process.env.PUBLIC_BASE_URL || "https://protokoll.krista.at").replace(/\/$/, "");
  const logger = deps.logger || console;
  const root = path.join(dataDir, "_kristine");
  const appointmentsFile = path.join(root, "appointments.json");
  const logFile = path.join(root, "outlook-calendar.jsonl");
  const tokenFile = path.join(root, "outlook-token.enc.json");
  const loginSessions = new Map();
  let writeQueue = Promise.resolve();

  const allowed = (req, res) => typeof requireAdmin !== "function" ? true : requireAdmin(req, res);
  const encryptionSecret = () => String(process.env.KRISTINE_OUTLOOK_TOKEN_KEY || deps.adminToken || process.env.ADMIN_TOKEN || "");

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); }
    catch { return fallback; }
  }

  async function atomicJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive:true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(temporary, file);
  }

  function serialized(action) {
    const result = writeQueue.then(action, action);
    writeQueue = result.catch(() => {});
    return result;
  }

  async function audit(type, details = {}) {
    const row = { at:new Date().toISOString(), type, ...details };
    await fsp.mkdir(root, { recursive:true });
    await fsp.appendFile(logFile, `${JSON.stringify(row)}\n`, "utf8").catch(error => logger.error("Outlook-Auditlog fehlgeschlagen", error));
  }

  function encryptionKey() {
    const secret = encryptionSecret();
    if (!secret) throw new Error("KRISTINE_OUTLOOK_TOKEN_KEY oder ADMIN_TOKEN fehlt.");
    return crypto.scryptSync(secret, `KRISTINE Outlook:${TENANT_ID}`, 32);
  }

  async function saveToken(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const plaintext = Buffer.from(JSON.stringify({ ...token, stored_at:Date.now() }), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    await atomicJson(tokenFile, { version:1, iv:iv.toString("base64"), tag:cipher.getAuthTag().toString("base64"), data:encrypted.toString("base64") });
  }

  async function loadToken() {
    const box = await readJson(tokenFile, null);
    if (!box) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8"));
  }

  function tokenClaims(idToken) {
    const part = String(idToken || "").split(".")[1];
    if (!part) return {};
    try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); }
    catch { return {}; }
  }

  function accountFromToken(token) {
    const claims = tokenClaims(token?.id_token);
    return String(claims.preferred_username || claims.email || token?.account || "").toLowerCase();
  }

  async function tokenRequest(values) {
    const response = await fetch(`${LOGIN_ROOT}/token`, {
      method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body:new URLSearchParams(values),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(body.error_description || body.error || `Microsoft Login HTTP ${response.status}`));
      error.code = body.error || "oauth_error";
      throw error;
    }
    return body;
  }

  async function accessToken() {
    let token = await loadToken();
    if (!token) throw new Error("Outlook ist noch nicht angemeldet.");
    const expiresAt = Number(token.stored_at || 0) + Number(token.expires_in || 0) * 1000;
    if (token.access_token && Date.now() < expiresAt - 120000) return token.access_token;
    if (!token.refresh_token) throw new Error("Outlook-Anmeldung ist abgelaufen; bitte neu anmelden.");
    token = { ...token, ...await tokenRequest({ client_id:CLIENT_ID, grant_type:"refresh_token", refresh_token:token.refresh_token, scope:SCOPES }) };
    token.account = accountFromToken(token) || EXPECTED_ACCOUNT;
    if (token.account !== EXPECTED_ACCOUNT) throw new Error(`Outlook-Konto ${token.account || "unbekannt"} ist nicht für V1 freigegeben.`);
    await saveToken(token);
    return token.access_token;
  }

  async function graphCreate(appointment) {
    const link = `${publicBaseUrl}/kristine?task=${encodeURIComponent(appointment.taskId)}#tasks`;
    const content = [appointment.details, appointment.location ? `Ort: ${appointment.location}` : "", `Direkt in KGO öffnen: ${link}`].filter(Boolean).join("\n\n");
    const event = {
      subject:appointment.title,
      body:{ contentType:"text", content },
      location:appointment.location ? { displayName:appointment.location } : undefined,
      transactionId:appointment.id,
    };
    if (appointment.allDay) {
      const end = new Date(`${appointment.date}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
      event.isAllDay = true;
      event.start = { dateTime:`${appointment.date}T00:00:00`, timeZone:TIME_ZONE };
      event.end = { dateTime:`${end.toISOString().slice(0, 10)}T00:00:00`, timeZone:TIME_ZONE };
    } else {
      event.start = { dateTime:`${appointment.date}T${appointment.from}:00`, timeZone:TIME_ZONE };
      event.end = { dateTime:`${appointment.date}T${appointment.to}:00`, timeZone:TIME_ZONE };
    }
    if (!event.location) delete event.location;
    const response = await fetch(`${GRAPH_ROOT}/me/calendar/events`, {
      method:"POST", headers:{ Authorization:`Bearer ${await accessToken()}`, "Content-Type":"application/json", Prefer:`outlook.timezone=\"${TIME_ZONE}\"` }, body:JSON.stringify(event),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
    return body;
  }

  function cleanInput(body) {
    const allDay = !!body.allDay;
    const date = String(body.date || "");
    const from = String(body.from || "");
    const to = String(body.to || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Ungültiges Termindatum.");
    if (!allDay && (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to) || to <= from)) throw new Error("Ungültige Terminzeit.");
    return {
      taskId:String(body.taskId || "").slice(0, 120), title:String(body.title || "Termin").trim().slice(0, 180) || "Termin",
      date, allDay, from:allDay ? "" : from, to:allDay ? "" : to,
      location:String(body.location || "").trim().slice(0, 500), details:String(body.details || "").trim().slice(0, 5000),
      calendarOwner:"alex", calendarAccount:EXPECTED_ACCOUNT,
    };
  }

  async function syncAppointment(id) {
    const rows = await readJson(appointmentsFile, []);
    const current = rows.find(row => row.id === id);
    if (!current) throw new Error("KRISTINE-Termin nicht gefunden.");
    if (current.outlook?.status === "synced" && current.outlook.eventId) return current;
    try {
      const event = await graphCreate(current);
      return serialized(async () => {
        const latest = await readJson(appointmentsFile, []);
        const row = latest.find(item => item.id === id);
        Object.assign(row.outlook, { status:"synced", eventId:String(event.id || ""), webLink:String(event.webLink || ""), error:"", syncedAt:new Date().toISOString(), lastAttemptAt:new Date().toISOString(), attempts:Number(row.outlook.attempts || 0) + 1 });
        await atomicJson(appointmentsFile, latest); await audit("outlook_synced", { appointmentId:id, taskId:row.taskId, eventId:row.outlook.eventId }); return row;
      });
    } catch (error) {
      return serialized(async () => {
        const latest = await readJson(appointmentsFile, []); const row = latest.find(item => item.id === id);
        Object.assign(row.outlook, { status:"failed", error:String(error?.message || error).slice(0, 1000), lastAttemptAt:new Date().toISOString(), attempts:Number(row.outlook.attempts || 0) + 1 });
        await atomicJson(appointmentsFile, latest); await audit("outlook_failed", { appointmentId:id, taskId:row.taskId, error:row.outlook.error }); return row;
      });
    }
  }

  app.get("/kristine/api/outlook/status", async (req, res) => {
    if (!allowed(req, res)) return;
    try { const token = await loadToken(); res.json({ ok:true, configured:Boolean(encryptionSecret()), connected:Boolean(token), account:accountFromToken(token) || "", expectedAccount:EXPECTED_ACCOUNT }); }
    catch (error) { res.json({ ok:true, configured:Boolean(encryptionSecret()), connected:false, account:"", expectedAccount:EXPECTED_ACCOUNT, error:String(error?.message || error) }); }
  });

  app.post("/kristine/api/outlook/login/start", async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      if (!encryptionSecret()) return res.status(503).json({ ok:false, error:"Token-Verschlüsselung ist nicht konfiguriert." });
      const response = await fetch(`${LOGIN_ROOT}/devicecode`, { method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body:new URLSearchParams({ client_id:CLIENT_ID, scope:SCOPES }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error_description || "Device Code konnte nicht erstellt werden.");
      const sessionId = crypto.randomUUID(); loginSessions.set(sessionId, { deviceCode:body.device_code, interval:Number(body.interval || 5), expiresAt:Date.now() + Number(body.expires_in || 900) * 1000 });
      res.json({ ok:true, sessionId, userCode:body.user_code, verificationUri:body.verification_uri, message:body.message, expiresIn:body.expires_in, interval:Number(body.interval || 5) });
    } catch (error) { res.status(502).json({ ok:false, error:String(error?.message || error) }); }
  });

  app.post("/kristine/api/outlook/login/poll", async (req, res) => {
    if (!allowed(req, res)) return;
    const sessionId = String(req.body?.sessionId || ""); const session = loginSessions.get(sessionId);
    if (!session || Date.now() > session.expiresAt) return res.status(410).json({ ok:false, error:"Anmeldecode ist abgelaufen." });
    try {
      const token = await tokenRequest({ client_id:CLIENT_ID, grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code:session.deviceCode });
      const account = accountFromToken(token); if (account !== EXPECTED_ACCOUNT) throw new Error(`Angemeldet als ${account || "unbekannt"}; für V1 ist nur ${EXPECTED_ACCOUNT} erlaubt.`);
      token.account = account; await saveToken(token); loginSessions.delete(sessionId); await audit("outlook_login", { account });
      res.json({ ok:true, status:"connected", account });
    } catch (error) {
      if (["authorization_pending", "slow_down"].includes(error.code)) return res.status(202).json({ ok:true, status:"pending", retryAfter:error.code === "slow_down" ? session.interval + 5 : session.interval });
      loginSessions.delete(sessionId); res.status(400).json({ ok:false, error:String(error?.message || error) });
    }
  });

  app.get("/kristine/api/appointments", async (req, res) => {
    if (!allowed(req, res)) return;
    const taskId = String(req.query.taskId || ""); const rows = await readJson(appointmentsFile, []);
    res.json({ ok:true, appointments:taskId ? rows.filter(row => row.taskId === taskId) : rows.slice(-200) });
  });

  app.post("/kristine/api/appointments", async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      const input = cleanInput(req.body || {}); const requestId = String(req.body?.requestId || "").slice(0, 100);
      const appointment = await serialized(async () => {
        const rows = await readJson(appointmentsFile, []);
        if (requestId) { const existing = rows.find(row => row.requestId === requestId); if (existing) return existing; }
        const now = new Date().toISOString(); const row = { id:`kristine-appt-${crypto.randomUUID()}`, requestId, ...input, createdAt:now, updatedAt:now, outlook:{ status:"pending", eventId:"", webLink:"", error:"", attempts:0, lastAttemptAt:null, syncedAt:null } };
        rows.push(row); await atomicJson(appointmentsFile, rows); await audit("appointment_saved", { appointmentId:row.id, taskId:row.taskId }); return row;
      });
      const synced = await syncAppointment(appointment.id); res.status(201).json({ ok:true, appointment:synced, internalSaved:true, outlookSynced:synced.outlook.status === "synced" });
    } catch (error) { res.status(400).json({ ok:false, error:String(error?.message || error) }); }
  });

  app.post("/kristine/api/appointments/:id/retry", async (req, res) => {
    if (!allowed(req, res)) return;
    try { const appointment = await syncAppointment(String(req.params.id)); res.json({ ok:true, appointment, outlookSynced:appointment.outlook.status === "synced" }); }
    catch (error) { res.status(404).json({ ok:false, error:String(error?.message || error) }); }
  });

  return { syncAppointment };
}

module.exports = { installOutlookCalendar };
