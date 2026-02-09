// server.js (ESM)
import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import dayjs from "dayjs";
import { buildPdfA3Landscape } from "./pdf.js";

const app = express();
app.use(express.json({ limit: "25mb" }));

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 10000;

// WhatsApp
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; // optional (für Antworten)
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

// Storage
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const STATE_FILE = path.join(DATA_DIR, "_state", "last_code_by_sender.json");

// Mail (Brevo SMTP)
const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const MAIL_TO = process.env.MAIL_TO || "";

// Admin
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Regeln
const UNKNOWN_REPLY_TEXT = "Bitte Baustellennummer mit # vorab senden";
const INACTIVITY_MINUTES = Number(process.env.INACTIVITY_MINUTES || 10);

// =====================
// State helpers
// =====================
async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function loadState() {
  try {
    const txt = await fs.promises.readFile(STATE_FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return { lastCodeBySender: {}, lastActivityByCode: {}, lastAutoPdfAt: {}, lastDailyRunDate: "" };
  }
}

async function saveState(state) {
  await ensureDir(path.dirname(STATE_FILE));
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function todayFolder() {
  return dayjs().format("YYYY-MM-DD");
}

function tsNow() {
  return Math.floor(Date.now() / 1000);
}

function sanitizeCode(code) {
  return String(code || "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 32);
}

function parseCodeFromText(text) {
  if (!text) return null;
  const m = text.match(/#([0-9]{3,12})/);
  return m ? m[1] : null;
}

function isPdfCommand(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return t === "pdf" || t === "/pdf" || t === "bericht" || t === "/bericht";
}

// =====================
// WhatsApp send helper
// =====================
async function sendWhatsAppText(toWaId, body) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    console.log("sendWhatsAppText skipped (missing PHONE_NUMBER_ID or WHATSAPP_TOKEN)");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "text",
    text: { body }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.text();
  if (!res.ok) {
    console.log("WhatsApp send failed:", res.status, data);
  } else {
    console.log("WhatsApp send OK:", data);
  }
}

// =====================
// Media download
// =====================
async function downloadWhatsAppMedia(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("Missing WHATSAPP_TOKEN");
  const metaUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(`Media meta error: ${metaRes.status} ${JSON.stringify(meta)}`);

  const fileUrl = meta.url;
  const mime = meta.mime_type || "application/octet-stream";

  const fileRes = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
  if (!fileRes.ok) throw new Error(`Media download error: ${fileRes.status}`);

  const buf = Buffer.from(await fileRes.arrayBuffer());
  return { buf, mime };
}

function extFromMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "application/pdf") return "pdf";
  if (mime?.includes("audio")) return "ogg";
  return "bin";
}

// =====================
// Logging per Baustelle
// =====================
async function appendLog(code, lineObj) {
  const codeDir = path.join(DATA_DIR, code);
  const dayDir = path.join(codeDir, todayFolder());
  await ensureDir(dayDir);

  const logFile = path.join(dayDir, "log.jsonl");
  await fs.promises.appendFile(logFile, JSON.stringify(lineObj) + "\n", "utf8");
  return { dayDir, logFile };
}

async function listItemsForCodeToday(code) {
  const dayDir = path.join(DATA_DIR, code, todayFolder());
  const logFile = path.join(dayDir, "log.jsonl");
  let lines = [];
  try {
    const txt = await fs.promises.readFile(logFile, "utf8");
    lines = txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { dayDir, items: [] };
  }

  // Convert
  const items = lines.map((x) => {
    if (x.kind === "text") {
      return { type: "text", when: x.when, from: x.from, text: x.text };
    }
    if (x.kind === "image") {
      return { type: "image", when: x.when, from: x.from, fileName: x.fileName, filePath: x.filePath };
    }
    return null;
  }).filter(Boolean);

  return { dayDir, items };
}

// =====================
// Mail
// =====================
function mailTransport() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendMailWithPdf({ subject, text, pdfPath }) {
  if (!SMTP_USER || !SMTP_PASS || !MAIL_FROM || !MAIL_TO) {
    console.log("Mail skipped (missing SMTP_USER/SMTP_PASS/MAIL_FROM/MAIL_TO)");
    return;
  }

  const transporter = mailTransport();
  await transporter.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    text,
    attachments: [
      {
        filename: path.basename(pdfPath),
        path: pdfPath
      }
    ]
  });
}

