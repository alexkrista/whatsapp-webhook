"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const CLIENT_ID = "b4ba8fb2-b833-455c-843b-b59824198dbb";
const TENANT_ID = "5a41643d-fb28-4542-aed2-71672311a92c";
const EXPECTED_ACCOUNT = "alexander.krista@krista.at";
const SCOPES = "openid profile offline_access Calendars.ReadWrite Calendars.ReadWrite.Shared Mail.Read Mail.Read.Shared";
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
  const tasksFile = path.join(root, "tasks.json");
  const ridesFile = path.join(root, "vehicle-tracking", "rides.json");
  const logFile = path.join(root, "outlook-calendar.jsonl");
  const tokenFile = path.join(root, "outlook-token.enc.json");
  const departureOriginHint = String(deps.departureOriginHint || process.env.KRISTINE_DEPARTURE_ORIGIN_HINT || "Frastanz").trim();
  const departureDefaultTravelMinutes = Math.max(5, Math.min(180, Number(deps.departureDefaultTravelMinutes || process.env.KRISTINE_DEPARTURE_DEFAULT_TRAVEL_MINUTES || 35)));
  const departureBufferMinutes = Math.max(15, Math.min(60, Number(deps.departureBufferMinutes || process.env.KRISTINE_DEPARTURE_BUFFER_MINUTES || 15)));
  const loginSessions = new Map();
  let writeQueue = Promise.resolve();

  const allowed = (req, res) => typeof requireAdmin !== "function" ? true : requireAdmin(req, res);
  const encryptionSecret = () => String(process.env.KRISTINE_OUTLOOK_TOKEN_KEY || deps.adminToken || process.env.ADMIN_TOKEN || "");
  const adminToken = String(deps.adminToken || process.env.ADMIN_TOKEN || "");

  function signedKgoLink(taskId) {
    const task = String(taskId || "");
    const signature = crypto.createHmac("sha256", adminToken).update(`kristine-outlook-link-v1:${task}`).digest("base64url");
    return `${publicBaseUrl}/kristine/outlook-entry?task=${encodeURIComponent(task)}&sig=${encodeURIComponent(signature)}`;
  }

  function signedDepartureLink(taskId) {
    const task = String(taskId || "");
    const signature = crypto.createHmac("sha256", adminToken).update(`kristine-departure-link-v1:${task}`).digest("base64url");
    return `${publicBaseUrl}/kristine/departure-entry?task=${encodeURIComponent(task)}&sig=${encodeURIComponent(signature)}`;
  }

  function normalizePlace(value) {
    return String(value || "")
      .toLocaleLowerCase("de")
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function median(values) {
    const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!rows.length) return null;
    const mid = Math.floor(rows.length / 2);
    return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
  }

  function rideMinutes(ride) {
    const from = Date.parse(String(ride?.startedAt || ""));
    const to = Date.parse(String(ride?.closedAt || ""));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    const minutes = (to - from) / 60000;
    return minutes >= 3 && minutes <= 180 ? minutes : null;
  }

  function targetTokens(location) {
    const normalized = normalizePlace(location);
    const stopWords = new Set(["strasse", "str", "gasse", "weg", "platz", "haus", "top", "stock", "og", "ug", "at", "austria", "oesterreich"]);
    const words = normalized.split(" ").filter(word => word.length >= 3 && !stopWords.has(word));
    const postal = words.find(word => /^\d{4}$/.test(word)) || "";
    const meaningful = words.filter(word => !/^\d+$/.test(word)).slice(-4);
    return { normalized, postal, meaningful };
  }

  function destinationScore(location, stopAddress) {
    const target = targetTokens(location);
    const stop = normalizePlace(stopAddress);
    if (!target.normalized || !stop) return 0;
    let score = 0;
    if (target.postal && stop.includes(target.postal)) score += 6;
    for (const word of target.meaningful) {
      if (word.length >= 4 && stop.includes(word)) score += 3;
    }
    return score;
  }

  async function estimateTravel(location) {
    const rides = await readJson(ridesFile, []);
    const origin = normalizePlace(departureOriginHint);
    const candidates = [];
    for (const ride of Array.isArray(rides) ? rides : []) {
      const minutes = rideMinutes(ride);
      if (minutes === null) continue;
      const startAddress = normalizePlace(ride?.startPosition?.address || ride?.startLocation || "");
      if (!startAddress || (origin && !startAddress.includes(origin))) continue;
      const stopAddress = ride?.lastPosition?.address || ride?.stopLocation || "";
      const score = destinationScore(location, stopAddress);
      if (score < 3) continue;
      candidates.push({ minutes, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const strongest = candidates.length ? candidates[0].score : 0;
    const selected = candidates.filter(row => row.score >= Math.max(3, strongest - 2)).slice(0, 12);
    const learned = median(selected.map(row => row.minutes));
    if (learned !== null) {
      return {
        minutes: Math.max(5, Math.min(180, Math.round(learned / 5) * 5)),
        source: "krisdrive",
        samples: selected.length,
      };
    }
    return { minutes: departureDefaultTravelMinutes, source: "default", samples: 0 };
  }

  async function enrichDeparture(input) {
    const tasks = await readJson(tasksFile, []);
    const task = (Array.isArray(tasks) ? tasks : []).find(row => String(row?.id || "") === String(input.taskId || "")) || null;
    const location = String(input.location || task?.address || task?.jobName || "").trim();
    const estimate = await estimateTravel(location);
    const explicitTravel = Number(input.travelMinutes);
    const travelMinutes = Number.isFinite(explicitTravel) && explicitTravel > 0
      ? Math.max(5, Math.min(180, Math.round(explicitTravel)))
      : estimate.minutes;
    const explicitLead = Number(input.departureLeadMinutes);
    const departureLeadMinutes = Number.isFinite(explicitLead) && explicitLead > 0
      ? Math.max(5, Math.min(240, Math.round(explicitLead)))
      : Math.max(5, Math.min(240, travelMinutes + departureBufferMinutes));
    return {
      ...input,
      location,
      jobId:String(input.jobId || task?.jobId || "").slice(0, 100),
      jobName:String(input.jobName || task?.jobName || "").trim().slice(0, 180),
      address:String(input.address || task?.address || location || "").trim().slice(0, 500),
      travelMinutes,
      departureBufferMinutes,
      departureLeadMinutes,
      travelSource:Number.isFinite(explicitTravel) && explicitTravel > 0 ? "manual" : estimate.source,
      travelSamples:Number.isFinite(explicitTravel) && explicitTravel > 0 ? 0 : estimate.samples,
    };
  }

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
    if (["auth_success", "token_cache_saved", "token_cache_loaded", "graph_create_event_error"].includes(type)) {
      (type === "graph_create_event_error" ? logger.error : logger.log)?.(`[KRISTINE Outlook] ${type}`, details);
    }
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
    const saved = await fsp.stat(tokenFile);
    await audit("token_cache_saved", { account:accountFromToken(token), path:tokenFile, bytes:saved.size });
  }

  async function loadToken() {
    const box = await readJson(tokenFile, null);
    if (!box) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    const token = JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8"));
    await audit("token_cache_loaded", { account:accountFromToken(token), path:tokenFile });
    return token;
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

  function hasRequiredScopes(token) {
    const granted = new Set(String(token?.scope || "").split(/\s+/).filter(Boolean).map(scope => scope.toLowerCase()));
    return ["calendars.readwrite", "calendars.readwrite.shared", "mail.read", "mail.read.shared"].every(scope => granted.has(scope));
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

  async function redeemLoginSession(sessionId) {
    const session = loginSessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Anmeldecode ist abgelaufen."), { code:"session_expired" });
    if (session.status === "connected") return { account:session.account };
    if (session.error) throw new Error(session.error);
    if (session.redeeming) return null;
    session.redeeming = true;
    try {
      const token = await tokenRequest({ client_id:CLIENT_ID, grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code:session.deviceCode });
      const account = accountFromToken(token);
      if (account !== EXPECTED_ACCOUNT) throw new Error(`Angemeldet als ${account || "unbekannt"}; für V1 ist nur ${EXPECTED_ACCOUNT} erlaubt.`);
      if (!token.refresh_token) throw new Error("Microsoft hat keinen dauerhaften Refresh-Token geliefert. Bitte offline_access prüfen.");
      token.account = account;
      await saveToken(token);
      const persisted = await loadToken();
      if (accountFromToken(persisted) !== EXPECTED_ACCOUNT || !persisted.refresh_token) throw new Error("Der Outlook-Token-Cache konnte nach dem Speichern nicht verifiziert werden.");
      session.status = "connected"; session.account = account;
      await audit("auth_success", { account, scopes:SCOPES });
      return { account };
    } catch (error) {
      if (["authorization_pending", "slow_down"].includes(error.code)) return null;
      session.error = String(error?.message || error);
      throw error;
    } finally { session.redeeming = false; }
  }

  function pollLoginInBackground(sessionId) {
    const run = async () => {
      const session = loginSessions.get(sessionId);
      if (!session || session.status === "connected" || session.error || Date.now() > session.expiresAt) return;
      try { await redeemLoginSession(sessionId); } catch {}
      const latest = loginSessions.get(sessionId);
      if (latest && latest.status !== "connected" && !latest.error && Date.now() <= latest.expiresAt) setTimeout(run, Math.max(5, latest.interval) * 1000);
    };
    setTimeout(run, 1000);
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

  function graphEventPayload(appointment, { includeTransactionId = false } = {}) {
    const link = signedKgoLink(appointment.taskId);
    const departureLink = signedDepartureLink(appointment.taskId);
    const departureInfo = !appointment.allDay && appointment.departureLeadMinutes
      ? `Abfahrt: ca. ${appointment.travelMinutes || "?"} Min. Fahrt + ${appointment.departureBufferMinutes || 0} Min. Puffer · Outlook erinnert ${appointment.departureLeadMinutes} Min. vor dem Termin.`
      : "";
    const content = [
      appointment.details,
      appointment.location ? `Ort: ${appointment.location}` : "",
      departureInfo,
      `🚗 Fahrmodus öffnen: ${departureLink}`,
      `Direkt in KGO öffnen: ${link}`,
    ].filter(Boolean).join("\n\n");
    const event = {
      subject:appointment.title,
      body:{ contentType:"text", content },
      location:appointment.location ? { displayName:appointment.location } : undefined,
    };
    if (!appointment.allDay) {
      event.isReminderOn = true;
      event.reminderMinutesBeforeStart = Math.max(5, Math.min(240, Math.round(Number(appointment.departureLeadMinutes || departureDefaultTravelMinutes + departureBufferMinutes))));
    }
    if (includeTransactionId) event.transactionId = appointment.id;
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
    return event;
  }


  function appointmentStartDate(appointment) {
    if (appointment.allDay || !appointment.date || !appointment.from) return null;
    const value = new Date(`${appointment.date}T${appointment.from}:00`);
    return Number.isNaN(value.getTime()) ? null : value;
  }

  function localDateTime(value) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    const hh = String(value.getHours()).padStart(2, "0");
    const min = String(value.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:00`;
  }

  function departureBlockPayload(appointment, { includeTransactionId = false } = {}) {
    const appointmentStart = appointmentStartDate(appointment);
    if (!appointmentStart) return null;
    const leadMinutes = Math.max(15, Math.min(240, Number(appointment.departureLeadMinutes || departureDefaultTravelMinutes + departureBufferMinutes)));
    const blockStart = new Date(appointmentStart.getTime() - leadMinutes * 60000);
    const departureLink = signedDepartureLink(appointment.taskId);
    const travel = Math.max(0, Number(appointment.travelMinutes || 0));
    const buffer = Math.max(15, Number(appointment.departureBufferMinutes || departureBufferMinutes));
    const event = {
      subject:`Anfahrt & Vorbereitung · ${appointment.title}`,
      body:{
        contentType:"text",
        content:[
          "Automatisch von Kristine blockiert.",
          travel ? `Fahrzeit: ca. ${travel} Min.` : "",
          `Vorbereitung/Puffer: mindestens ${buffer} Min.`,
          appointment.location ? `Ziel: ${appointment.location}` : "",
          `Fahrmodus öffnen: ${departureLink}`,
        ].filter(Boolean).join("\n"),
      },
      showAs:"busy",
      isReminderOn:false,
      start:{ dateTime:localDateTime(blockStart), timeZone:TIME_ZONE },
      end:{ dateTime:localDateTime(appointmentStart), timeZone:TIME_ZONE },
      location:appointment.location ? { displayName:appointment.location } : undefined,
    };
    if (includeTransactionId) event.transactionId = `${appointment.id}-departure`;
    if (!event.location) delete event.location;
    return event;
  }

  async function graphCreateDepartureBlock(appointment) {
    const event = departureBlockPayload(appointment, { includeTransactionId:true });
    if (!event) return null;
    const response = await fetch(`${GRAPH_ROOT}/me/calendar/events`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${await accessToken()}`, "Content-Type":"application/json", Prefer:`outlook.timezone="${TIME_ZONE}"` },
      body:JSON.stringify(event),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
    await audit("departure_block_created", { appointmentId:appointment.id, taskId:appointment.taskId, eventId:String(body.id || "") });
    return body;
  }

  async function graphUpdateDepartureBlock(appointment) {
    const eventId = String(appointment?.outlook?.departureBlockEventId || "");
    if (!eventId) return graphCreateDepartureBlock(appointment);
    const event = departureBlockPayload(appointment);
    if (!event) return null;
    const response = await fetch(`${GRAPH_ROOT}/me/events/${encodeURIComponent(eventId)}`, {
      method:"PATCH",
      headers:{ Authorization:`Bearer ${await accessToken()}`, "Content-Type":"application/json", Prefer:`outlook.timezone="${TIME_ZONE}"` },
      body:JSON.stringify(event),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
    }
    await audit("departure_block_updated", { appointmentId:appointment.id, taskId:appointment.taskId, eventId });
    return { id:eventId };
  }

  async function graphCreate(appointment) {
    const event = graphEventPayload(appointment, { includeTransactionId:true });
    try {
      const response = await fetch(`${GRAPH_ROOT}/me/calendar/events`, {
        method:"POST", headers:{ Authorization:`Bearer ${await accessToken()}`, "Content-Type":"application/json", Prefer:`outlook.timezone=\"${TIME_ZONE}\"` }, body:JSON.stringify(event),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
      return body;
    } catch (error) {
      await audit("graph_create_event_error", { appointmentId:appointment.id, taskId:appointment.taskId, error:String(error?.message || error).slice(0, 1000) });
      throw error;
    }
  }

  async function graphUpdate(appointment) {
    if (!appointment?.outlook?.eventId) throw new Error("Outlook-Event-ID fehlt.");
    try {
      const response = await fetch(`${GRAPH_ROOT}/me/events/${encodeURIComponent(appointment.outlook.eventId)}`, {
        method:"PATCH", headers:{ Authorization:`Bearer ${await accessToken()}`, "Content-Type":"application/json", Prefer:`outlook.timezone=\"${TIME_ZONE}\"` }, body:JSON.stringify(graphEventPayload(appointment)),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
      }
      await audit("outlook_event_updated", { appointmentId:appointment.id, taskId:appointment.taskId, eventId:appointment.outlook.eventId });
      return appointment;
    } catch (error) {
      await audit("graph_update_event_error", { appointmentId:appointment.id, taskId:appointment.taskId, eventId:appointment.outlook?.eventId || "", error:String(error?.message || error).slice(0, 1000) });
      throw error;
    }
  }

  function nextIsoDate(date) {
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1);
    return day.toISOString().slice(0, 10);
  }

  function graphTime(value) {
    const match = String(value || "").match(/T(\d{2}:\d{2})/);
    return match ? match[1] : "";
  }

  function validIsoDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const value = new Date(`${date}T12:00:00Z`);
    return !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === date;
  }

  async function graphDayAppointments(date) {
    const query = new URLSearchParams({
      startDateTime:`${date}T00:00:00`,
      endDateTime:`${nextIsoDate(date)}T00:00:00`,
      "$select":"id,subject,start,end,isAllDay,showAs,location,isCancelled",
      "$orderby":"start/dateTime",
      "$top":"100",
    });
    let url = `${GRAPH_ROOT}/me/calendarView?${query}`;
    const rows = [];
    while (url) {
      const response = await fetch(url, {
        headers:{ Authorization:`Bearer ${await accessToken()}`, Prefer:`outlook.timezone=\"${TIME_ZONE}\"` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
      for (const event of Array.isArray(body.value) ? body.value : []) {
        if (event.isCancelled) continue;
        rows.push({
          id:String(event.id || ""), title:String(event.subject || "Termin"),
          allDay:Boolean(event.isAllDay), from:event.isAllDay ? "" : graphTime(event.start?.dateTime),
          to:event.isAllDay ? "" : graphTime(event.end?.dateTime), showAs:String(event.showAs || "busy"),
          location:String(event.location?.displayName || ""), source:"outlook",
        });
      }
      url = String(body["@odata.nextLink"] || "");
    }
    return rows;
  }

  async function graphScheduleAppointments(date) {
    const response = await fetch(`${GRAPH_ROOT}/me/calendar/getSchedule`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${await accessToken()}`, "Content-Type":"application/json", Prefer:`outlook.timezone=\"${TIME_ZONE}\"` },
      body:JSON.stringify({
        schedules:[EXPECTED_ACCOUNT],
        startTime:{ dateTime:`${date}T00:00:00`, timeZone:TIME_ZONE },
        endTime:{ dateTime:`${nextIsoDate(date)}T00:00:00`, timeZone:TIME_ZONE },
        availabilityViewInterval:30,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
    const items = Array.isArray(body.value?.[0]?.scheduleItems) ? body.value[0].scheduleItems : [];
    return items.map((item, index) => {
      const start = String(item.start?.dateTime || ""), end = String(item.end?.dateTime || "");
      const allDay = graphTime(start) === "00:00" && graphTime(end) === "00:00" && start.slice(0, 10) !== end.slice(0, 10);
      return {
        id:`schedule-${index}-${start}-${end}`, title:String(item.subject || "Belegter Termin"), allDay,
        from:allDay ? "" : graphTime(start), to:allDay ? "" : graphTime(end), showAs:String(item.status || "busy"),
        location:String(item.location?.displayName || item.location || ""), source:"availability",
      };
    });
  }

  function mergeDayAppointments(calendarRows, scheduleRows) {
    const rows = [...calendarRows];
    for (const row of scheduleRows) {
      const sameSlot = rows.some(current => Boolean(current.allDay) === Boolean(row.allDay) && String(current.from) === String(row.from) && String(current.to) === String(row.to));
      if (!sameSlot) rows.push(row);
    }
    return rows;
  }

  async function refreshOutlookLink(appointment) {
    if (!appointment?.outlook?.eventId) throw new Error("Outlook-Event-ID fehlt.");
    const link = signedKgoLink(appointment.taskId);
    const content = [appointment.details, appointment.location ? `Ort: ${appointment.location}` : "", `Direkt in KGO öffnen: ${link}`].filter(Boolean).join("\n\n");
    const response = await fetch(`${GRAPH_ROOT}/me/events/${encodeURIComponent(appointment.outlook.eventId)}`, {
      method:"PATCH", headers:{ Authorization:`Bearer ${await accessToken()}`, "Content-Type":"application/json" }, body:JSON.stringify({ body:{ contentType:"text", content } }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
    }
    await audit("outlook_link_refreshed", { appointmentId:appointment.id, taskId:appointment.taskId, eventId:appointment.outlook.eventId });
    return appointment;
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
      jobId:String(body.jobId || "").slice(0, 100), jobName:String(body.jobName || "").trim().slice(0, 180),
      address:String(body.address || "").trim().slice(0, 500),
      travelMinutes:Number(body.travelMinutes || 0), departureLeadMinutes:Number(body.departureLeadMinutes || 0),
      calendarOwner:"alex", calendarAccount:EXPECTED_ACCOUNT,
    };
  }

  function appointmentFingerprint(appointment) {
    const normalized = value => String(value || "").trim().toLocaleLowerCase("de").replace(/\s+/g, " ");
    return crypto.createHash("sha256").update(JSON.stringify([
      String(appointment.taskId || ""), normalized(appointment.title), String(appointment.date || ""), Boolean(appointment.allDay),
      String(appointment.from || ""), String(appointment.to || ""), normalized(appointment.location),
    ])).digest("hex");
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
        try {
          const block = await graphCreateDepartureBlock(row);
          row.outlook.departureBlockEventId = String(block?.id || "");
          row.outlook.departureBlockStatus = block?.id ? "synced" : "not_needed";
          row.outlook.departureBlockError = "";
        } catch (blockError) {
          row.outlook.departureBlockStatus = "failed";
          row.outlook.departureBlockError = String(blockError?.message || blockError).slice(0, 1000);
          await audit("departure_block_error", { appointmentId:id, taskId:row.taskId, error:row.outlook.departureBlockError });
        }
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
    try {
      const token = await loadToken();
      const account = accountFromToken(token);
      const connected = Boolean(token && token.refresh_token && account === EXPECTED_ACCOUNT && hasRequiredScopes(token));
      res.json({ ok:true, configured:Boolean(encryptionSecret()), connected, account:account || "", expectedAccount:EXPECTED_ACCOUNT, scopes:SCOPES });
    }
    catch (error) { res.json({ ok:true, configured:Boolean(encryptionSecret()), connected:false, account:"", expectedAccount:EXPECTED_ACCOUNT, error:String(error?.message || error) }); }
  });

  app.get("/kristine/api/outlook/day", async (req, res) => {
    if (!allowed(req, res)) return;
    const date = String(req.query.date || "");
    if (!validIsoDate(date)) {
      return res.status(400).json({ ok:false, error:"Ungültiges Kalenderdatum." });
    }
    try {
      const [calendarResult, scheduleResult] = await Promise.allSettled([graphDayAppointments(date), graphScheduleAppointments(date)]);
      if (calendarResult.status === "rejected" && scheduleResult.status === "rejected") throw calendarResult.reason;
      const appointments = mergeDayAppointments(calendarResult.status === "fulfilled" ? calendarResult.value : [], scheduleResult.status === "fulfilled" ? scheduleResult.value : []);
      const graphIds = new Set(appointments.map(row => row.id).filter(Boolean));
      const local = (await readJson(appointmentsFile, [])).filter(row => row.date === date && row.outlook?.status !== "synced" && (!row.outlook?.eventId || !graphIds.has(String(row.outlook.eventId))));
      for (const row of local) appointments.push({
        id:String(row.id || ""), title:String(row.title || "Termin"), allDay:Boolean(row.allDay),
        from:String(row.from || ""), to:String(row.to || ""), showAs:"busy", location:String(row.location || ""), source:"kristine",
      });
      appointments.sort((a, b) => Number(b.allDay) - Number(a.allDay) || String(a.from).localeCompare(String(b.from)) || String(a.title).localeCompare(String(b.title)));
      res.json({ ok:true, date, account:EXPECTED_ACCOUNT, appointments });
    } catch (error) {
      await audit("graph_read_day_error", { date, error:String(error?.message || error).slice(0, 1000) });
      res.status(502).json({ ok:false, error:`Outlook-Kalender konnte nicht geladen werden: ${String(error?.message || error)}` });
    }
  });

  app.get("/kristine/outlook-entry", (req, res) => {
    const task = String(req.query.task || "");
    const supplied = String(req.query.sig || "");
    const expected = crypto.createHmac("sha256", adminToken).update(`kristine-outlook-link-v1:${task}`).digest("base64url");
    const valid = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!adminToken || !task || !valid) return res.status(403).send("Forbidden");
    const browserSession = crypto.createHmac("sha256", adminToken).update("kristine-browser-session-v1").digest("base64url");
    res.setHeader("Set-Cookie", `kristine_session=${browserSession}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    res.redirect(302, `/kristine?task=${encodeURIComponent(task)}#tasks`);
  });

  app.get("/kristine/departure-entry", (req, res) => {
    const task = String(req.query.task || "");
    const supplied = String(req.query.sig || "");
    const expected = crypto.createHmac("sha256", adminToken).update(`kristine-departure-link-v1:${task}`).digest("base64url");
    const valid = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!adminToken || !task || !valid) return res.status(403).send("Forbidden");
    const browserSession = crypto.createHmac("sha256", adminToken).update("kristine-browser-session-v1").digest("base64url");
    res.setHeader("Set-Cookie", `kristine_session=${browserSession}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    res.redirect(302, `/kristine/departure?task=${encodeURIComponent(task)}`);
  });

  app.get("/kristine/departure", async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      const taskId = String(req.query.task || "");
      const [tasks, appointments] = await Promise.all([readJson(tasksFile, []), readJson(appointmentsFile, [])]);
      const task = (Array.isArray(tasks) ? tasks : []).find(row => String(row?.id || "") === taskId) || null;
      const appointment = (Array.isArray(appointments) ? appointments : []).filter(row => String(row?.taskId || "") === taskId).sort((a,b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] || null;
      if (!task && !appointment) return res.status(404).send("Termin nicht gefunden.");

      const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
      const address = String(task?.address || appointment?.address || appointment?.location || "").trim();
      const jobId = String(task?.jobId || appointment?.jobId || "").trim();
      const jobName = String(task?.jobName || appointment?.jobName || "").trim();
      const title = String(appointment?.title || task?.title || "Termin").trim();
      const from = String(appointment?.from || task?.appointment?.from || "");
      const date = String(appointment?.date || task?.appointment?.date || "");
      const when = [date ? new Date(`${date}T12:00:00`).toLocaleDateString("de-AT", { weekday:"short", day:"2-digit", month:"2-digit" }) : "", from ? `${from} Uhr` : ""].filter(Boolean).join(" · ");
      const navigation = address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving` : "";
      const akte = jobId ? `/admin/akte/${encodeURIComponent(jobId)}` : "";
      const taskLink = `/kristine?task=${encodeURIComponent(taskId)}#tasks`;
      const contactPhone = String(task?.contactPhone || "").trim();
      const tel = contactPhone ? `tel:${contactPhone.replace(/[^+\d]/g, "")}` : "";
      const travel = Number(appointment?.travelMinutes || 0);
      const lead = Number(appointment?.departureLeadMinutes || 0);
      const source = appointment?.travelSource === "krisdrive"
        ? `aus ${Number(appointment.travelSamples || 0)} ähnlichen KrisDrive-Fahrt${Number(appointment.travelSamples || 0) === 1 ? "" : "en"}`
        : "Standardwert; Kristine lernt mit den Fahrten weiter";

      res.type("html").send(`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#111111"><title>Kristine · Jetzt los</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f1ec;color:#171717}*{box-sizing:border-box}body{margin:0}main{max-width:620px;min-height:100vh;margin:auto;padding:max(22px,env(safe-area-inset-top)) 18px max(24px,env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:14px}.eyebrow{font-size:13px;color:#6d6a64;font-weight:800;text-transform:uppercase;letter-spacing:.06em}h1{font-size:36px;line-height:1.05;margin:4px 0 0}.card{background:white;border-radius:22px;padding:18px;box-shadow:0 3px 18px rgba(0,0,0,.07)}.when{font-size:18px;font-weight:800}.place{margin-top:7px;color:#5e5a54;line-height:1.45}.travel{margin-top:12px;padding-top:12px;border-top:1px solid #eee;color:#5e5a54}.travel strong{color:#171717}.buttons{display:grid;gap:10px}.button{display:flex;min-height:74px;align-items:center;justify-content:center;text-align:center;border-radius:18px;padding:16px;text-decoration:none;font-size:20px;font-weight:850}.nav{background:#111;color:white}.akte{background:#27713d;color:white}.secondary{background:white;color:#171717;border:1px solid #ddd}.small{font-size:12px;color:#777;line-height:1.4;text-align:center;padding:0 8px}@media(min-width:700px){main{justify-content:center}}
</style></head><body><main>
<div><div class="eyebrow">Kristine Fahrmodus</div><h1>Jetzt los</h1></div>
<section class="card"><div class="when">${esc(title)}${when ? ` · ${esc(when)}` : ""}</div><div class="place">${jobName ? `<strong>${esc(jobName)}</strong><br>` : ""}${esc(address || "Keine Adresse hinterlegt")}</div>${travel ? `<div class="travel"><strong>ca. ${travel} Min. Fahrt</strong>${lead ? ` · Erinnerung ${lead} Min. vorher` : ""}<br><span class="small">${esc(source)}</span></div>` : ""}</section>
<div class="buttons">
${navigation ? `<a class="button nav" href="${navigation}">📍 Navigation starten</a>` : ""}
${akte ? `<a class="button akte" href="${akte}">📁 Baustellenakte öffnen</a>` : ""}
${tel ? `<a class="button secondary" href="${esc(tel)}">☎ Kunde anrufen</a>` : ""}
<a class="button secondary" href="${taskLink}">Termin in Kristine öffnen</a>
</div>
<div class="small">Die Abfahrtserinnerung kommt über Outlook. Die Fahrzeit wird aus passenden KrisDrive-Fahrten gelernt; wenn noch nichts passt, verwendet Kristine vorerst den Standardwert.</div>
</main></body></html>`);
    } catch (error) {
      res.status(500).send(String(error?.message || error));
    }
  });

  app.post("/kristine/api/outlook/login/start", async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      if (!encryptionSecret()) return res.status(503).json({ ok:false, error:"Token-Verschlüsselung ist nicht konfiguriert." });
      const response = await fetch(`${LOGIN_ROOT}/devicecode`, { method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body:new URLSearchParams({ client_id:CLIENT_ID, scope:SCOPES }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error_description || "Device Code konnte nicht erstellt werden.");
      const sessionId = crypto.randomUUID(); loginSessions.set(sessionId, { deviceCode:body.device_code, interval:Number(body.interval || 5), expiresAt:Date.now() + Number(body.expires_in || 900) * 1000, status:"pending", account:"", error:"", redeeming:false });
      pollLoginInBackground(sessionId);
      res.json({ ok:true, sessionId, userCode:body.user_code, verificationUri:body.verification_uri, message:body.message, expiresIn:body.expires_in, interval:Number(body.interval || 5) });
    } catch (error) { res.status(502).json({ ok:false, error:String(error?.message || error) }); }
  });

  app.post("/kristine/api/outlook/login/poll", async (req, res) => {
    if (!allowed(req, res)) return;
    const sessionId = String(req.body?.sessionId || ""); const session = loginSessions.get(sessionId);
    if (!session || Date.now() > session.expiresAt) return res.status(410).json({ ok:false, error:"Anmeldecode ist abgelaufen." });
    try {
      const connected = await redeemLoginSession(sessionId);
      if (!connected) return res.status(202).json({ ok:true, status:"pending", retryAfter:session.interval });
      res.json({ ok:true, status:"connected", account:connected.account });
    } catch (error) {
      res.status(400).json({ ok:false, error:String(error?.message || error) });
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
      const input = await enrichDeparture(cleanInput(req.body || {})); const requestId = String(req.body?.requestId || "").slice(0, 100); const fingerprint = appointmentFingerprint(input);
      const saved = await serialized(async () => {
        const rows = await readJson(appointmentsFile, []);
        const existing = rows.find(row => (requestId && row.requestId === requestId) || appointmentFingerprint(row) === fingerprint);
        if (existing) { await audit("appointment_duplicate_prevented", { appointmentId:existing.id, taskId:input.taskId, requestId }); return { appointment:existing, created:false }; }
        const now = new Date().toISOString(); const row = { id:`kristine-appt-${crypto.randomUUID()}`, requestId, fingerprint, ...input, createdAt:now, updatedAt:now, outlook:{ status:"pending", eventId:"", webLink:"", error:"", attempts:0, lastAttemptAt:null, syncedAt:null } };
        rows.push(row); await atomicJson(appointmentsFile, rows); await audit("appointment_saved", { appointmentId:row.id, taskId:row.taskId }); return { appointment:row, created:true };
      });
      const synced = await syncAppointment(saved.appointment.id); res.status(saved.created ? 201 : 200).json({ ok:true, appointment:synced, internalSaved:true, duplicatePrevented:!saved.created, outlookSynced:synced.outlook.status === "synced" });
    } catch (error) { res.status(400).json({ ok:false, error:String(error?.message || error) }); }
  });

  app.patch("/kristine/api/appointments/:id", async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      const id = String(req.params.id || "");
      const input = await enrichDeparture(cleanInput(req.body || {}));
      const updated = await serialized(async () => {
        const rows = await readJson(appointmentsFile, []);
        const row = rows.find(item => item.id === id);
        if (!row) throw new Error("KRISTINE-Termin nicht gefunden.");
        Object.assign(row, input, { fingerprint:appointmentFingerprint(input), updatedAt:new Date().toISOString() });
        await atomicJson(appointmentsFile, rows);
        await audit("appointment_updated", { appointmentId:id, taskId:row.taskId });
        return structuredClone(row);
      });
      let appointment = updated;
      try {
        if (updated.outlook?.eventId) {
          await graphUpdate(updated);
          appointment = await serialized(async () => {
            const rows = await readJson(appointmentsFile, []);
            const row = rows.find(item => item.id === id);
            Object.assign(row.outlook, { status:"synced", error:"", syncedAt:new Date().toISOString(), lastAttemptAt:new Date().toISOString(), attempts:Number(row.outlook.attempts || 0) + 1 });
            try {
              const block = await graphUpdateDepartureBlock(row);
              if (block?.id) row.outlook.departureBlockEventId = String(block.id);
              row.outlook.departureBlockStatus = block ? "synced" : "not_needed";
              row.outlook.departureBlockError = "";
            } catch (blockError) {
              row.outlook.departureBlockStatus = "failed";
              row.outlook.departureBlockError = String(blockError?.message || blockError).slice(0, 1000);
              await audit("departure_block_error", { appointmentId:id, taskId:row.taskId, error:row.outlook.departureBlockError });
            }
            await atomicJson(appointmentsFile, rows);
            return row;
          });
        } else {
          await serialized(async () => {
            const rows = await readJson(appointmentsFile, []);
            const row = rows.find(item => item.id === id);
            row.outlook.status = "pending";
            await atomicJson(appointmentsFile, rows);
          });
          appointment = await syncAppointment(id);
        }
      } catch (error) {
        appointment = await serialized(async () => {
          const rows = await readJson(appointmentsFile, []);
          const row = rows.find(item => item.id === id);
          Object.assign(row.outlook, { status:"failed", error:String(error?.message || error).slice(0, 1000), lastAttemptAt:new Date().toISOString(), attempts:Number(row.outlook.attempts || 0) + 1 });
          await atomicJson(appointmentsFile, rows);
          return row;
        });
      }
      res.json({ ok:true, appointment, internalSaved:true, outlookSynced:appointment.outlook.status === "synced" });
    } catch (error) { res.status(400).json({ ok:false, error:String(error?.message || error) }); }
  });

  app.post("/kristine/api/appointments/:id/retry", async (req, res) => {
    if (!allowed(req, res)) return;
    try { const appointment = await syncAppointment(String(req.params.id)); res.json({ ok:true, appointment, outlookSynced:appointment.outlook.status === "synced" }); }
    catch (error) { res.status(404).json({ ok:false, error:String(error?.message || error) }); }
  });

  app.post("/kristine/api/appointments/:id/refresh-link", async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      const rows = await readJson(appointmentsFile, []);
      const appointment = rows.find(row => row.id === String(req.params.id));
      if (!appointment) throw new Error("KRISTINE-Termin nicht gefunden.");
      await refreshOutlookLink(appointment);
      res.json({ ok:true, appointmentId:appointment.id, eventId:appointment.outlook.eventId });
    } catch (error) { res.status(400).json({ ok:false, error:String(error?.message || error) }); }
  });

  return { syncAppointment, accessToken };
}

module.exports = { installOutlookCalendar };
