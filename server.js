// server.js  (ESM)
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import fetch from "node-fetch";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import multer from "multer";
import nodemailer from "nodemailer";

import { buildDailyPdfs, buildPdfForSiteToday } from "./pdf.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
app.use(express.json({ limit: "20mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const TZ = process.env.TZ || "Europe/Vienna";

const STATE_DIR = path.join(DATA_DIR, "_state");
const STATE_FILE = path.join(STATE_DIR, "last_code_by_sender.json");

const CODE_TTL_MIN = Number(process.env.CODE_TTL_MIN || "10"); // 10 Minuten
const ASK_TEXT = process.env.ASK_TEXT || "Bitte Baustellennummer mit # vorab senden";

// Mail (Brevo)
const MAIL_HOST = process.env.MAIL_HOST || "smtp-relay.brevo.com";
const MAIL_PORT = Number(process.env.MAIL_PORT || "587");
const MAIL_USER = process.env.MAIL_USER || "";
const MAIL_PASS = process.env.MAIL_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const MAIL_TO = process.env.MAIL_TO || "";

// ---------- Helpers ----------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function safeWriteJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function nowTz() {
  return dayjs().tz(TZ);
}

function todayStr() {
  return nowTz().format("YYYY-MM-DD");
}

function extractSiteCode(text) {
  // findet #260016 (6-stellig) oder allgemein # + digits
  const m = String(text || "").match(/#(\d{3,})/);
  return m ? m[1] : null;
}

function isPdfCommand(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "pdf" || t.startsWith("pdf ");
}

function parsePdfCommand(text) {
  // "pdf" oder "pdf #260016"
  const t = String(text || "").trim();
  const code = extractSiteCode(t);
  return { code };
}

function getState() {
  return safeReadJson(STATE_FILE, {});
}

function setLastCode(sender, code) {
  const st = getState();
  st[sender] = { code, ts: Date.now() };
  safeWriteJson(STATE_FILE, st);
}

function getLastCode(sender) {
  const st = getState();
  return st[sender] || null;
}

function pickCodeForSender(sender) {
  const entry = getLastCode(sender);
  if (!entry) return null;
  const ageMin = (Date.now() - entry.ts) / 60000;
  if (ageMin <= CODE_TTL_MIN) return entry.code;
  return null;
}

function saveText(site, sender, text) {
  const dir = path.join(DATA_DIR, site, todayStr());
  ensureDir(dir);
  const file = path.join(dir, "log.jsonl");
  const line = JSON.stringify({
    ts: nowTz().toISOString(),
    type: "text",
    sender,
    text,
  });
  fs.appendFileSync(file, line + "\n");
  console.log(`✅ saved text for #${site} -> ${file}`);
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, buf);
}

async function fetchMediaUrl(mediaId) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const j = await res.json();
  if (!j.url) throw new Error("no media url in response");
  return j.url;
}

function saveMetaLine(site, obj) {
  const dir = path.join(DATA_DIR, site);
  ensureDir(dir);
  const file = path.join(dir, `${todayStr()}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
  console.log(`✅ saved message for #${site} -> ${file}`);
}

// WhatsApp send text
async function waSendText(to, body) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) return;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  if (!res.ok) console.log("waSendText error:", j);
}

// Mailer
function getMailer() {
  if (!MAIL_HOST || !MAIL_USER || !MAIL_PASS || !MAIL_FROM || !MAIL_TO) return null;
  return nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: false,
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });
}

async function mailPdf(site, pdfPath) {
  const tr = getMailer();
  if (!tr) throw new Error("Mailer not configured (MAIL_* env missing)");
  const subject = `Baustellenprotokoll #${site} – ${todayStr()}`;
  const text = `Anbei das Baustellenprotokoll für #${site} (${todayStr()}).`;

  await tr.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    text,
    attachments: [{ filename: `Baustellenprotokoll_${site}_${todayStr()}.pdf`, path: pdfPath }],
  });
}

// ---------- Routes ----------