// =====================
// PDF generation
// =====================
async function generateAndMailPdfForCodeToday(code, reason = "manual") {
  const { dayDir, items } = await listItemsForCodeToday(code);
  if (!items.length) {
    console.log(`No items for code #${code} today -> skip PDF`);
    return null;
  }

  const pdfName = `Baustellenprotokoll_${code}_${todayFolder()}.pdf`;
  const pdfPath = path.join(dayDir, pdfName);

  await buildPdfA3Landscape({
    title: `Baustellenprotokoll #${code} (${todayFolder()})`,
    items,
    outPath: pdfPath
  });

  await sendMailWithPdf({
    subject: `Baustellenprotokoll #${code} – ${todayFolder()}`,
    text: `Automatisch erstellt (${reason}).`,
    pdfPath
  });

  console.log(`✅ PDF created+mailed for #${code} -> ${pdfPath}`);
  return pdfPath;
}

// =====================
// Webhook routes
// =====================
app.get("/", (req, res) => res.status(200).send("webhook läuft"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    // WhatsApp payload
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages || [];
    const contacts = value?.contacts || [];

    if (!messages.length) {
      return res.sendStatus(200);
    }

    const msg = messages[0];
    const from = msg.from; // wa_id
    const when = dayjs.unix(Number(msg.timestamp || tsNow())).format("YYYY-MM-DD HH:mm:ss");
    const msgType = msg.type;

    const state = await loadState();

    // 1) Text?
    if (msgType === "text") {
      const text = msg.text?.body || "";

      // PDF command?
      if (isPdfCommand(text)) {
        const code = state.lastCodeBySender[from] || "unknown";
        if (code === "unknown") {
          await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT);
        } else {
          await generateAndMailPdfForCodeToday(code, "whatsapp-command");
          await sendWhatsAppText(from, `PDF wird erstellt und per Mail gesendet für #${code}.`);
        }
        return res.sendStatus(200);
      }

      // Baustellencode setzen?
      const codeFound = parseCodeFromText(text);
      if (codeFound) {
        const code = sanitizeCode(codeFound);
        state.lastCodeBySender[from] = code;
        state.lastActivityByCode[code] = Date.now();
        await saveState(state);

        await appendLog(code, { kind: "text", when, from, text });
        console.log(`✅ saved text for #${code} -> ${path.join(DATA_DIR, code, todayFolder(), "log.jsonl")}`);
        return res.sendStatus(200);
      }

      // normaler Text -> in aktuell aktiver Baustelle loggen (oder unknown)
      const activeCode = state.lastCodeBySender[from] || "unknown";
      state.lastActivityByCode[activeCode] = Date.now();
      await saveState(state);

      await appendLog(activeCode, { kind: "text", when, from, text });
      console.log(`✅ saved text for #${activeCode} -> ${path.join(DATA_DIR, activeCode, todayFolder(), "log.jsonl")}`);

      if (activeCode === "unknown") {
        await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT);
      }

      return res.sendStatus(200);
    }

    // 2) Image?
    if (msgType === "image") {
      const activeCode = state.lastCodeBySender[from] || "unknown";
      state.lastActivityByCode[activeCode] = Date.now();
      await saveState(state);

      const mediaId = msg.image?.id;
      const caption = msg.image?.caption || "";
      if (!mediaId) throw new Error("image.id missing");

      const { buf, mime } = await downloadWhatsAppMedia(mediaId);
      const ext = extFromMime(mime);

      const codeDir = path.join(DATA_DIR, activeCode);
      const dayDir = path.join(codeDir, todayFolder());
      await ensureDir(dayDir);

      const fileName = `${msg.timestamp || tsNow()}_${mediaId}.${ext}`;
      const filePath = path.join(dayDir, fileName);
      await fs.promises.writeFile(filePath, buf);

      await appendLog(activeCode, {
        kind: "image",
        when,
        from,
        caption,
        fileName,
        filePath
      });

      console.log(`✅ saved image for #${activeCode} -> ${filePath}`);

      if (activeCode === "unknown") {
        await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT);
      }

      return res.sendStatus(200);
    }

    // 3) Andere Typen (optional loggen)
    const activeCode = state.lastCodeBySender[from] || "unknown";
    state.lastActivityByCode[activeCode] = Date.now();
    await saveState(state);

    await appendLog(activeCode, { kind: "text", when, from, text: `[${msgType}]` });
    if (activeCode === "unknown") {
      await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200); // WhatsApp mag 200
  }
});

