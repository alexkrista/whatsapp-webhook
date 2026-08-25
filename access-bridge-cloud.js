"use strict";

// KRISTINE Zutritt Cloud Bridge
// Render stellt nur Stempelstatus + WhatsApp-Testmeldungen bereit.
// Die reale Türsteuerung bleibt ausschließlich im Firmen-PC.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ACCESS_BRIDGE_VERSION = "1.1.0";
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const WHATSAPP_TOKEN = String(process.env.WHATSAPP_TOKEN || "").trim();
const CHEF_PHONE = String(process.env.CHEF_PHONE || "").trim();
const TZ = "Europe/Vienna";

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

function localDateISO(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("de-AT", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { return fallback; }
}

// Anwesenheit = heute mindestens gestartet und der letzte relevante Zeitstempel ist nicht "ende".
// Pause/Mittag zählen als weiterhin anwesend.
function personPresence(events, firstName, date) {
  const wanted = normalizeName(firstName);
  const relevant = new Set(["start", "weiter", "pause", "mittag", "ende"]);
  let last = null;

  for (const row of Array.isArray(events) ? events : []) {
    if (String(row?.date || "").slice(0, 10) !== date) continue;
    const first = normalizeName(row?.employeeName || "").split(/\s+/)[0] || "";
    if (first !== wanted) continue;
    const type = String(row?.type || "").toLowerCase();
    if (!relevant.has(type)) continue;
    last = row;
  }

  return {
    present: Boolean(last && String(last.type || "").toLowerCase() !== "ende"),
    name: String(last?.employeeName || firstName),
    lastType: String(last?.type || ""),
    lastAt: String(last?.at || ""),
    employeeId: String(last?.employeeId || ""),
  };
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `43${digits.slice(1)}`;
  return digits;
}

function rememberedSenderId() {
  const direct = String(
    process.env.PHONE_NUMBER_ID ||
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    process.env.KRISTINE_PHONE_NUMBER_ID ||
    ""
  ).trim();
  if (direct) return direct;

  try {
    const row = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "_kristine", "whatsapp-sender.json"), "utf8")
    );
    return String(row?.phoneNumberId || "").trim();
  } catch {
    return "";
  }
}

async function sendChefWhatsApp(message) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN fehlt");
  const senderId = rememberedSenderId();
  if (!senderId) throw new Error("WhatsApp phone_number_id fehlt");
  const to = normalizePhone(CHEF_PHONE);
  if (!to) throw new Error("CHEF_PHONE fehlt");

  const response = await fetch(
    `https://graph.facebook.com/v22.0/${encodeURIComponent(senderId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          preview_url: false,
          body: String(message || "").slice(0, 3500),
        },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`WhatsApp HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
}

function installRoutes(app) {
  if (!app || app.__kristaAccessBridgeInstalled) return;
  app.__kristaAccessBridgeInstalled = true;

  // Bewusst öffentlicher, ungefährlicher Healthcheck: keine Personen-, Token-
  // oder Zutrittsdaten. Dient ausschließlich dazu festzustellen, ob genau
  // dieses Bridge-Modul im laufenden Cloud-Prozess registriert ist.
  app.get("/kristine/api/access-health", (req, res) => {
    res.json({
      ok: true,
      service: "krista-access-bridge",
      version: ACCESS_BRIDGE_VERSION,
      time: new Date().toISOString(),
    });
  });

  app.get("/kristine/api/access-presence", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const date = String(req.query?.date || localDateISO()).slice(0, 10);
      const events = await readJson(
        path.join(DATA_DIR, "_kristine", "time-events.json"),
        []
      );
      res.json({
        ok: true,
        date,
        people: {
          bettina: personPresence(events, "Bettina", date),
          dunja: personPresence(events, "Dunja", date),
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/access-notify", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const message = String(req.body?.message || "").trim();
      if (!message) {
        return res.status(400).json({ ok: false, error: "message fehlt" });
      }
      await sendChefWhatsApp(message);
      res.json({ ok: true });
    } catch (error) {
      console.error("KRISTINE Zutritt WhatsApp:", String(error?.message || error));
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  console.log(`KRISTINE Zutritt Cloud Bridge aktiv · ${ACCESS_BRIDGE_VERSION}`);
}

// Preload-Hook: Nach dem ERSTEN app.use() (express.json) werden unsere Routen
// installiert. Damit liegt der JSON-Parser davor und der finale 404-Handler danach.
const expressPath = require.resolve("express");
const originalExpress = require(expressPath);

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  const originalUse = app.use.bind(app);
  let routesInserted = false;

  app.use = function (...useArgs) {
    const result = originalUse(...useArgs);
    if (!routesInserted) {
      routesInserted = true;
      installRoutes(app);
    }
    return result;
  };
  return app;
}

Object.assign(wrappedExpress, originalExpress);
wrappedExpress.application = originalExpress.application;
wrappedExpress.request = originalExpress.request;
wrappedExpress.response = originalExpress.response;
require.cache[expressPath].exports = wrappedExpress;

module.exports = { installRoutes, personPresence, ACCESS_BRIDGE_VERSION };