// Verify (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Incoming
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value;
        if (!v?.messages?.length) continue;

        for (const msg of v.messages) {
          const sender = msg.from; // wa_id
          const type = msg.type;

          // TEXT
          if (type === "text") {
            const text = msg.text?.body || "";
            const code = extractSiteCode(text);

            // PDF command?
            if (isPdfCommand(text)) {
              const { code: explicit } = parsePdfCommand(text);
              const useCode = explicit || pickCodeForSender(sender);

              if (!useCode) {
                await waSendText(sender, ASK_TEXT);
                continue;
              }

              // build PDF for TODAY for that site
              const pdfPath = await buildPdfForSiteToday({
                dataDir: DATA_DIR,
                site: useCode,
                tz: TZ,
              });

              // mail it
              await mailPdf(useCode, pdfPath);

              await waSendText(sender, `PDF wird per E-Mail gesendet für #${useCode}.`);
              continue;
            }

            // Baustellencode?
            if (code) {
              setLastCode(sender, code);
              saveText(code, sender, text);
              saveMetaLine(code, { ts: nowTz().toISOString(), kind: "in_text", sender, text });
              await waSendText(sender, `OK – Baustelle #${code} ist gesetzt. Du kannst jetzt Fotos senden.`);
            } else {
              // normal text: wenn ein gültiger Code im Fenster aktiv ist -> der Baustelle zuordnen
              const active = pickCodeForSender(sender);
              const site = active || "unknown";
              saveText(site, sender, text);
              saveMetaLine(site, { ts: nowTz().toISOString(), kind: "text", sender, text });

              if (!active) await waSendText(sender, ASK_TEXT);
            }
          }

          // IMAGE / DOCUMENT / VIDEO / AUDIO
          if (["image", "document", "video", "audio"].includes(type)) {
            const active = pickCodeForSender(sender);
            const site = active || "unknown";

            const media = msg[type];
            const mediaId = media?.id;
            const mime = media?.mime_type || "";

            const dir = path.join(DATA_DIR, site, todayStr());
            ensureDir(dir);

            // filename
            const extFromMime = (m) => {
              if (m.includes("jpeg")) return "jpg";
              if (m.includes("png")) return "png";
              if (m.includes("pdf")) return "pdf";
              if (m.includes("mp4")) return "mp4";
              if (m.includes("ogg")) return "ogg";
              return "bin";
            };
            const ext = extFromMime(mime);
            const name = `${msg.timestamp || Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
            const outPath = path.join(dir, name);

            if (mediaId) {
              const url = await fetchMediaUrl(mediaId);
              await downloadToFile(url, outPath);
              console.log(`✅ saved ${type} for #${site} -> ${outPath}`);
              saveMetaLine(site, { ts: nowTz().toISOString(), kind: type, sender, outPath, mime });
            } else {
              console.log("⚠️ no media id");
            }

            if (!active) await waSendText(sender, ASK_TEXT);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("webhook error", e);
    res.sendStatus(200);
  }
});

// Health
app.get("/", (req, res) => res.send("webhook läuft"));

// Admin: daily PDFs at once
app.get("/admin/run-daily", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(403);
  try {
    const result = await buildDailyPdfs({ dataDir: DATA_DIR, tz: TZ, mailFn: mailPdf });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin: one site now (optional)
app.get("/admin/run-site", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(403);
  const site = String(req.query.site || "");
  if (!site) return res.status(400).send("missing site");
  try {
    const pdfPath = await buildPdfForSiteToday({ dataDir: DATA_DIR, site, tz: TZ });
    await mailPdf(site, pdfPath);
    res.json({ ok: true, site, pdfPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

ensureDir(DATA_DIR);
ensureDir(STATE_DIR);

console.log(`DATA_DIR=${DATA_DIR}`);
console.log(`STATE_FILE=${STATE_FILE}`);
console.log(`PHONE_NUMBER_ID set: ${!!PHONE_NUMBER_ID}`);

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