// =====================
// Admin routes
// =====================
function checkAdmin(req) {
  if (!ADMIN_KEY) return true; // wenn du kein ADMIN_KEY setzt, offen (nicht empfohlen)
  const key = req.query.key || req.headers["x-admin-key"];
  return key === ADMIN_KEY;
}

app.get("/admin/run-daily", async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).send("forbidden");
  try {
    await runDaily("admin");
    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

app.get("/admin/run-code", async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).send("forbidden");
  const code = sanitizeCode(req.query.code || "");
  if (!code) return res.status(400).send("missing code");
  try {
    const p = await generateAndMailPdfForCodeToday(code, "admin");
    res.status(200).send(p ? "ok" : "no data");
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// =====================
// Schedulers
// =====================
async function runDaily(reason = "daily") {
  const state = await loadState();
  const today = todayFolder();
  if (state.lastDailyRunDate === today && reason === "daily") return;

  // alle Codes durchgehen
  const codes = new Set(Object.values(state.lastCodeBySender || {}).filter(Boolean));
  codes.delete("unknown");

  for (const code of codes) {
    await generateAndMailPdfForCodeToday(code, reason);
  }

  state.lastDailyRunDate = today;
  await saveState(state);
}

async function runInactivityAutoPdfs() {
  const state = await loadState();
  const now = Date.now();

  const codes = Object.keys(state.lastActivityByCode || {});
  for (const code of codes) {
    if (!code || code === "unknown") continue;

    const last = Number(state.lastActivityByCode[code] || 0);
    if (!last) continue;

    const mins = (now - last) / 60000;
    if (mins < INACTIVITY_MINUTES) continue;

    const key = `${code}:${todayFolder()}`;
    const lastAuto = Number(state.lastAutoPdfAt?.[key] || 0);

    // nur einmal pro Baustelle/Tag automatisch senden
    if (lastAuto) continue;

    await generateAndMailPdfForCodeToday(code, `auto-${INACTIVITY_MINUTES}min`);
    state.lastAutoPdfAt = state.lastAutoPdfAt || {};
    state.lastAutoPdfAt[key] = now;
    await saveState(state);
  }
}

function msUntilNext22() {
  // Nutzt Server-Localtime. Empfehlung: in Render ENV setzen: TZ=Europe/Vienna
  const now = new Date();
  const next = new Date(now);
  next.setHours(22, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDaily22() {
  setTimeout(async () => {
    try {
      await runDaily("daily");
    } catch (e) {
      console.error("Daily run failed:", e);
    }
    scheduleDaily22();
  }, msUntilNext22());
}

// Inactivity check alle 60s
setInterval(() => {
  runInactivityAutoPdfs().catch((e) => console.error("auto pdf error:", e));
}, 60 * 1000);

// Daily 22:00
scheduleDaily22();

// =====================
// Startup
// =====================
(async () => {
  await ensureDir(DATA_DIR);
  await ensureDir(path.join(DATA_DIR, "_state"));
  console.log("Server läuft auf Port", PORT);
  console.log("DATA_DIR=", DATA_DIR);
  console.log("STATE_FILE=", STATE_FILE);
  console.log("PHONE_NUMBER_ID set:", Boolean(PHONE_NUMBER_ID));
})();

app.listen(PORT, () => {
  console.log("==> Your service is live 🚀");
});
