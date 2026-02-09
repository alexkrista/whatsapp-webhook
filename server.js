import express from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import nodemailer from "nodemailer";
import { buildDailyPdf } from "./pdf.js";

const app = express();
app.use(express.json({ limit: "25mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID_ENV = process.env.PHONE_NUMBER_ID || "";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

const STATE_DIR = path.join(DATA_DIR, "_state");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const UNKNOWN_REPLY_TEXT = "Bitte Baustellennummer mit # davor senden";
const PROMPT_COOLDOWN_SEC = 600; // 10 Minuten
const INACTIVITY_MINUTES = Number(process.env.INACTIVITY_MINUTES || "10");

// Mail (Brevo)
const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const MAIL_TO = process.env.MAIL_TO || "";

// Zeitzone für 22:00 (Render: ENV TZ=Europe/Vienna setzen!)
const TZ = process.env.TZ || "Europe/Vienna";

// ---------- Helpers ----------
function nowIso() { return new Date().toISOString(); }

function ymdFromUnixSeconds(ts) {
  const n = Number(ts);
  const d = Number.isFinite(n) ? new Date(n * 1000) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDay() {
  // basiert auf Server-Zeit; mit TZ env stimmt 22:00
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }

function extractCodeFromText(text) {
  const m = String(text || "").match(/#(\d{3,})/);
  return m ? m[1] : null;
}

function isPdfCommand(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "pdf" || t === "/pdf";
}

function normalizeState(parsed) {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  return {
    lastCodeBySender: p.lastCodeBySender && typeof p.lastCodeBySender === "object" ? p.lastCodeBySender : {},
    lastPromptAtBySender: p.lastPromptAtBySender && typeof p.lastPromptAtBySender === "object" ? p.lastPromptAtBySender : {},
    lastPhoneNumberId: typeof p.lastPhoneNumberId === "string" ? p.lastPhoneNumberId : "",
    seenMessageIds: p.seenMessageIds && typeof p.seenMessageIds === "object" ? p.seenMessageIds : {},
    lastActivityByCode: p.lastActivityByCode && typeof p.lastActivityByCode === "object" ? p.lastActivityByCode : {},
    autoPdfSentForCodeDay: p.autoPdfSentForCodeDay && typeof p.autoPdfSentForCodeDay === "object" ? p.autoPdfSentForCodeDay : {},
    dailyPdfSentDate: typeof p.dailyPdfSentDate === "string" ? p.dailyPdfSentDate : ""
  };
}

async function loadState() {
  await ensureDir(STATE_DIR);
  if (!fs.existsSync(STATE_FILE)) {
    const init = normalizeState({});
    await fsp.writeFile(STATE_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    const init = normalizeState({});
    await fsp.writeFile(STATE_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
}

async function saveState(state) {
  const st = normalizeState(state);
  await ensureDir(STATE_DIR);
  await fsp.writeFile(STATE_FILE, JSON.stringify(st, null, 2), "utf8");
}

async function appendJsonl(filePath, obj) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8");
}

// ---------- WhatsApp send ----------
async function sendWhatsAppText(toWaId, text, phoneNumberIdFromWebhook = "", statePhoneNumberId = "") {
  const phoneNumberId = PHONE_NUMBER_ID_ENV || phoneNumberIdFromWebhook || statePhoneNumberId;
  if (!WHATSAPP_TOKEN || !phoneNumberId) return;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "text",
    text: { body: text }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.log(`⚠️ WhatsApp send failed (${res.status}): ${t}`);
  }
}

// ---------- Media download (JPG speichern) ----------
function mimeToExt(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return "bin";
}

async function fetchMediaBinary(mediaId) {
  const metaUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}?fields=url,mime_type`;
  const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!metaRes.ok) {
    const t = await metaRes.text().catch(() => "");
    throw new Error(`Meta fetch failed (${metaRes.status}): ${t}`);
  }
  const meta = await metaRes.json();
  const mediaUrl = meta?.url;
  const mime = meta?.mime_type || "";
  if (!mediaUrl) throw new Error("No media url in metadata");

  const binRes = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!binRes.ok) {
    const t = await binRes.text().catch(() => "");
    throw new Error(`Binary fetch failed (${binRes.status}): ${t}`);
  }
  const buf = Buffer.from(await binRes.arrayBuffer());
  return { buf, mime };
}

// ---------- Mail ----------
function mailer() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendPdfMail({ code, day, pdfPath, reason }) {
  if (!SMTP_USER || !SMTP_PASS || !MAIL_FROM || !MAIL_TO) {
    console.log("⚠️ Mail not configured (SMTP_USER/PASS/MAIL_FROM/MAIL_TO missing).");
    return;
  }
  const subject = `Baustellenprotokoll #${code} – ${day}`;
  const text = `Automatisch erstellt (${reason}).`;
  await mailer().sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    text,
    attachments: [{ filename: path.basename(pdfPath), path: pdfPath }]
  });
}

// ---------- PDF runners ----------
async function buildAndMailPdfForCodeDay({ state, code, day, reason }) {
  const dayDir = path.join(DATA_DIR, code, day);
  if (!fs.existsSync(dayDir)) return { skipped: true, reason: "no day dir" };

  // nur senden, wenn heute wirklich irgendwas da ist (log oder images)
  const logPath = path.join(dayDir, "log.jsonl");
  const hasLog = fs.existsSync(logPath);

  const files = fs.existsSync(dayDir) ? await fsp.readdir(dayDir) : [];
  const hasImages = files.some((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));

  if (!hasLog && !hasImages) return { skipped: true, reason: "empty" };

  const pdfPath = path.join(dayDir, `Baustellenprotokoll_${code}_${day}.pdf`);
  await buildDailyPdf({ dataDir: DATA_DIR, code, day, outPath: pdfPath });
  await sendPdfMail({ code, day, pdfPath, reason });

  console.log(`✅ PDF mailed for #${code} (${day}) reason=${reason}`);
  return { skipped: false, pdfPath };
}

async function runDaily22() {
  const state = await loadState();
  const today = localDay();
  if (state.dailyPdfSentDate === today) return;

  // alle Codes, die heute einen Ordner haben
  const dirs = fs.existsSync(DATA_DIR) ? await fsp.readdir(DATA_DIR) : [];
  const codes = dirs.filter((d) => /^\d+$/.test(d)); // nur Nummern
  for (const code of codes) {
    await buildAndMailPdfForCodeDay({ state, code, day: today, reason: "daily-22" });
  }

  state.dailyPdfSentDate = today;
  await saveState(state);
}

function msUntilNext22() {
  // basiert auf Server-Zeit (mit TZ env: Europe/Vienna)
  const now = new Date();
  const next = new Date(now);
  next.setHours(22, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDaily22() {
  setTimeout(async () => {
    try { await runDaily22(); } catch (e) { console.log("daily22 error", e); }
    scheduleDaily22();
  }, msUntilNext22());
}

async function runInactivityCheck() {
  const state = await loadState();
  const now = Date.now();
  const today = localDay();

  for (const [code, lastMs] of Object.entries(state.lastActivityByCode)) {
    if (!code || code === "unknown") continue;
    const mins = (now - Number(lastMs || 0)) / 60000;
    if (mins < INACTIVITY_MINUTES) continue;

    const key = `${code}:${today}`;
    if (state.autoPdfSentForCodeDay[key]) continue; // nur 1× pro Tag

    const r = await buildAndMailPdfForCodeDay({ state, code, day: today, reason: `auto-${INACTIVITY_MINUTES}min` });
    if (!r.skipped) {
      state.autoPdfSentForCodeDay[key] = now;
      await saveState(state);
    }
  }
}

// ---------- Routes ----------
app.get("/", (req, res) => res.status(200).send("webhook läuft"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && challenge) {
    if (token === VERIFY_TOKEN) return res.status(200).send(String(challenge));
    return res.sendStatus(403);
  }
  return res.status(200).send("ok");
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const field = change?.field;

    if (field !== "messages" || !value) return;

    const phoneNumberIdFromWebhook = value?.metadata?.phone_number_id || "";
    const messages = value?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return;

    const state = await loadState();
    if (phoneNumberIdFromWebhook) state.lastPhoneNumberId = phoneNumberIdFromWebhook;

    for (const msg of messages) {
      const msgId = msg?.id || "";
      const from = msg?.from || "";
      const type = msg?.type || "unknown";
      if (!from) continue;

      // Dedup
      if (msgId) {
        if (state.seenMessageIds[msgId]) continue;
        state.seenMessageIds[msgId] = Math.floor(Date.now() / 1000);
      }

      const day = ymdFromUnixSeconds(msg?.timestamp);

      // TEXT
      if (type === "text") {
        const text = msg?.text?.body || "";

        // pdf command (A)
        if (isPdfCommand(text)) {
          const code = state.lastCodeBySender[from] || "unknown";
          if (code === "unknown") {
            await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT, phoneNumberIdFromWebhook, state.lastPhoneNumberId);
          } else {
            await buildAndMailPdfForCodeDay({ state, code, day: localDay(), reason: "whatsapp-pdf" });
            await sendWhatsAppText(from, `PDF wird per Mail gesendet für #${code}.`, phoneNumberIdFromWebhook, state.lastPhoneNumberId);
          }
          continue;
        }

        const found = extractCodeFromText(text);
        if (found) state.lastCodeBySender[from] = found;

        const codeForSave = state.lastCodeBySender[from] || "unknown";
        state.lastActivityByCode[codeForSave] = Date.now();

        const dir = path.join(DATA_DIR, codeForSave, day);
        await ensureDir(dir);

        const logPath = path.join(dir, "log.jsonl");
        await appendJsonl(logPath, {
          at: nowIso(),
          timestamp: msg?.timestamp,
          from,
          type: "text",
          message_id: msgId,
          text
        });

        if (!state.lastCodeBySender[from]) {
          const nowSec = Math.floor(Date.now() / 1000);
          const last = Number(state.lastPromptAtBySender[from] || 0);
          if (nowSec - last >= PROMPT_COOLDOWN_SEC) {
            state.lastPromptAtBySender[from] = nowSec;
            await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT, phoneNumberIdFromWebhook, state.lastPhoneNumberId);
          }
        }

        continue;
      }

      // IMAGE (JPG speichern)
      if (type === "image") {
        const mediaId = msg?.image?.id;
        const mimeHook = msg?.image?.mime_type || "";

        const codeForSave = state.lastCodeBySender[from] || "unknown";
        state.lastActivityByCode[codeForSave] = Date.now();

        const dir = path.join(DATA_DIR, codeForSave, day);
        await ensureDir(dir);

        if (mediaId) {
          try {
            const { buf, mime } = await fetchMediaBinary(mediaId);
            const ext = mimeToExt(mime || mimeHook);
            const filePath = path.join(dir, `${msg?.timestamp || Date.now()}_${mediaId}.${ext}`);
            await fsp.writeFile(filePath, buf);

            const logPath = path.join(dir, "log.jsonl");
            await appendJsonl(logPath, {
              at: nowIso(),
              timestamp: msg?.timestamp,
              from,
              type: "image",
              message_id: msgId,
              media_id: mediaId,
              file: path.basename(filePath),
              mime_type: mime || mimeHook
            });

            console.log(`✅ saved image file for #${codeForSave} -> ${filePath}`);
          } catch (e) {
            console.log("❌ media download failed:", e?.message || e);
          }
        }

        if (!state.lastCodeBySender[from]) {
          const nowSec = Math.floor(Date.now() / 1000);
          const last = Number(state.lastPromptAtBySender[from] || 0);
          if (nowSec - last >= PROMPT_COOLDOWN_SEC) {
            state.lastPromptAtBySender[from] = nowSec;
            await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT, phoneNumberIdFromWebhook, state.lastPhoneNumberId);
          }
        }

        continue;
      }
    }

    // Cleanup seen ids older than 7 days
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    for (const [k, v] of Object.entries(state.seenMessageIds)) {
      if (Number(v) < cutoff) delete state.seenMessageIds[k];
    }

    await saveState(state);
  } catch (err) {
    console.log("Webhook error:", err);
  }
});

// ---------- Schedulers ----------
setInterval(() => {
  runInactivityCheck().catch((e) => console.log("inactivity error", e));
}, 60 * 1000);

scheduleDaily22();

// ---------- Start ----------
app.listen(PORT, async () => {
  await ensureDir(DATA_DIR);
  await ensureDir(STATE_DIR);
  await loadState();
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`TZ=${TZ} (set ENV TZ=Europe/Vienna)`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`PHONE_NUMBER_ID env set: ${Boolean(PHONE_NUMBER_ID_ENV)}`);
  console.log("==> Your service is live 🎉");
});
