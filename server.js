// server.js (CommonJS) – Baustellenprotokoll FINAL + Admin UI
// ✅ WhatsApp Webhook (Text/Foto/Audio/PDF) -> speichert alles
// ✅ Trigger per WhatsApp: "pdf" (oder "#260016 pdf")
// ✅ Layout A: Text + Transkripte seitenfüllend, danach Fotos (6 pro Seite), WhatsApp-PDFs (Seite 1) eingebettet
// ✅ Deckblatt mit Logo (optional)
// ✅ Kopf-/Fußzeile: Baustellennummer + Datum + Seitenzahl
// ✅ Ordnerstruktur neu: /var/data/<job>/<YYYY>/<MM>/<DD>/...
//    + Fallback liest auch alte Struktur: /var/data/<job>/<YYYY-MM-DD>/...
// ✅ Sprachnachricht: Audio speichern + transkribieren + Dialekt "sauber" formulieren (optional)
// ✅ Admin: /admin oder /admin/ui + API + PDF View/Download + Akte + Löschen/Umbenennen/Zusammenführen
// ✅ Mailversand NEU: PDF bleibt am Server, Mail enthält nur Download-Link (kein großer Anhang)
// ✅ @ und # Kennung: @26072, #26072, @Raika-Alberschwende, #Raika-Alberschwende
//
// Render ENV (wichtig):
// DATA_DIR=/var/data
// VERIFY_TOKEN=...
// WHATSAPP_TOKEN=...
// ADMIN_TOKEN=...
// PUBLIC_BASE_URL=https://protokoll.krista.at
//
// SMTP (SendGrid):
// SMTP_HOST=smtp.sendgrid.net
// SMTP_PORT=587
// SMTP_USER=apikey
// SMTP_PASS=<SENDGRID_API_KEY>
// MAIL_FROM=protokoll@krista.at
// MAIL_TO_DEFAULT=alex@krista.at
//
// OpenAI:
// OPENAI_API_KEY=...
// OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
// OPENAI_TRANSCRIBE_LANG=de
// OPENAI_TEXT_MODEL=gpt-4o-mini
//
// Logo optional:
// LOGO_PATH=krista-logo.png   (oder assets/krista-logo.png)
//
// Optional Trigger-Allowlist:
// PDF_ALLOWED_FROM=4366...,43...
// PDF_IGNORE_UNKNOWN=1

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const sharp = require("sharp");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { registerKristine } = require("./kristine");
const { registerMorningStatus, clampStartTime } = require("./morning-status");

const app = express();
app.use(express.json({ limit: "25mb" }));

// ===================== Version =====================
const APP_VERSION = "3.4.5";
const APP_BUILD = "0014-protokoll-morgenstatus";
const APP_STATUS = "WhatsApp Live Alpha";
const APP_BUILD_DATE = "2026-07-17";

// Static files for Admin UI
app.use("/public", express.static("public"));

// ===================== ENV =====================
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || "/var/data";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const MAIL_TO_DEFAULT = process.env.MAIL_TO_DEFAULT || "";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "https://protokoll.krista.at").replace(/\/$/, "");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_TRANSCRIBE_LANG = process.env.OPENAI_TRANSCRIBE_LANG || "de";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

const LOGO_PATH = process.env.LOGO_PATH || "assets/krista-logo.png";

const PDF_ALLOWED_FROM = process.env.PDF_ALLOWED_FROM || "";
const PDF_IGNORE_UNKNOWN = String(process.env.PDF_IGNORE_UNKNOWN || "").trim() === "1";

const CHEF_PHONE = process.env.CHEF_PHONE || "";
const KRISTINE_PHONE_NUMBER_ID = process.env.KRISTINE_PHONE_NUMBER_ID || "";

// ===================== Baustellenprotokoll-Sitzungen =====================
// Ein Protokoll beginnt ausschließlich mit @baustellenname am Nachrichtenanfang
// und bleibt bis zum Befehl "pdf" aktiv. Die Sitzung wird zusätzlich auf Disk
// gespeichert, damit ein Render-Neustart sie nicht verliert.
const PROTOCOL_BY_SENDER = {}; // { wa_id: { siteCode, startedAt } }
const LATE_TIME_PENDING = {};  // Mitarbeiter wartet auf ungefähre Ankunftszeit
const PROTOCOL_START_PENDING = {}; // Chef hat "protokoll"/"proto" gestartet und wählt/sucht/erstellt die Baustelle

function digitsOnly(value) { return String(value || "").replace(/\D/g, ""); }
function isChefSender(sender) {
  const chef = digitsOnly(CHEF_PHONE);
  const from = digitsOnly(sender);
  if (!chef || !from) return false;
  return from === chef || from.endsWith(chef) || chef.endsWith(from);
}
function isProtocolCommand(text) {
  return /^(proto|protokoll)$/i.test(String(text || "").trim());
}
function jobIdFromName(name) {
  return normalizeSiteCode(String(name || ""))
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || `Baustelle_${Date.now()}`;
}
async function findProtocolJobs(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const entries = await fsp.readdir(DATA_DIR).catch(() => []);
  const jobs = [];
  for (const jobId of entries) {
    if (!jobId || ["unknown", "_unassigned", "_kristine"].includes(jobId) || !isSafeJobId(jobId)) continue;
    if (!fs.existsSync(path.join(DATA_DIR, jobId))) continue;
    const meta = await readJobMeta(jobId);
    const name = String(meta.name || "");
    const idLower = String(jobId).toLowerCase();
    const nameLower = name.toLowerCase();
    let score = 0;
    if (idLower === needle || nameLower === needle) score = 3;
    else if (idLower.startsWith(needle) || nameLower.startsWith(needle)) score = 2;
    else if (idLower.includes(needle) || nameLower.includes(needle)) score = 1;
    if (score) jobs.push({ jobId, name: name || jobId, score });
  }
  return jobs.sort((a,b) => b.score-a.score || a.name.localeCompare(b.name, "de"));
}

function protocolSessionsPath() {
  return path.join(DATA_DIR, "_kristine", "protocol-sessions.json");
}
async function loadProtocolSessions() {
  try {
    const rows = JSON.parse(await fsp.readFile(protocolSessionsPath(), "utf8"));
    if (rows && typeof rows === "object") Object.assign(PROTOCOL_BY_SENDER, rows);
  } catch {}
}
async function saveProtocolSessions() {
  await ensureDir(path.dirname(protocolSessionsPath()));
  await fsp.writeFile(protocolSessionsPath(), JSON.stringify(PROTOCOL_BY_SENDER, null, 2), "utf8");
}
async function startProtocol(sender, siteCode) {
  PROTOCOL_BY_SENDER[sender] = { siteCode, startedAt: new Date().toISOString() };
  await saveProtocolSessions();
}
async function stopProtocol(sender) {
  delete PROTOCOL_BY_SENDER[sender];
  await saveProtocolSessions();
}
function activeProtocol(sender) {
  return PROTOCOL_BY_SENDER[sender]?.siteCode || null;
}
function parseProtocolStart(text) {
  // Nur @ als erstes Zeichen. Erstes Token bis zum Leerzeichen ist der Name.
  // Unterstrich und Bindestrich verbinden Bestandteile des Baustellennamens.
  const match = String(text || "").trim().match(/^@([A-Za-z0-9ÄÖÜäöüß_-]{2,80})(?:\s|$)/u);
  return match ? normalizeSiteCode(match[1]) : null;
}

// ===================== Helpers =====================
function ensureDirSync(p) {
  fs.mkdirSync(p, { recursive: true });
}
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}
async function appendJsonl(filePath, obj) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8");
}
function todayISO(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function isoDateFromWhatsAppTs(tsSeconds) {
  const n = Number(tsSeconds || 0);
  const d = n ? new Date(n * 1000) : new Date();
  return todayISO(d);
}
function normalizeSiteCode(raw) {
  return String(raw || "")
    .trim()
    .replace(/^[@#]+/, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss");
}

function parseSiteCodeFromText(text) {
  // Erlaubt @ und #:
  // @26072, #26072, @Raika-Alberschwende, #SVS_Feldkirch, @Bad-OG
  // Erlaubte Zeichen: Buchstaben, Zahlen, Minus, Unterstrich.
  // Wichtig: E-Mail-Adressen wie alex@krista.at werden NICHT als Baustelle erkannt.
  const s = String(text || "");
  const re = /(^|[\s(])([@#])([A-Za-z0-9ÄÖÜäöüß_-]{2,80})(?=\s|$|[.,;:!?)]|\])/gu;

  for (const m of s.matchAll(re)) {
    const marker = m[2];
    const rawCode = m[3];
    const end = m.index + m[0].length;
    const after = s.slice(end);

    // Schutz vor E-Mail-Adressen mit Abstand, z.B. "alex @krista.at"
    if (marker === "@" && after.startsWith(".") && /^[A-Za-z]{2,10}\b/.test(after.slice(1))) {
      continue;
    }

    const code = normalizeSiteCode(rawCode);
    if (/^[A-Za-z0-9_-]{2,80}$/.test(code)) return code;
  }

  return null;
}
function parseCaptionTextFromMessage(msg) {
  if (msg.type === "text") return msg.text?.body || "";
  if (msg.type === "image") return msg.image?.caption || "";
  if (msg.type === "video") return msg.video?.caption || "";
  return "";
}
function stampDE(tsSeconds) {
  const n = Number(tsSeconds || 0);
  const d = n ? new Date(n * 1000) : null;
  if (!d) return "";
  return d.toLocaleString("de-AT", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function stampDEFromFilename(fname) {
  const m = String(fname).match(/^(\d{10})_/);
  if (!m) return "";
  return stampDE(m[1]);
}
function isPdfCommand(text) {
  const t = String(text || "").trim().toLowerCase();
  return /\bpdf\b/.test(t);
}
function isAllowedPdfSender(sender) {
  if (!PDF_ALLOWED_FROM.trim()) return true;
  const allowed = PDF_ALLOWED_FROM.split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(String(sender || "").trim());
}
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) return true;
  const tok = req.headers["x-admin-token"] || req.query.token || "";
  if (tok !== ADMIN_TOKEN) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

function fileSizeMB(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MB`;
}
function pdfUrlFor(jobId, date) {
  const token = ADMIN_TOKEN ? `?token=${encodeURIComponent(ADMIN_TOKEN)}` : "";
  return `${PUBLIC_BASE_URL}/admin/pdf/${encodeURIComponent(jobId)}/${encodeURIComponent(date)}${token}`;
}
function pdfDownloadUrlFor(jobId, date) {
  const token = ADMIN_TOKEN ? `?token=${encodeURIComponent(ADMIN_TOKEN)}` : "";
  return `${PUBLIC_BASE_URL}/admin/download/${encodeURIComponent(jobId)}/${encodeURIComponent(date)}${token}`;
}

// ===================== Folder structure (NEW + fallback) =====================
function dayDirNew(jobId, dateStr) {
  const [Y, M, D] = String(dateStr).split("-");
  return path.join(DATA_DIR, String(jobId), Y, M, D);
}
function dayDirOld(jobId, dateStr) {
  return path.join(DATA_DIR, String(jobId), String(dateStr)); // old: /job/YYYY-MM-DD
}
function resolveExistingDayDir(jobId, dateStr) {
  const n = dayDirNew(jobId, dateStr);
  if (fs.existsSync(n)) return n;
  const o = dayDirOld(jobId, dateStr);
  if (fs.existsSync(o)) return o;
  return n; // default if none exists yet
}
function resolveDayDirForWrite(jobId, dateStr) {
  return dayDirNew(jobId, dateStr); // always write to new structure
}

// ===================== HTTP helpers =====================
async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}: ${t}`);
  }
  return await r.json();
}
async function fetchBuffer(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}: ${t}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// ===================== WhatsApp Media Download =====================
async function downloadWhatsAppMedia(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN missing");

  const meta = await fetchJson(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!meta?.url) throw new Error("No media url from Graph");

  const buf = await fetchBuffer(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  return { buf, mime: meta.mime_type || "application/octet-stream" };
}

// ===================== OpenAI: Transcription + clean polish =====================
async function transcribeAudio({ audioBuffer, filename = "audio.ogg", mimeType = "audio/ogg" }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append("file", blob, filename);
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  if (OPENAI_TRANSCRIBE_LANG) form.append("language", OPENAI_TRANSCRIBE_LANG);

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI transcription failed (${r.status}): ${t}`);
  }
  const j = await r.json();
  return j.text || "";
}

function extractResponsesText(json) {
  if (!json) return "";
  if (typeof json.output_text === "string") return json.output_text;

  const out = json.output;
  if (Array.isArray(out)) {
    const parts = [];
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
    return parts.join("").trim();
  }
  return "";
}

async function polishGermanTranscript(rawText) {
  if (!OPENAI_API_KEY) return String(rawText || "");

  const payload = {
    model: OPENAI_TEXT_MODEL,
    input: [
      {
        role: "system",
        content:
          "Du bist Baustellen-Protokollant. Formuliere das folgende Transkript in sauberem, sachlichem Hochdeutsch, sinngemäß, kurz und präzise. " +
          "Keine erfundenen Details. Entferne Füllwörter. Wenn sinnvoll, verwende kurze Sätze. Keine Emojis.",
      },
      { role: "user", content: String(rawText || "") },
    ],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI polish failed (${r.status}): ${t}`);
  }

  const j = await r.json();
  const txt = extractResponsesText(j);
  return (txt || "").trim() || String(rawText || "").trim();
}

// ===================== Mail (SMTP) =====================
function makeMailer() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}
async function sendMailWithAttachment({ to, subject, text, filePath }) {
  try {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
      throw new Error("SMTP env missing (SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM)");
    }
    const buf = await fsp.readFile(filePath);
    const mailer = makeMailer();
    const info = await mailer.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text,
      attachments: [{ filename: path.basename(filePath), content: buf, contentType: "application/pdf" }],
    });
    return info;
  } catch (e) {
    console.error("❌ Mail send failed:", e?.message || e);
    return null;
  }
}

async function sendMailWithLink({ to, subject, text, html }) {
  try {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
      throw new Error("SMTP env missing (SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM)");
    }
    const mailer = makeMailer();
    const info = await mailer.sendMail({ from: MAIL_FROM, to, subject, text, html });
    return info;
  } catch (e) {
    console.error("❌ Mail send failed:", e?.message || e);
    return null;
  }
}

// ===================== PDF Build (Layout A + Logo + Header/Footer) =====================
async function listFiles(dayDir) {
  return (await fsp.readdir(dayDir).catch(() => [])).slice().sort();
}
async function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = await fsp.readFile(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const items = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {}
  }
  return items;
}
function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function buildPdfForJobDay(jobId, date, dayDir, outPdfPath) {
  const PAGE_W = 1190.55; // A3 landscape
  const PAGE_H = 841.89;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Logo optional
  let logoImg = null;
  try {
    const logoBytes = await fsp.readFile(
      path.isAbsolute(LOGO_PATH) ? LOGO_PATH : path.join(process.cwd(), LOGO_PATH)
    );
    logoImg = await pdf.embedPng(logoBytes);
  } catch {
    logoImg = null;
  }

  const logPath = path.join(dayDir, "log.jsonl");
  const logs = await readJsonLines(logPath);

  logs.sort(
    (a, b) =>
      (a.raw?.timestamp ? Number(a.raw.timestamp) : 0) -
      (b.raw?.timestamp ? Number(b.raw.timestamp) : 0)
  );

  const files = await listFiles(dayDir);
  const imageFiles = files.filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
  const jobMeta = await readJobMeta(jobId);
  const jobDisplayName = jobMeta.name || "";

  function drawHeaderFooter(page, pageNo, totalPages) {
    const headerText = jobDisplayName ? `#${jobId}  |  ${jobDisplayName}  |  ${date}` : `#${jobId}  |  ${date}`;
    page.drawText(headerText, {
      x: 60,
      y: PAGE_H - 40,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
      maxWidth: PAGE_W - 120,
    });
    page.drawLine({
      start: { x: 60, y: PAGE_H - 48 },
      end: { x: PAGE_W - 60, y: PAGE_H - 48 },
      thickness: 1,
      color: rgb(0.9, 0.9, 0.9),
    });

    const footer = `Seite ${pageNo} / ${totalPages}`;
    page.drawLine({
      start: { x: 60, y: 44 },
      end: { x: PAGE_W - 60, y: 44 },
      thickness: 1,
      color: rgb(0.9, 0.9, 0.9),
    });
    page.drawText(footer, {
      x: PAGE_W - 60 - 140,
      y: 28,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  }

  // Cover
  {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawText("Baustellenprotokoll", { x: 60, y: PAGE_H - 90, size: 38, font: fontBold });
    page.drawText(`#${jobId}`, { x: 60, y: PAGE_H - 140, size: 24, font: fontBold });
    if (jobDisplayName) page.drawText(jobDisplayName, { x: 60, y: PAGE_H - 170, size: 20, font: fontBold, maxWidth: PAGE_W - 420 });
    page.drawText(`Datum: ${date}`, { x: 60, y: PAGE_H - 205, size: 16, font });
    page.drawText(`Einträge: ${logs.length}`, { x: 60, y: PAGE_H - 235, size: 16, font });
    page.drawText(`Fotos: ${imageFiles.length}`, { x: 60, y: PAGE_H - 265, size: 16, font });

    page.drawText("Layout: Text/Transkripte seitenfüllend, danach Fotos (6 pro Seite)", {
      x: 60,
      y: 80,
      size: 12,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });

    if (logoImg) {
      const logoW = 260;
      const scale = logoW / logoImg.width;
      const logoH = logoImg.height * scale;
      page.drawImage(logoImg, {
        x: PAGE_W - 60 - logoW,
        y: PAGE_H - 60 - logoH,
        width: logoW,
        height: logoH,
      });
    }
  }

  // TEXT SECTION
  const textLines = [];
  for (const entry of logs) {
    const raw = entry.raw || {};
    const stamp = raw.timestamp ? stampDE(raw.timestamp) : "";

    if (entry.type === "text" && raw.text?.body) {
      const body = String(raw.text.body).trim();
      if (body) textLines.push(`${stamp}  ${body}`);
    }
    if (entry.type === "audio_transcript" && entry.transcript) {
      textLines.push(`${stamp}  Sprachnachricht: ${String(entry.transcript).trim()}`);
    }
    if (entry.type === "transcription_failed") {
      const msg = entry.error ? ` (Fehler: ${entry.error})` : "";
      textLines.push(`${stamp}  Sprachnachricht: Transkription fehlgeschlagen${msg}`);
    }
  }

  if (textLines.length) {
    const left = 60;
    const right = 60;
    const top = 95;
    const bottom = 70;

    const fontSize = 12;
    const lineH = 16;
    const maxChars = 150;

    let page = pdf.addPage([PAGE_W, PAGE_H]);

    const drawTitle = (title) => {
      page.drawText(title, { x: left, y: PAGE_H - 70, size: 18, font: fontBold });
      page.drawLine({
        start: { x: left, y: PAGE_H - 78 },
        end: { x: PAGE_W - right, y: PAGE_H - 78 },
        thickness: 1,
        color: rgb(0.85, 0.85, 0.85),
      });
    };

    drawTitle("Text / Notizen / Transkripte");
    let y = PAGE_H - top;

    for (const block of textLines) {
      const wrapped = wrapText(block, maxChars);

      for (const line of wrapped) {
        if (y < bottom) {
          page = pdf.addPage([PAGE_W, PAGE_H]);
          drawTitle("Text / Notizen / Transkripte (Fortsetzung)");
          y = PAGE_H - top;
        }
        page.drawText(line, {
          x: left,
          y,
          size: fontSize,
          font,
          maxWidth: PAGE_W - left - right,
          color: rgb(0.1, 0.1, 0.1),
        });
        y -= lineH;
      }

      y -= 6;
      if (y < bottom) {
        page = pdf.addPage([PAGE_W, PAGE_H]);
        drawTitle("Text / Notizen / Transkripte (Fortsetzung)");
        y = PAGE_H - top;
      }
    }
  }
// PDF SECTION: alle Seiten einbinden, 6 Seiten pro A3-Seite (3x2)
for (const entry of logs) {
  if (entry.type !== "pdf" || !entry.file) continue;

  const pdfFilePath = path.join(dayDir, entry.file);
  if (!fs.existsSync(pdfFilePath)) continue;

  try {
    const srcBytes = await fsp.readFile(pdfFilePath);
    const srcPdf = await PDFDocument.load(srcBytes);
    const pageCount = srcPdf.getPageCount();

    const cols = 3;
    const rows = 2;
    const margin = 40;
    const gutter = 18;

    const titleH = 40;      // oben Titelbereich
    const captionH = 18;    // pro Kachel Caption
    const gridTop = 95;     // Abstand von oben (unter Headerlinie)
    const gridBottom = 70;  // Abstand unten (über Footerlinie)

    const usableW = PAGE_W - margin * 2 - gutter * (cols - 1);
    const usableH = (PAGE_H - gridTop - gridBottom) - gutter * (rows - 1);

    const cellW = usableW / cols;
    const cellH = usableH / rows;

    const stamp = entry.raw?.timestamp ? stampDE(entry.raw.timestamp) : "";

    // Seiten in 6er-Blöcken einbetten
    for (let start = 0; start < pageCount; start += 6) {
      const idxs = [];
      for (let k = start; k < Math.min(start + 6, pageCount); k++) idxs.push(k);

      // embedPdf kann mehrere Seiten auf einmal einbetten
      const embeddedPages = await pdf.embedPdf(srcBytes, idxs);

      const page = pdf.addPage([PAGE_W, PAGE_H]);

      // Titel
      page.drawText(`PDF: ${entry.file} (${pageCount} Seiten)`, {
        x: 60,
        y: PAGE_H - 70,
        size: 18,
        font: fontBold,
      });

      page.drawLine({
        start: { x: 60, y: PAGE_H - 78 },
        end: { x: PAGE_W - 60, y: PAGE_H - 78 },
        thickness: 1,
        color: rgb(0.85, 0.85, 0.85),
      });

      // 6-up Grid
      for (let j = 0; j < embeddedPages.length; j++) {
        const col = j % cols;
        const row = Math.floor(j / cols);

        const x0 = margin + col * (cellW + gutter);
        const yTop = PAGE_H - gridTop - row * (cellH + gutter);

        const targetW = Math.floor(cellW);
        const targetH = Math.floor(cellH - captionH);

        const ep = embeddedPages[j];

        // scale to fit
        const scale = Math.min(targetW / ep.width, targetH / ep.height);
        const drawW = ep.width * scale;
        const drawH = ep.height * scale;

        const x = x0 + (targetW - drawW) / 2;
        const y = yTop - captionH - drawH;

        // draw embedded PDF page
        page.drawPage(ep, { x, y, width: drawW, height: drawH });

        // Caption: Timestamp + Dateiname + Seitennummer
        const pageNo = idxs[j] + 1;
        const cap = `${stamp ? stamp + "  |  " : ""}${entry.file}  |  Seite ${pageNo}/${pageCount}`;

        page.drawText(cap, {
          x: x0,
          y: yTop - captionH + 4,
          size: 10,
          font,
          color: rgb(0.2, 0.2, 0.2),
          maxWidth: targetW,
        });

        // optional: dünner Rahmen
        page.drawRectangle({
          x: x0,
          y: yTop - captionH - targetH,
          width: targetW,
          height: targetH + captionH,
          borderWidth: 1,
          borderColor: rgb(0.92, 0.92, 0.92),
        });
      }
    }
  } catch (e) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawText("PDF (Fehler beim Einbetten)", { x: 60, y: PAGE_H - 80, size: 18, font: fontBold });
    page.drawText(String(e?.message || e), {
      x: 60,
      y: PAGE_H - 130,
      size: 12,
      font,
      maxWidth: PAGE_W - 120,
    });
  }
}



  // PHOTOS SECTION: 6 per page (3x2)
  if (imageFiles.length) {
    const cols = 3;
    const rows = 2;
    const margin = 40;
    const gutter = 18;
    const cellW = (PAGE_W - margin * 2 - gutter * (cols - 1)) / cols;
    const cellH = (PAGE_H - margin * 2 - gutter * (rows - 1)) / rows;

    for (let i = 0; i < imageFiles.length; i += 6) {
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      const chunk = imageFiles.slice(i, i + 6);

      page.drawText("Fotos", { x: 60, y: PAGE_H - 70, size: 18, font: fontBold });
      page.drawLine({
        start: { x: 60, y: PAGE_H - 78 },
        end: { x: PAGE_W - 60, y: PAGE_H - 78 },
        thickness: 1,
        color: rgb(0.85, 0.85, 0.85),
      });

      for (let j = 0; j < chunk.length; j++) {
        const col = j % cols;
        const row = Math.floor(j / cols);

        const x0 = margin + col * (cellW + gutter);
        const yTop = PAGE_H - 95 - row * (cellH + gutter);

        const captionH = 28;
        const targetW = Math.floor(cellW);
        const targetH = Math.floor(cellH - captionH);

        const fname = chunk[j];
        const imgPath = path.join(dayDir, fname);

let imgBuf = await fsp.readFile(imgPath);

try {
  const JPEG_QUALITY = Number(process.env.JPEG_QUALITY || 75);
  const MAX_IMG_PX = Number(process.env.MAX_IMG_PX || 1800);

  imgBuf = await sharp(imgBuf)
    .rotate()
    .resize({
      width: MAX_IMG_PX,
      height: MAX_IMG_PX,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({
      quality: JPEG_QUALITY,
      mozjpeg: true,
      chromaSubsampling: "4:4:4"
    })
    .toBuffer();
} catch {}


        let img;
        try {
          img = await pdf.embedJpg(imgBuf);
        } catch {
          img = await pdf.embedPng(imgBuf);
        }

        const w0 = img.width;
        const h0 = img.height;
        const scale = Math.min(targetW / w0, targetH / h0);
        const drawW = w0 * scale;
        const drawH = h0 * scale;

        const x = x0 + (targetW - drawW) / 2;
        const y = yTop - captionH - drawH;

        page.drawImage(img, { x, y, width: drawW, height: drawH });

        const stamp = stampDEFromFilename(fname);
        const caption = stamp ? `${stamp}  |  ${fname}` : fname;

        page.drawText(caption, {
          x: x0,
          y: yTop - captionH + 8,
          size: 10,
          font,
          color: rgb(0.2, 0.2, 0.2),
        });
      }
    }
  }

  // Apply header/footer with correct total pages
  const pages = pdf.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    drawHeaderFooter(pages[i], i + 1, total);
  }

  const bytes = await pdf.save();
  await ensureDir(path.dirname(outPdfPath));
  await fsp.writeFile(outPdfPath, bytes);
  return { pages: total, bytes: bytes.length };
}


// ===================== Baustellenakte PDF =====================
function formatDateLongDE(dateStr) {
  try {
    const d = new Date(String(dateStr) + "T12:00:00");
    return d.toLocaleDateString("de-AT", { weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return String(dateStr || "");
  }
}

function shortDateDE(dateStr) {
  try {
    const d = new Date(String(dateStr) + "T12:00:00");
    return d.toLocaleDateString("de-AT", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return String(dateStr || "");
  }
}

async function buildAkteForJob(jobId, outPdfPath) {
  const PAGE_W = 1190.55; // A3 landscape
  const PAGE_H = 841.89;

  const days = (await listDaysForJob(jobId)).slice().sort(); // chronologisch
  if (!days.length) throw new Error(`Keine Tage für #${jobId} gefunden`);

  const meta = await readJobMeta(jobId);
  const title = meta.name ? `${meta.name}` : `#${jobId}`;
  const generatedAt = new Date().toLocaleString("de-AT");

  const akte = await PDFDocument.create();
  const font = await akte.embedFont(StandardFonts.Helvetica);
  const fontBold = await akte.embedFont(StandardFonts.HelveticaBold);

  // Logo optional
  let logoImg = null;
  try {
    const logoBytes = await fsp.readFile(
      path.isAbsolute(LOGO_PATH) ? LOGO_PATH : path.join(process.cwd(), LOGO_PATH)
    );
    logoImg = await akte.embedPng(logoBytes);
  } catch {
    logoImg = null;
  }

  // Tagesdaten vorbereiten: Tages-PDFs erzeugen, Seiten zählen, Statistiken sammeln
  const dayInfos = [];
  const totalStats = { items: 0, images: 0, audio: 0, pdfs: 0 };

  for (const day of days) {
    const dayDir = resolveExistingDayDir(jobId, day);
    if (!fs.existsSync(dayDir)) continue;

    const stats = await readLogStats(dayDir);
    totalStats.items += stats.items;
    totalStats.images += stats.images;
    totalStats.audio += stats.audio;
    totalStats.pdfs += stats.pdfs;

    const dayPdfPath = path.join(dayDir, `Baustellenprotokoll_${jobId}_${day}.pdf`);
    if (!fs.existsSync(dayPdfPath)) {
      await buildPdfForJobDay(jobId, day, dayDir, dayPdfPath);
    }

    let pageCount = 0;
    try {
      const srcBytes = await fsp.readFile(dayPdfPath);
      const srcPdf = await PDFDocument.load(srcBytes);
      pageCount = srcPdf.getPageCount();
    } catch {
      pageCount = 1; // Fehlerseite
    }

    dayInfos.push({ day, dayDir, stats, dayPdfPath, pageCount });
  }

  if (!dayInfos.length) throw new Error(`Keine lesbaren Bautage für #${jobId} gefunden`);

  // Inhaltsverzeichnis-Seiten berechnen
  const tocRowsPerPage = 26;
  const tocPages = Math.max(1, Math.ceil(dayInfos.length / tocRowsPerPage));

  let nextPageNo = 1 + tocPages + 1; // Deckblatt + Inhaltsverzeichnis + erste Trennseite
  for (const info of dayInfos) {
    info.startPage = nextPageNo;
    info.protocolStartPage = nextPageNo + 1;
    nextPageNo += 1 + info.pageCount; // Trennseite + Tagesprotokoll
  }
  const summaryStartPage = nextPageNo;

  function drawLogo(page) {
    if (!logoImg) return;
    const logoW = 260;
    const scale = logoW / logoImg.width;
    const logoH = logoImg.height * scale;
    page.drawImage(logoImg, {
      x: PAGE_W - 60 - logoW,
      y: PAGE_H - 60 - logoH,
      width: logoW,
      height: logoH,
    });
  }

  function drawRule(page, y, shade = 0.82) {
    page.drawLine({
      start: { x: 60, y },
      end: { x: PAGE_W - 60, y },
      thickness: 1,
      color: rgb(shade, shade, shade),
    });
  }

  // Deckblatt
  {
    const page = akte.addPage([PAGE_W, PAGE_H]);
    page.drawText("KRISTA BAUSTELLENAKTE", { x: 60, y: PAGE_H - 90, size: 34, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
    drawRule(page, PAGE_H - 112, 0.72);

    page.drawText(title, { x: 60, y: PAGE_H - 175, size: 36, font: fontBold, maxWidth: PAGE_W - 430 });
    page.drawText(`Baustellennummer: #${jobId}`, { x: 60, y: PAGE_H - 225, size: 18, font });
    page.drawText(`Zeitraum: ${shortDateDE(dayInfos[0].day)} bis ${shortDateDE(dayInfos[dayInfos.length - 1].day)}`, { x: 60, y: PAGE_H - 255, size: 18, font });
    page.drawText(`Erstellt: ${generatedAt}`, { x: 60, y: PAGE_H - 285, size: 14, font, color: rgb(0.25, 0.25, 0.25) });

    const boxY = PAGE_H - 390;
    const colW = 245;
    const boxH = 86;
    const cards = [
      ["Bautage", String(dayInfos.length)],
      ["Fotos", String(totalStats.images)],
      ["Dokumente", String(totalStats.pdfs)],
      ["Audio", String(totalStats.audio)],
    ];
    for (let i = 0; i < cards.length; i++) {
      const x = 60 + i * (colW + 20);
      page.drawRectangle({ x, y: boxY, width: colW, height: boxH, borderWidth: 1, borderColor: rgb(0.85,0.85,0.85) });
      page.drawText(cards[i][1], { x: x + 18, y: boxY + 42, size: 28, font: fontBold });
      page.drawText(cards[i][0], { x: x + 18, y: boxY + 18, size: 12, font, color: rgb(0.35,0.35,0.35) });
    }

    page.drawText("Diese Akte fasst alle Tagesprotokolle dieser Baustelle chronologisch zusammen.", {
      x: 60, y: 105, size: 13, font, color: rgb(0.28,0.28,0.28), maxWidth: PAGE_W - 120,
    });
    drawLogo(page);
  }

  // Inhaltsverzeichnis mit Seitenzahlen
  for (let p = 0; p < tocPages; p++) {
    const page = akte.addPage([PAGE_W, PAGE_H]);
    page.drawText(p === 0 ? "Inhaltsverzeichnis" : "Inhaltsverzeichnis (Fortsetzung)", {
      x: 60, y: PAGE_H - 80, size: 28, font: fontBold,
    });
    drawRule(page, PAGE_H - 98, 0.82);

    let y = PAGE_H - 135;
    const start = p * tocRowsPerPage;
    const end = Math.min(dayInfos.length, start + tocRowsPerPage);
    for (let i = start; i < end; i++) {
      const info = dayInfos[i];
      const rowNo = i + 1;
      const label = `${String(rowNo).padStart(2, "0")}.  ${shortDateDE(info.day)}  ·  ${info.stats.images} Fotos  ·  ${info.stats.pdfs} PDF  ·  ${info.stats.audio} Audio`;
      page.drawText(label, { x: 80, y, size: 13, font, maxWidth: PAGE_W - 230 });
      page.drawText(`Seite ${info.startPage}`, { x: PAGE_W - 175, y, size: 13, font });
      page.drawLine({ start: { x: 80, y: y - 7 }, end: { x: PAGE_W - 80, y: y - 7 }, thickness: 0.5, color: rgb(0.92,0.92,0.92) });
      y -= 24;
    }
  }

  // Tagesabschnitte
  for (let idx = 0; idx < dayInfos.length; idx++) {
    const info = dayInfos[idx];

    // Trennseite je Bautag
    {
      const page = akte.addPage([PAGE_W, PAGE_H]);
      const center = PAGE_H / 2;
      drawRule(page, center + 105, 0.72);
      page.drawText(`Bautag ${idx + 1} von ${dayInfos.length}`, { x: 60, y: center + 55, size: 18, font, color: rgb(0.3,0.3,0.3) });
      page.drawText(formatDateLongDE(info.day), { x: 60, y: center, size: 42, font: fontBold, maxWidth: PAGE_W - 120 });
      page.drawText(title, { x: 60, y: center - 45, size: 18, font, maxWidth: PAGE_W - 120 });
      drawRule(page, center - 75, 0.72);
      page.drawText(`${info.stats.images} Fotos  ·  ${info.stats.pdfs} PDF  ·  ${info.stats.audio} Audio  ·  ${info.stats.items} Einträge`, {
        x: 60, y: center - 118, size: 14, font, color: rgb(0.25,0.25,0.25),
      });
    }

    try {
      const srcBytes = await fsp.readFile(info.dayPdfPath);
      const srcPdf = await PDFDocument.load(srcBytes);
      const copied = await akte.copyPages(srcPdf, srcPdf.getPageIndices());
      copied.forEach((p) => akte.addPage(p));
    } catch (e) {
      const page = akte.addPage([PAGE_W, PAGE_H]);
      page.drawText(`Fehler beim Einfügen des Tagesprotokolls ${info.day}`, { x: 60, y: PAGE_H - 90, size: 18, font: fontBold });
      page.drawText(String(e?.message || e), { x: 60, y: PAGE_H - 130, size: 12, font, maxWidth: PAGE_W - 120 });
    }
  }

  // Abschlussseite / Gesamtübersicht
  {
    const page = akte.addPage([PAGE_W, PAGE_H]);
    page.drawText("Gesamtübersicht", { x: 60, y: PAGE_H - 90, size: 32, font: fontBold });
    drawRule(page, PAGE_H - 110, 0.82);
    page.drawText(title, { x: 60, y: PAGE_H - 150, size: 20, font: fontBold, maxWidth: PAGE_W - 120 });

    const rows = [
      ["Bautage", String(dayInfos.length)],
      ["Einträge", String(totalStats.items)],
      ["Fotos", String(totalStats.images)],
      ["Dokumente/PDF", String(totalStats.pdfs)],
      ["Audio/Transkripte", String(totalStats.audio)],
      ["Erste Dokumentation", shortDateDE(dayInfos[0].day)],
      ["Letzte Dokumentation", shortDateDE(dayInfos[dayInfos.length - 1].day)],
    ];

    let y = PAGE_H - 210;
    for (const [k, v] of rows) {
      page.drawText(k, { x: 80, y, size: 15, font, color: rgb(0.25,0.25,0.25) });
      page.drawText(v, { x: 330, y, size: 15, font: fontBold });
      y -= 30;
    }

    page.drawText("Ende der Baustellenakte", { x: 60, y: 90, size: 14, font, color: rgb(0.35,0.35,0.35) });
    drawLogo(page);
  }

  // Kopf-/Fußzeilen und Seitenzahlen
  const pages = akte.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const p = pages[i];
    p.drawText(`Krista Baustellenakte  |  #${jobId}  |  ${meta.name || "ohne Name"}`, {
      x: 60,
      y: PAGE_H - 35,
      size: 9,
      font,
      color: rgb(0.25, 0.25, 0.25),
      maxWidth: PAGE_W - 245,
    });
    p.drawLine({ start: { x: 60, y: PAGE_H - 43 }, end: { x: PAGE_W - 60, y: PAGE_H - 43 }, thickness: 0.5, color: rgb(0.9,0.9,0.9) });
    p.drawText(`Seite ${i + 1} / ${total}`, {
      x: PAGE_W - 170,
      y: 25,
      size: 9,
      font,
      color: rgb(0.25, 0.25, 0.25),
    });
  }

  const bytes = await akte.save();
  await ensureDir(path.dirname(outPdfPath));
  await fsp.writeFile(outPdfPath, bytes);
  return { pages: total, bytes: bytes.length, days: dayInfos.length, stats: totalStats, summaryStartPage };
}

async function akteDownloadName(jobId) {
  const meta = await readJobMeta(jobId);
  const name = meta.name ? sanitizeFileNamePart(meta.name) : "Baustellenakte";
  return `${jobId} - ${name} - Baustellenakte.pdf`;
}


// ===================== Trigger PDF =====================
async function triggerPdfForJobDay({ jobId, date, to }) {
  const dayDir = resolveExistingDayDir(jobId, date);
  if (!fs.existsSync(dayDir)) throw new Error(`No data dir for #${jobId} at ${date}`);

  const outPdf = path.join(dayDir, `Baustellenprotokoll_${jobId}_${date}.pdf`);
  const built = await buildPdfForJobDay(jobId, date, dayDir, outPdf);

  const meta = await readJobMeta(jobId);
  const title = meta.name ? `#${jobId} – ${meta.name}` : `#${jobId}`;
  const viewUrl = pdfUrlFor(jobId, date);
  const downloadUrl = pdfDownloadUrlFor(jobId, date);
  const subject = `Baustellenprotokoll ${title} – ${date}`;
  const body =
`Baustellenprotokoll ${title} wurde erstellt.

Datum: ${date}
Seiten: ${built.pages}
Größe: ${fileSizeMB(built.bytes)}

PDF öffnen:
${viewUrl}

PDF herunterladen:
${downloadUrl}
`;
  const html = `
    <p>Baustellenprotokoll <b>${title}</b> wurde erstellt.</p>
    <p>Datum: ${date}<br>Seiten: ${built.pages}<br>Größe: ${fileSizeMB(built.bytes)}</p>
    <p><a href="${viewUrl}">PDF öffnen</a></p>
    <p><a href="${downloadUrl}">PDF herunterladen</a></p>
  `;

  const sent = await sendMailWithLink({ to, subject, text: body, html });
  return { outPdf, built, pdfUrl: viewUrl, downloadUrl, mailed: !!sent, messageId: sent?.messageId || null };
}


// ===================== KRISTINE =====================
let kristine = null;  // Wird später nach sendWhatsAppKristineReply initialisiert

// ===================== Base Routes =====================
app.get("/", (req, res) => res.type("html").send(`webhook läuft ✅<br><a href="/admin/ui${ADMIN_TOKEN ? `?token=${encodeURIComponent(ADMIN_TOKEN)}` : ""}">Admin öffnen</a>`));

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    time: new Date().toISOString(),
    openai_key: !!OPENAI_API_KEY,
    transcribe_model: OPENAI_TRANSCRIBE_MODEL,
    text_model: OPENAI_TEXT_MODEL,
    logo_path: LOGO_PATH,
    public_base_url: PUBLIC_BASE_URL,
    version: APP_VERSION,
    build: APP_BUILD,
    status: APP_STATUS,
    build_date: APP_BUILD_DATE,
  })
);

// ===================== WhatsApp Verify =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === VERIFY_TOKEN) return res.status(200).send(String(challenge));
  return res.sendStatus(403);
});


// ===================== WhatsApp → Kristine =====================
function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function whatsappTextFromMessage(msg) {
  if (msg?.type === "text") return String(msg.text?.body || "").trim();
  if (msg?.type === "interactive") {
    return String(
      msg.interactive?.button_reply?.title ||
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.title ||
      msg.interactive?.list_reply?.id ||
      ""
    ).trim();
  }
  return "";
}


async function readKristineJson(filename, fallback) {
  try {
    return JSON.parse(await fsp.readFile(path.join(DATA_DIR, "_kristine", filename), "utf8"));
  } catch {
    return fallback;
  }
}

async function appendKristineReviewEntry(entry) {
  const filePath = path.join(DATA_DIR, "_kristine", "day-review-entries.json");
  const rows = await readKristineJson("day-review-entries.json", []);
  rows.push({
    id: entry.id || `review_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    ...entry,
  });
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(rows.slice(-20000), null, 2), "utf8");
}

async function activeEmployeeJobAt(employeeId, date, at) {
  const rows = await readKristineJson("time-events.json", []);
  const wantedMinute = (() => {
    const m = String(at || "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 24 * 60;
  })();
  const events = rows
    .filter((row) => String(row.employeeId) === String(employeeId) && String(row.date) === String(date))
    .map((row, index) => {
      const m = String(row.at || "").match(/^(\d{1,2}):(\d{2})$/);
      return { ...row, _index: index, _minute: m ? Number(m[1]) * 60 + Number(m[2]) : null };
    })
    .filter((row) => row._minute !== null && row._minute <= wantedMinute)
    .sort((a, b) => a._minute - b._minute || a._index - b._index);
  const latestWork = [...events].reverse().find((row) => ["start", "weiter"].includes(row.type) && row.jobId);
  return latestWork ? { jobId: latestWork.jobId, jobName: latestWork.jobName || latestWork.jobId, bookingSegmentId: latestWork.segmentId || null } : { jobId: null, jobName: "", bookingSegmentId: null };
}

async function saveEmployeeReviewMedia({ msg, employee, date, sender }) {
  const media = msg.image || msg.video;
  if (!media?.id) return null;
  const kind = msg.type === "video" ? "video" : "photo";
  const { buf, mime } = await downloadWhatsAppMedia(media.id);
  const ext = kind === "video"
    ? (String(mime).includes("quicktime") ? ".mov" : ".mp4")
    : ".jpg";
  const relativeDir = path.join("_kristine", "media", date, String(employee.id));
  const absoluteDir = path.join(DATA_DIR, relativeDir);
  await ensureDir(absoluteDir);
  const filename = `${String(msg.timestamp || Math.floor(Date.now() / 1000))}_${media.id}${ext}`;
  const absoluteFile = path.join(absoluteDir, filename);
  await fsp.writeFile(absoluteFile, buf);
  const time = new Date(Number(msg.timestamp || 0) * 1000 || Date.now()).toLocaleTimeString("de-AT", {
    timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const job = await activeEmployeeJobAt(employee.id, date, time);
  const relativeFile = path.relative(DATA_DIR, absoluteFile).split(path.sep).join("/");
  await appendKristineReviewEntry({
    employeeId: employee.id,
    employeeName: employee.name,
    date,
    category: kind,
    source: kind,
    file: relativeFile,
    mime,
    at: time,
    capturedAt: time,
    sender,
    jobId: job.jobId,
    jobName: job.jobName,
    bookingSegmentId: job.bookingSegmentId,
    content: media.caption || "",
  });
  return { kind, job };
}

async function employeeFromWhatsAppSender(sender) {
  const wanted = normalizePhone(sender);
  if (!wanted) return null;
  const employees = await readEmployees();
  return employees.find((employee) => {
    const phone = normalizePhone(employee.phone);
    if (!phone) return false;
    // Meta liefert üblicherweise ohne führendes +. Auch lokale 0/0043-Schreibweisen tolerieren.
    return phone === wanted || phone.endsWith(wanted) || wanted.endsWith(phone);
  }) || null;
}

function cleanWhatsAppButtons(buttons) {
  const source = Array.isArray(buttons) ? buttons : [];
  return source.slice(0, 3).map((title, index) => {
    const label = String(title || "").trim().slice(0, 20);
    let id = `kristine_${index}`;
    const lower = label.toLowerCase();
    if (lower === "ja" || lower.includes("weiter zu")) id = "ja";
    else if (lower === "nein") id = "nein";
    else if (lower.includes("feierabend")) id = "feierabend";
    else if (lower === "start") id = "start";
    else if (lower === "pause") id = "pause";
    else if (lower === "mittag") id = "mittag";
    else if (lower === "weiter") id = "weiter";
    else if (lower.includes("fertig")) id = "fertig";
    else if (lower.includes("navigation")) id = "navigation";
    return { id, title: label || `Option ${index + 1}` };
  }).filter((button) => button.title);
}

async function sendWhatsAppKristineReply({ phoneNumberId, to, reply, buttons = [] }) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN missing");
  if (!phoneNumberId) throw new Error("WhatsApp phone_number_id missing in webhook metadata");

  const cleanedButtons = cleanWhatsAppButtons(buttons);
  const payload = cleanedButtons.length
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: String(to),
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: String(reply || "").slice(0, 1024) },
          action: {
            buttons: cleanedButtons.map((button) => ({
              type: "reply",
              reply: { id: button.id, title: button.title },
            })),
          },
        },
      }
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: String(to),
        type: "text",
        text: { preview_url: false, body: String(reply || "").slice(0, 4096) },
      };

  return fetchJson(`https://graph.facebook.com/v22.0/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

// ===== KRISTINE INITIALIZATION (nach sendWhatsAppKristineReply Definition) =====
kristine = registerKristine(app, {
  dataDir: DATA_DIR,
  requireAdmin,
  publicDir: path.join(process.cwd(), "public"),
  sendWhatsApp: sendWhatsAppKristineReply,
  chefPhoneNumber: CHEF_PHONE,
  phoneNumberId: KRISTINE_PHONE_NUMBER_ID
});

// ===================== WhatsApp Incoming =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msgs = value?.messages || [];
    const phoneNumberId = value?.metadata?.phone_number_id || "";
    if (!Array.isArray(msgs) || msgs.length === 0) return;

    for (const msg of msgs) {
      const sender = msg.from || "unknown_sender";
      const tsSec = msg.timestamp || null;
      const date = isoDateFromWhatsAppTs(tsSec);

      const textOrCaption = parseCaptionTextFromMessage(msg);
      let protocolSite = activeProtocol(sender);

      // Chefmodus: "protokoll" oder "proto" startet einen geführten Baustellenprotokoll-Dialog.
      if (!protocolSite && msg.type === "text" && isChefSender(sender) && isProtocolCommand(textOrCaption)) {
        PROTOCOL_START_PENDING[sender] = { startedAt: Date.now() };
        try {
          await sendWhatsAppKristineReply({
            phoneNumberId,
            to: sender,
            reply: "📝 Baustellenprotokoll starten.\nFür welche Baustelle ist das Protokoll?\nBitte Name oder Baustellennummer schreiben. Mit ‚abbrechen‘ beenden."
          });
        } catch {}
        continue;
      }

      if (!protocolSite && msg.type === "text" && isChefSender(sender) && PROTOCOL_START_PENDING[sender]) {
        const pending = PROTOCOL_START_PENDING[sender];
        const answer = String(textOrCaption || "").trim();
        const lowerAnswer = answer.toLowerCase();

        if (["abbruch", "abbrechen", "stopp", "stop"].includes(lowerAnswer)) {
          delete PROTOCOL_START_PENDING[sender];
          try { await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: "✅ Protokollstart abgebrochen. Es wurde nichts gespeichert." }); } catch {}
          continue;
        }

        // "suchen" startet bewusst eine neue Suche. Niemals als Baustellenname interpretieren.
        if (["suchen", "suche"].includes(lowerAnswer)) {
          pending.lastQuery = "";
          try { await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: "🔎 Bitte Baustellenname oder Baustellennummer schreiben. Mit ‚abbruch‘ beenden." }); } catch {}
          continue;
        }

        // "neu" allein verwendet die zuletzt erfolglos gesuchte Bezeichnung.
        // "neu NAME" legt NAME direkt an.
        let createName = "";
        const newMatch = answer.match(/^neu(?:e baustelle)?(?:\s+(.+))?$/i);
        if (newMatch) createName = String(newMatch[1] || pending.lastQuery || "").trim();
        if (newMatch && !createName) {
          try { await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: "➕ Wie soll die neue Baustelle heißen? Bitte Name oder Baustellennummer schreiben. Mit ‚abbruch‘ beenden." }); } catch {}
          pending.createNext = true;
          continue;
        }
        if (pending.createNext && !newMatch) {
          createName = answer;
          pending.createNext = false;
        }
        if (createName) {
          let jobId = jobIdFromName(createName);
          let suffix = 2;
          while (fs.existsSync(path.join(DATA_DIR, jobId))) jobId = `${jobIdFromName(createName)}_${suffix++}`;
          await ensureDir(path.join(DATA_DIR, jobId));
          await writeJobMeta(jobId, { name: createName, status: "Auftrag", createdAt: new Date().toISOString() });
          await startProtocol(sender, jobId);
          delete PROTOCOL_START_PENDING[sender];
          protocolSite = jobId;
          try {
            await sendWhatsAppKristineReply({
              phoneNumberId, to: sender,
              reply: `✅ Neue Baustelle „${createName}“ angelegt.\n📍 Baustellenprotokoll gestartet.\nDu kannst jetzt Texte, Fotos, Audios und PDFs senden. Mit ‚pdf‘ abschließen oder mit ‚abbruch‘ ohne PDF beenden.`
            });
          } catch {}
          continue;
        }

        const matches = await findProtocolJobs(answer);
        const exact = matches.filter(x => x.score === 3);
        if (exact.length === 1) {
          const selected = exact[0];
          await startProtocol(sender, selected.jobId);
          delete PROTOCOL_START_PENDING[sender];
          protocolSite = selected.jobId;
          try {
            await sendWhatsAppKristineReply({
              phoneNumberId, to: sender,
              reply: `✅ Baustelle „${selected.name}“ gefunden.\n📍 Baustellenprotokoll gestartet.\nDu kannst jetzt Texte, Fotos, Audios und PDFs senden. Mit ‚pdf‘ abschließen oder mit ‚abbruch‘ ohne PDF beenden.`
            });
          } catch {}
          continue;
        }

        pending.lastQuery = answer;
        if (matches.length) {
          const choices = matches.slice(0, 6).map((x,i) => `${i+1}. ${x.name} (#${x.jobId})`).join("\n");
          try {
            await sendWhatsAppKristineReply({
              phoneNumberId, to: sender,
              reply: `⚠️ Keine eindeutige Baustelle für „${answer}“.\nMögliche Treffer:\n${choices}\n\nBitte den exakten Namen/die Nummer schreiben, „suchen“ für eine neue Suche, „neu“ zum Anlegen von „${answer}“ oder „abbruch“.`
            });
          } catch {}
          continue;
        }
        try {
          await sendWhatsAppKristineReply({
            phoneNumberId, to: sender,
            reply: `⚠️ Baustelle „${answer}“ wurde nicht gefunden.\nAntworte mit:\n• „neu“ – „${answer}“ neu anlegen\n• „suchen“ – anders suchen\n• „abbruch“ – beenden`
          });
        } catch {}
        continue;
      }

      const protocolStart = parseProtocolStart(textOrCaption);

      // 1) @baustelle hat IMMER Vorrang vor dem normalen Mitarbeitermodus.
      if (protocolStart) {
        protocolSite = protocolStart;
        await startProtocol(sender, protocolSite);
        const jobRoot = path.join(DATA_DIR, protocolSite);
        await ensureDir(jobRoot);
        if (!fs.existsSync(metaPathForJob(protocolSite))) {
          await writeJobMeta(protocolSite, { name: protocolSite.replace(/_/g, " "), status: "Laufend" });
        }
        try {
          await sendWhatsAppKristineReply({
            phoneNumberId,
            to: sender,
            reply: `📍 Baustellenprotokoll ${protocolSite} gestartet.\nAlle folgenden Texte, Fotos, Audios und Dokumente werden zugeordnet.\nMit pdf abschließen.`
          });
        } catch {}
        // Eine reine Startzeile wird nicht als Protokolltext gespeichert.
        if (msg.type === "text" && String(textOrCaption).trim() === `@${protocolStart}`) continue;
      }

      // 2) Ein aktives Protokoll kann jederzeit ohne PDF abgebrochen werden.
      if (protocolSite && msg.type === "text" && ["abbruch", "abbrechen", "stopp", "stop"].includes(String(textOrCaption).trim().toLowerCase())) {
        await stopProtocol(sender);
        try {
          await sendWhatsAppKristineReply({
            phoneNumberId,
            to: sender,
            reply: "✅ Baustellenprotokoll abgebrochen. Es wurde kein PDF erstellt. Kristine ist wieder im Mitarbeitermodus."
          });
        } catch {}
        continue;
      }

      // 3) Im aktiven Protokollmodus wird "pdf" erzeugt und danach zurückgeschaltet.
      if (protocolSite && msg.type === "text" && String(textOrCaption).trim().toLowerCase() === "pdf") {
        if (!isAllowedPdfSender(sender)) continue;
        try {
          const result = await triggerPdfForJobDay({ jobId: protocolSite, date, to: MAIL_TO_DEFAULT });
          await stopProtocol(sender);
          await sendWhatsAppKristineReply({
            phoneNumberId,
            to: sender,
            reply: `✅ PDF für ${protocolSite} erstellt.\nDer Protokollmodus ist beendet. Kristine ist wieder im Mitarbeitermodus.\n${result.downloadUrl || ""}`.trim()
          });
        } catch (e) {
          console.error("❌ pdf command failed:", e?.message || e);
          try { await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: `PDF konnte nicht erstellt werden: ${String(e?.message || e)}` }); } catch {}
        }
        continue;
      }

      // 3) Medien eines bekannten Mitarbeiters werden direkt dem aktuellen Zeitblock zugeordnet.
      if (!protocolSite && ["image", "video"].includes(msg.type)) {
        const employee = await employeeFromWhatsAppSender(sender);
        if (employee) {
          try {
            const saved = await saveEmployeeReviewMedia({ msg, employee, date, sender });
            const label = saved?.kind === "video" ? "Video" : "Foto";
            const site = saved?.job?.jobId ? `#${saved.job.jobId}${saved.job.jobName ? " · " + saved.job.jobName : ""}` : "dem heutigen Tagesrapport";
            await sendWhatsAppKristineReply({
              phoneNumberId,
              to: sender,
              reply: `✅ ${label} erhalten und ${site} zugeordnet.`
            });
          } catch (error) {
            console.error("❌ Mitarbeiter-Medium konnte nicht gespeichert werden:", error?.message || error);
            try { await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: "Das Medium ist angekommen, konnte aber noch nicht eindeutig zugeordnet werden. Das Büro erhält einen Prüfhinweis." }); } catch {}
          }
          continue;
        }
      }

      // 4) Nur außerhalb des Protokollmodus arbeitet ein bekannter Mitarbeiter mit Kristine.
      const kristineText = whatsappTextFromMessage(msg);
      if (!protocolSite && kristineText) {
        const employee = await employeeFromWhatsAppSender(sender);
        if (employee) {
          try {
            let normalizedInput = kristineText;
            const lower = normalizedInput.toLowerCase();

            // Dialog der 07:00-Erinnerung
            if (lower === "komme später" || lower === "komme spaeter") {
              LATE_TIME_PENDING[String(employee.id)] = date;
              await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: "Alles klar. Ab wann ungefähr? Bitte z. B. 07:30 oder 08:00 schreiben." });
              continue;
            }
            if (LATE_TIME_PENDING[String(employee.id)] === date && /^([01]?\d|2[0-3]):[0-5]\d$/.test(normalizedInput)) {
              const p = path.join(DATA_DIR, "_kristine", "late-notices.json");
              const rows = await fsp.readFile(p, "utf8").then(JSON.parse).catch(() => []);
              rows.push({ employeeId: employee.id, date, expectedTime: normalizedInput, updatedAt: new Date().toISOString() });
              await ensureDir(path.dirname(p));
              await fsp.writeFile(p, JSON.stringify(rows, null, 2), "utf8");
              delete LATE_TIME_PENDING[String(employee.id)];
              await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: `Danke. Späterer Arbeitsbeginn ca. ${normalizedInput} ist eingetragen.` });
              continue;
            }
            if (lower === "heute nicht") {
              await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: "Was ist der Grund?", buttons: ["Krank", "Urlaub", "Zeitausgleich"] });
              continue;
            }
            if (["krank", "urlaub", "zeitausgleich"].includes(lower)) {
              const p = path.join(DATA_DIR, "_kristine", "absences.json");
              const rows = await fsp.readFile(p, "utf8").then(JSON.parse).catch(() => []);
              rows.push({ employeeId: employee.id, date, type: lower, hours: 7.8, updatedAt: new Date().toISOString() });
              await ensureDir(path.dirname(p));
              await fsp.writeFile(p, JSON.stringify(rows, null, 2), "utf8");
              await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: `${normalizedInput} ist für heute mit 7,8 Sollstunden vorgemerkt. Das Büro kann den Eintrag kontrollieren.` });
              continue;
            }

            if (lower.startsWith("weiter zu ")) normalizedInput = "ja";
            if (lower === "navigation") {
              const assignments = await fsp.readFile(path.join(DATA_DIR, "_kristine", "assignments.json"), "utf8").then(JSON.parse).catch(() => []);
              const todayRows = assignments.filter((a) => String(a.employeeId) === String(employee.id) && String(a.date) === String(date));
              const active = todayRows.sort((a,b) => String(a.from||"").localeCompare(String(b.from||"")))[0];
              const address = String(active?.address || "").trim();
              const navigationReply = address
                ? `Navigation zu ${active.jobName || "deiner Baustelle"}:\nhttps://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
                : "Bei deiner aktuellen Baustelle ist noch keine Adresse hinterlegt.";
              await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: navigationReply });
              continue;
            }

            const result = await kristine.handleMessage({ employeeId: employee.id, employeeName: employee.name, text: normalizedInput, date });
            await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: result.reply, buttons: result.buttons });
          } catch (e) {
            console.error("❌ Kristine WhatsApp failed:", e?.message || e);
            try { await sendWhatsAppKristineReply({ phoneNumberId, to: sender, reply: "Entschuldige, da hat bei mir gerade etwas nicht geklappt. Bitte versuche es gleich noch einmal." }); } catch {}
          }
          continue;
        }
      }

      // Im Protokollmodus gilt ausschließlich die aktive @Baustelle.
      // Außerhalb bleibt die alte #/@-Kompatibilität für unbekannte Absender erhalten.
      let siteCode = protocolSite || parseSiteCodeFromText(textOrCaption) || "unknown";

      const dayDir = resolveDayDirForWrite(siteCode, date);
      ensureDirSync(dayDir);

      const logPath = path.join(dayDir, "log.jsonl");

      // Base log (always)
      await appendJsonl(logPath, {
        at: new Date(Number(tsSec || 0) * 1000 || Date.now()).toISOString(),
        from: sender,
        type: msg.type,
        text: textOrCaption || "",
        raw: msg,
      });

      // IMAGE
      if (msg.type === "image" && msg.image?.id) {
        const mediaId = msg.image.id;
        const { buf } = await downloadWhatsAppMedia(mediaId);
        const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}.jpg`;
        await fsp.writeFile(path.join(dayDir, filename), buf);
      }

      // DOCUMENT (PDF)
      if (msg.type === "document" && msg.document?.id) {
        const mediaId = msg.document.id;
        const { buf, mime } = await downloadWhatsAppMedia(mediaId);
        const isPdf = String(mime).toLowerCase().includes("pdf");
        const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}${isPdf ? ".pdf" : ".bin"}`;
        await fsp.writeFile(path.join(dayDir, filename), buf);

        if (isPdf) {
          await appendJsonl(logPath, {
            at: new Date(Number(tsSec || 0) * 1000 || Date.now()).toISOString(),
            from: sender,
            type: "pdf",
            file: filename,
            raw: msg,
          });
        }
      }

      // AUDIO robust (audio / voice / document-audio)
      const audioId =
        (msg.audio && msg.audio.id) ||
        (msg.voice && msg.voice.id) ||
        null;

      const docId = (msg.document && msg.document.id) ? msg.document.id : null;

      if (audioId || docId) {
        const mediaId = audioId || docId;
        const { buf, mime } = await downloadWhatsAppMedia(mediaId);
        const mimeLower = String(mime || "").toLowerCase();

        const looksAudio =
          audioId !== null ||
          mimeLower.startsWith("audio/") ||
          mimeLower.includes("ogg") ||
          mimeLower.includes("opus");

        if (looksAudio) {
          const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}.ogg`;
          await fsp.writeFile(path.join(dayDir, filename), buf);

          await appendJsonl(logPath, {
            at: new Date(Number(tsSec || 0) * 1000 || Date.now()).toISOString(),
            from: sender,
            type: "audio_saved",
            file: filename,
            mime,
            raw: msg,
          });

          if (OPENAI_API_KEY) {
            try {
              const transcriptRaw = await transcribeAudio({
                audioBuffer: buf,
                filename,
                mimeType: mime || "audio/ogg",
              });

              let transcriptClean = transcriptRaw;
              try {
                transcriptClean = await polishGermanTranscript(transcriptRaw);
              } catch {
                transcriptClean = transcriptRaw;
              }

              await appendJsonl(logPath, {
                at: new Date(Number(tsSec || 0) * 1000 || Date.now()).toISOString(),
                from: sender,
                type: "audio_transcript",
                transcript_raw: transcriptRaw,
                transcript: transcriptClean,
                file: filename,
                raw: msg,
              });
            } catch (e) {
              await appendJsonl(logPath, {
                at: new Date().toISOString(),
                from: sender,
                type: "transcription_failed",
                error: String(e?.message || e),
                file: filename,
                raw: msg,
              });
            }
          } else {
            await appendJsonl(logPath, {
              at: new Date().toISOString(),
              from: sender,
              type: "transcription_failed",
              error: "OPENAI_API_KEY missing",
              file: filename,
              raw: msg,
            });
          }
        }
      }

      // Legacy-PDF-Trigger nur außerhalb einer aktiven Protokollsitzung.
      if (!protocolSite && msg.type === "text" && isPdfCommand(textOrCaption)) {
        if (!isAllowedPdfSender(sender)) continue;

        let jobId = parseSiteCodeFromText(textOrCaption) || siteCode;
        if (!jobId || jobId === "unknown") continue;
        if (PDF_IGNORE_UNKNOWN && (jobId === "unknown" || jobId === "_unassigned")) continue;

        const to = MAIL_TO_DEFAULT;
        if (!to) continue;

        try {
          await triggerPdfForJobDay({ jobId, date, to });
        } catch (e) {
          console.error("❌ pdf command failed:", e?.message || e);
        }
      }
    }
  } catch (e) {
    console.error("❌ webhook error:", e?.message || e);
  }
});

// ===================== Admin: test mail =====================
app.get("/admin/test-mail", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const to = req.query.to || MAIL_TO_DEFAULT;
  if (!to) return res.status(400).send("MAIL_TO_DEFAULT missing (or pass ?to=...)");
  try {
    const mailer = makeMailer();
    const info = await mailer.sendMail({
      from: MAIL_FROM,
      to,
      subject: "Testmail (SMTP)",
      text: "Wenn du das liest, passt SMTP ✅",
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== Admin: check logo =====================
app.get("/admin/check-logo", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const logoPath = process.env.LOGO_PATH || "assets/krista-logo.png";
    const abs = path.isAbsolute(logoPath) ? logoPath : path.join(process.cwd(), logoPath);

    const st = await fsp.stat(abs);
    const ext = path.extname(abs).toLowerCase();

    const head = await fsp.readFile(abs);
    const isPng =
      head.length >= 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;

    res.json({
      ok: true,
      logoPath,
      resolvedPath: abs,
      sizeBytes: st.size,
      extension: ext,
      isPngSignature: isPng,
      note: isPng ? "PNG erkannt ✅" : "Nicht-PNG oder PNG-Signatur fehlt (empfohlen: PNG)",
    });
  } catch (e) {
    res.status(404).json({
      ok: false,
      error: String(e?.message || e),
      hint: "Lege die Datei ins Repo z.B. krista-logo.png oder assets/krista-logo.png und setze LOGO_PATH passend",
    });
  }
});

// ===================== Admin: daily run (Cron) =====================
app.get("/admin/run-daily", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const date = req.query.date || todayISO();
    const to = req.query.to || MAIL_TO_DEFAULT;
    if (!to) return res.status(400).send("MAIL_TO_DEFAULT missing (or pass ?to=...)");

    const onlyJob = req.query.jobId ? String(req.query.jobId) : null;

    const jobIds = await fsp.readdir(DATA_DIR).catch(() => []);
    const results = [];

    for (const jobId of jobIds) {
      if (onlyJob && jobId !== onlyJob) continue;
      if (PDF_IGNORE_UNKNOWN && (jobId === "unknown" || jobId === "_unassigned")) continue;

      const dayDir = resolveExistingDayDir(jobId, date);
      if (!fs.existsSync(dayDir)) continue;

      const outPdf = path.join(dayDir, `Baustellenprotokoll_${jobId}_${date}.pdf`);
      const built = await buildPdfForJobDay(jobId, date, dayDir, outPdf);

      const meta = await readJobMeta(jobId);
      const title = meta.name ? `#${jobId} – ${meta.name}` : `#${jobId}`;
      const subject = `Baustellenprotokoll ${title} – ${date}`;
      const viewUrl = pdfUrlFor(jobId, date);
      const downloadUrl = pdfDownloadUrlFor(jobId, date);
      const text =
`Baustellenprotokoll ${title} wurde erstellt.

Datum: ${date}
Seiten: ${built.pages}
Größe: ${fileSizeMB(built.bytes)}

PDF öffnen:
${viewUrl}

PDF herunterladen:
${downloadUrl}
`;
      const html = `
        <p>Baustellenprotokoll <b>${title}</b> wurde erstellt.</p>
        <p>Datum: ${date}<br>Seiten: ${built.pages}<br>Größe: ${fileSizeMB(built.bytes)}</p>
        <p><a href="${viewUrl}">PDF öffnen</a></p>
        <p><a href="${downloadUrl}">PDF herunterladen</a></p>
      `;

      const sent = await sendMailWithLink({ to, subject, text, html });
      results.push({ jobId, date, pages: built.pages, sizeBytes: built.bytes, pdfUrl: viewUrl, mailed: !!sent });
    }

    res.json({ ok: true, date, to, count: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== Admin UI + API + PDF =====================

// Admin UI
app.get("/admin", (req, res) => {
  const token = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : "";
  res.redirect(`/admin/ui${token}`);
});

// Admin UI (serves /public/admin.html)
app.get("/admin/ui", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.sendFile(path.join(process.cwd(), "public", "admin.html"));
});


function isSafeJobId(jobId) {
  return /^[A-Za-z0-9_-]+$/.test(String(jobId || ""));
}
function isSafeDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day || ""));
}
function metaPathForJob(jobId) {
  return path.join(DATA_DIR, String(jobId), ".meta.json");
}
async function readJobMeta(jobId) {
  try {
    const p = metaPathForJob(jobId);
    if (!fs.existsSync(p)) return { name: "", favorite: false, notes: "", status: "Angebot", street: "", houseNumber: "", postalCode: "", city: "", addressExtra: "", contactName: "", contactPhone: "", billingRate: 0, contractAmount: 0, externalServices: 0, materialPercent: 0, plannedRegieHours: 0 };
    const meta = JSON.parse(await fsp.readFile(p, "utf8"));
    return {
      name: String(meta.name || "").trim(),
      favorite: !!meta.favorite,
      notes: String(meta.notes || "").trim(),
      status: ["Angebot", "Auftrag", "Laufend", "Fertig – nicht abgerechnet", "Geschlossen"].includes(meta.status) ? meta.status : "Angebot",
      street: String(meta.street || "").trim(),
      houseNumber: String(meta.houseNumber || "").trim(),
      postalCode: String(meta.postalCode || "").trim(),
      city: String(meta.city || "").trim(),
      addressExtra: String(meta.addressExtra || "").trim(),
      contactName: String(meta.contactName || "").trim(),
      contactPhone: String(meta.contactPhone || "").trim(),
      billingRate: Math.max(0, Number(meta.billingRate || 0)),
      contractAmount: Math.max(0, Number(meta.contractAmount || 0)),
      externalServices: Math.max(0, Number(meta.externalServices || 0)),
      materialPercent: Math.min(100, Math.max(0, Number(meta.materialPercent || 0))),
      plannedRegieHours: Math.max(0, Number(meta.plannedRegieHours || 0)),
      updatedAt: meta.updatedAt || null,
    };
  } catch {
    return { name: "", favorite: false, notes: "", status: "Angebot", street: "", houseNumber: "", postalCode: "", city: "", addressExtra: "", contactName: "", contactPhone: "", billingRate: 0, contractAmount: 0, externalServices: 0, materialPercent: 0, plannedRegieHours: 0 };
  }
}
function historyPathForJob(jobId) {
  return path.join(DATA_DIR, String(jobId), ".history.jsonl");
}
async function appendJobHistory(jobId, event) {
  if (!isSafeJobId(jobId)) return;
  await ensureDir(path.join(DATA_DIR, String(jobId)));
  await appendJsonl(historyPathForJob(jobId), {
    at: new Date().toISOString(),
    type: String(event?.type || "event"),
    title: String(event?.title || "").slice(0, 180),
    detail: String(event?.detail || "").slice(0, 2000),
    source: String(event?.source || "system").slice(0, 80),
    data: event?.data && typeof event.data === "object" ? event.data : undefined
  });
}
async function readJobHistory(jobId, limit = 250) {
  const p = historyPathForJob(jobId);
  if (!fs.existsSync(p)) return [];
  const lines = (await fsp.readFile(p, "utf8")).split("\n").filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(1000, Number(limit || 250)))).reverse().map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

async function writeJobMeta(jobId, patch) {
  if (!isSafeJobId(jobId)) throw new Error("Invalid jobId");
  const existing = await readJobMeta(jobId);
  const next = {
    ...existing,
    ...patch,
    name: String(patch.name ?? existing.name ?? "").trim().slice(0, 120),
    notes: String(patch.notes ?? existing.notes ?? "").trim().slice(0, 1000),
    favorite: !!(patch.favorite ?? existing.favorite),
    status: ["Angebot", "Auftrag", "Laufend", "Fertig – nicht abgerechnet", "Geschlossen"].includes(patch.status ?? existing.status) ? (patch.status ?? existing.status) : "Angebot",
    street: String(patch.street ?? existing.street ?? "").trim().slice(0, 140),
    houseNumber: String(patch.houseNumber ?? existing.houseNumber ?? "").trim().slice(0, 40),
    postalCode: String(patch.postalCode ?? existing.postalCode ?? "").trim().slice(0, 20),
    city: String(patch.city ?? existing.city ?? "").trim().slice(0, 100),
    addressExtra: String(patch.addressExtra ?? existing.addressExtra ?? "").trim().slice(0, 300),
    contactName: String(patch.contactName ?? existing.contactName ?? "").trim().slice(0, 120),
    contactPhone: String(patch.contactPhone ?? existing.contactPhone ?? "").trim().slice(0, 60),
    billingRate: Math.max(0, Number(patch.billingRate ?? existing.billingRate ?? 0)),
    contractAmount: Math.max(0, Number(patch.contractAmount ?? existing.contractAmount ?? 0)),
    externalServices: Math.max(0, Number(patch.externalServices ?? existing.externalServices ?? 0)),
    materialPercent: Math.min(100, Math.max(0, Number(patch.materialPercent ?? existing.materialPercent ?? 0))),
    plannedRegieHours: Math.max(0, Number(patch.plannedRegieHours ?? existing.plannedRegieHours ?? 0)),
    updatedAt: new Date().toISOString(),
  };
  await ensureDir(path.join(DATA_DIR, String(jobId)));
  await fsp.writeFile(metaPathForJob(jobId), JSON.stringify(next, null, 2), "utf8");
  return next;
}
function sanitizeFileNamePart(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 _.-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Baustellenprotokoll";
}
async function dirSizeBytes(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += await dirSizeBytes(full);
      else if (ent.isFile()) total += (await fsp.stat(full)).size;
    } catch {}
  }
  return total;
}
async function removeEmptyParentsAfterDay(jobId, day) {
  const [Y, M] = String(day).split("-");
  const monthDir = path.join(DATA_DIR, String(jobId), Y, M);
  const yearDir = path.join(DATA_DIR, String(jobId), Y);
  for (const dir of [monthDir, yearDir]) {
    try {
      const entries = await fsp.readdir(dir);
      if (entries.length === 0) await fsp.rmdir(dir);
    } catch {}
  }
}

async function deleteGeneratedPdfsForJob(jobId) {
  // Wenn der Baustellenname geändert wird, löschen wir nur die automatisch erzeugten
  // Protokoll-PDFs. Originale WhatsApp-PDFs bleiben erhalten. Beim nächsten Öffnen
  // wird das Protokoll mit dem aktuellen Namen neu erzeugt.
  const base = path.join(DATA_DIR, String(jobId));
  if (!fs.existsSync(base)) return 0;
  let deleted = 0;
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && /^Baustellenprotokoll_.*\.pdf$/i.test(ent.name)) {
        try { await fsp.unlink(full); deleted++; } catch {}
      }
    }
  }
  await walk(base);
  return deleted;
}


async function mergeDirectoryContents(srcDir, destDir) {
  await ensureDir(destDir);
  const entries = await fsp.readdir(srcDir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);

    if (ent.isDirectory()) {
      await mergeDirectoryContents(src, dest);
      await fsp.rm(src, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    if (!ent.isFile()) continue;

    if (!fs.existsSync(dest)) {
      await fsp.rename(src, dest).catch(async () => {
        await fsp.copyFile(src, dest);
        await fsp.unlink(src).catch(() => {});
      });
      continue;
    }

    // log.jsonl wird zusammengeführt; dadurch bleiben alle Einträge chronologisch auswertbar.
    if (ent.name === "log.jsonl") {
      const add = await fsp.readFile(src, "utf8").catch(() => "");
      if (add) await fsp.appendFile(dest, add.endsWith("\n") ? add : add + "\n", "utf8").catch(() => {});
      await fsp.unlink(src).catch(() => {});
      continue;
    }

    // .meta.json: Ziel-Meta bleibt führend. Falls Ziel keinen Namen hat, übernehmen wir den Quell-Namen.
    if (ent.name === ".meta.json") {
      try {
        const targetMeta = JSON.parse(await fsp.readFile(dest, "utf8"));
        const sourceMeta = JSON.parse(await fsp.readFile(src, "utf8"));
        if (!String(targetMeta.name || "").trim() && String(sourceMeta.name || "").trim()) {
          targetMeta.name = String(sourceMeta.name || "").trim();
          targetMeta.updatedAt = new Date().toISOString();
          await fsp.writeFile(dest, JSON.stringify(targetMeta, null, 2), "utf8");
        }
      } catch {}
      await fsp.unlink(src).catch(() => {});
      continue;
    }

    // Bei Namenskollision Originale nicht überschreiben.
    const ext = path.extname(ent.name);
    const base = path.basename(ent.name, ext);
    let candidate;
    let n = 1;
    do {
      candidate = path.join(destDir, `${base}_merged_${n}${ext}`);
      n++;
    } while (fs.existsSync(candidate));

    await fsp.rename(src, candidate).catch(async () => {
      await fsp.copyFile(src, candidate);
      await fsp.unlink(src).catch(() => {});
    });
  }
}

async function protocolDownloadName(jobId, day) {
  const meta = await readJobMeta(jobId);
  const name = meta.name ? sanitizeFileNamePart(meta.name) : "Baustellenprotokoll";
  return `${jobId} - ${name} - ${day}.pdf`;
}

async function listDaysForJob(jobId) {
  const base = path.join(DATA_DIR, String(jobId));
  if (!fs.existsSync(base)) return [];

  const days = new Set();
  const entries = await fsp.readdir(base).catch(() => []);

  // NEW: YYYY/MM/DD
  for (const y of entries) {
    if (!/^\d{4}$/.test(y)) continue;
    const yPath = path.join(base, y);
    const months = await fsp.readdir(yPath).catch(() => []);
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      const mPath = path.join(yPath, m);
      const ds = await fsp.readdir(mPath).catch(() => []);
      for (const d of ds) {
        if (!/^\d{2}$/.test(d)) continue;
        days.add(`${y}-${m}-${d}`);
      }
    }
  }

  // OLD: YYYY-MM-DD directly under /job
  for (const x of entries) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(x)) days.add(x);
  }

  return Array.from(days).sort().reverse();
}

async function readLogStats(dayDir) {
  const logPath = path.join(dayDir, "log.jsonl");
  let items = 0,
    images = 0,
    audio = 0,
    pdfs = 0;

  if (fs.existsSync(logPath)) {
    const txt = await fsp.readFile(logPath, "utf8").catch(() => "");
    const lines = txt.split("\n").filter(Boolean);
    items = lines.length;

    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.type === "audio_saved" || j.type === "audio_transcript") audio++;
        if (j.type === "pdf") pdfs++;
      } catch {}
    }
  }

  const files = await fsp.readdir(dayDir).catch(() => []);
  images = files.filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).length;

  return { items, images, audio, pdfs };
}

async function summarizeJobHours(jobId) {
  const days = await listDaysForJob(jobId);
  let actualHours = 0;
  let actualRegieHours = 0;
  for (const day of days) {
    const p = regiePathForDay(jobId, day);
    if (!fs.existsSync(p)) continue;
    try {
      const regie = JSON.parse(await fsp.readFile(p, "utf8"));
      for (const employee of Array.isArray(regie.employees) ? regie.employees : []) {
        actualHours += Math.max(0, Number(employee.totalHours || 0));
        actualRegieHours += Math.max(0, Number(employee.regieHours || 0));
      }
    } catch {}
  }
  return { actualHours, actualRegieHours };
}

function calculateJobBudget(meta, defaultBillingRate = 0, hours = {}) {
  const contractAmount = Math.max(0, Number(meta.contractAmount || 0));
  const externalServices = Math.max(0, Number(meta.externalServices || 0));
  const kristaAmount = Math.max(0, contractAmount - externalServices);
  const materialPercent = Math.min(100, Math.max(0, Number(meta.materialPercent || 0)));
  const materialAmount = kristaAmount * materialPercent / 100;
  const laborAmount = Math.max(0, kristaAmount - materialAmount);
  const billingRate = Math.max(0, Number(meta.billingRate || defaultBillingRate || 0));
  const calculatedHours = billingRate > 0 ? laborAmount / billingRate : 0;
  const actualHours = Math.max(0, Number(hours.actualHours || 0));
  const actualRegieHours = Math.max(0, Number(hours.actualRegieHours || 0));
  const orderHours = Math.max(0, actualHours - actualRegieHours);
  return {
    contractAmount, externalServices, kristaAmount, materialPercent, materialAmount,
    laborAmount, billingRate, calculatedHours, actualHours, actualRegieHours, orderHours,
    remainingOrderHours: calculatedHours - orderHours,
    progressPercent: calculatedHours > 0 ? orderHours / calculatedHours * 100 : 0,
    plannedRegieHours: Math.max(0, Number(meta.plannedRegieHours || 0)),
    remainingRegieHours: Math.max(0, Number(meta.plannedRegieHours || 0)) - actualRegieHours
  };
}

// Admin API: neue Baustelle anlegen
app.post("/admin/api/jobs", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Baustellenname fehlt." });

    let jobId = String(body.jobId || "").trim() || jobIdFromName(name);
    if (!isSafeJobId(jobId)) return res.status(400).json({ ok: false, error: "Ungültige Baustellennummer. Erlaubt sind Buchstaben, Zahlen, _ und -." });
    if (fs.existsSync(path.join(DATA_DIR, jobId))) return res.status(409).json({ ok: false, error: `Baustelle #${jobId} existiert bereits.` });

    await ensureDir(path.join(DATA_DIR, jobId));
    await writeJobMeta(jobId, {
      name,
      status: String(body.status || "Angebot"),
      street: String(body.street || ""),
      houseNumber: String(body.houseNumber || ""),
      postalCode: String(body.postalCode || ""),
      city: String(body.city || ""),
      addressExtra: String(body.addressExtra || ""),
      contactName: String(body.contactName || ""),
      contactPhone: String(body.contactPhone || ""),
      notes: String(body.notes || ""),
      startDate: String(body.startDate || ""),
      createdAt: new Date().toISOString()
    });
    res.status(201).json({ ok: true, jobId, name });
  } catch (error) {
    console.error("Create job failed:", error);
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Admin API: list jobs
app.get("/admin/api/jobs", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const companySummary = await calculationSummary();
    const company = companySummary.company;
    const jobIds = await fsp.readdir(DATA_DIR).catch(() => []);
    const filtered = jobIds
      .filter((j) => j && j !== "unknown" && j !== "_unassigned" && isSafeJobId(j))
      .filter((j) => fs.existsSync(path.join(DATA_DIR, j)));

    const jobs = [];
    for (const jobId of filtered) {
      const days = await listDaysForJob(jobId);
      const latestDay = days[0] || null;
      let stats = { items: 0, images: 0, audio: 0, pdfs: 0 };
      let totalStats = { items: 0, images: 0, audio: 0, pdfs: 0 };

      for (const day of days) {
        const dayDir = resolveExistingDayDir(jobId, day);
        if (!fs.existsSync(dayDir)) continue;
        const s = await readLogStats(dayDir);
        totalStats.items += s.items;
        totalStats.images += s.images;
        totalStats.audio += s.audio;
        totalStats.pdfs += s.pdfs;
        if (day === latestDay) stats = s;
      }

      const meta = await readJobMeta(jobId);
      const hours = await summarizeJobHours(jobId);
      const calculation = calculateJobBudget(meta, companySummary.currentBillingRate, hours);
      const sizeBytes = await dirSizeBytes(path.join(DATA_DIR, jobId));

      jobs.push({
        jobId,
        name: meta.name || "",
        notes: meta.notes || "",
        favorite: !!meta.favorite,
        status: meta.status || "Angebot",
        street: meta.street || "",
        houseNumber: meta.houseNumber || "",
        postalCode: meta.postalCode || "",
        city: meta.city || "",
        addressExtra: meta.addressExtra || "",
        contactName: meta.contactName || "",
        contactPhone: meta.contactPhone || "",
        billingRate: Number(meta.billingRate || 0),
        contractAmount: Number(meta.contractAmount || 0),
        externalServices: Number(meta.externalServices || 0),
        materialPercent: Number(meta.materialPercent || 0),
        plannedRegieHours: Number(meta.plannedRegieHours || 0),
        calculation,
        sizeBytes,
        totalStats,
        daysCount: days.length,
        latestDay,
        itemsLastDay: stats.items,
        imagesLastDay: stats.images,
        audioLastDay: stats.audio,
        pdfsLastDay: stats.pdfs,
      });
    }

    jobs.sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return (b.latestDay || "").localeCompare(a.latestDay || "");
    });
    res.json({ ok: true, jobs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin API: read/update metadata
app.get("/admin/api/job/:jobId/meta", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const jobId = String(req.params.jobId);
    if (!isSafeJobId(jobId)) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    res.json({ ok: true, jobId, meta: await readJobMeta(jobId) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/admin/api/job/:jobId/meta", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const jobId = String(req.params.jobId);
    if (!isSafeJobId(jobId)) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    const before = await readJobMeta(jobId);
    const meta = await writeJobMeta(jobId, {
      name: req.body?.name,
      notes: req.body?.notes,
      favorite: req.body?.favorite,
      status: req.body?.status,
      street: req.body?.street,
      houseNumber: req.body?.houseNumber,
      postalCode: req.body?.postalCode,
      city: req.body?.city,
      addressExtra: req.body?.addressExtra,
      contactName: req.body?.contactName,
      contactPhone: req.body?.contactPhone,
      billingRate: req.body?.billingRate,
      contractAmount: req.body?.contractAmount,
      externalServices: req.body?.externalServices,
      materialPercent: req.body?.materialPercent,
      plannedRegieHours: req.body?.plannedRegieHours,
    });
    const deletedGeneratedPdfs = before.name !== meta.name ? await deleteGeneratedPdfsForJob(jobId) : 0;
    const changed = [];
    for (const key of ["name","status","street","houseNumber","postalCode","city","addressExtra","contactName","contactPhone","billingRate","contractAmount","externalServices","materialPercent","plannedRegieHours"]) {
      if (String(before[key] ?? "") !== String(meta[key] ?? "")) changed.push(key);
    }
    if (changed.length) {
      await appendJobHistory(jobId, {
        type: "job_meta_updated",
        title: "Baustellendaten aktualisiert",
        detail: changed.join(", "),
        source: "admin",
        data: { changed }
      });
    }
    res.json({ ok: true, jobId, meta, deletedGeneratedPdfs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


app.get("/admin/api/job/:jobId/history", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const jobId = String(req.params.jobId);
    if (!isSafeJobId(jobId)) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    res.json({ ok: true, jobId, events: await readJobHistory(jobId, req.query.limit || 250) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin API: Baustellennummer ändern (Ordner umbenennen)
app.post("/admin/api/job/:jobId/rename", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const oldJobId = String(req.params.jobId);
    const newJobId = String(req.body?.newJobId || "").trim();
    if (!isSafeJobId(oldJobId) || !isSafeJobId(newJobId)) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    if (oldJobId === newJobId) return res.json({ ok: true, oldJobId, newJobId, unchanged: true });

    const oldDir = path.join(DATA_DIR, oldJobId);
    const newDir = path.join(DATA_DIR, newJobId);
    if (!fs.existsSync(oldDir)) return res.status(404).json({ ok: false, error: "Source job not found" });
    if (fs.existsSync(newDir)) return res.status(409).json({ ok: false, error: "Diese Baustellennummer existiert bereits. Bitte Zusammenführen verwenden." });

    await fsp.rename(oldDir, newDir);
    const deletedGeneratedPdfs = await deleteGeneratedPdfsForJob(newJobId);
    res.json({ ok: true, oldJobId, newJobId, deletedGeneratedPdfs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin API: Baustellen zusammenführen (Quelle in Ziel verschieben)
app.post("/admin/api/job/:jobId/merge", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const sourceJobId = String(req.params.jobId);
    const targetJobId = String(req.body?.targetJobId || "").trim();
    if (!isSafeJobId(sourceJobId) || !isSafeJobId(targetJobId)) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    if (sourceJobId === targetJobId) return res.status(400).json({ ok: false, error: "Quelle und Ziel sind gleich" });

    const sourceDir = path.join(DATA_DIR, sourceJobId);
    const targetDir = path.join(DATA_DIR, targetJobId);
    if (!fs.existsSync(sourceDir)) return res.status(404).json({ ok: false, error: "Source job not found" });
    await ensureDir(targetDir);

    const sourceSizeBytes = await dirSizeBytes(sourceDir);
    await mergeDirectoryContents(sourceDir, targetDir);
    await fsp.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    const deletedGeneratedPdfs = await deleteGeneratedPdfsForJob(targetJobId);

    res.json({ ok: true, sourceJobId, targetJobId, movedBytes: sourceSizeBytes, deletedGeneratedPdfs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin API: delete a single day
app.delete("/admin/api/job/:jobId/day/:day", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const jobId = String(req.params.jobId);
    const day = String(req.params.day);
    if (!isSafeJobId(jobId) || !isSafeDay(day)) return res.status(400).json({ ok: false, error: "Invalid jobId/day" });
    const dayDir = resolveExistingDayDir(jobId, day);
    if (!fs.existsSync(dayDir)) return res.status(404).json({ ok: false, error: "Day not found" });
    const sizeBytes = await dirSizeBytes(dayDir);
    await fsp.rm(dayDir, { recursive: true, force: true });
    await removeEmptyParentsAfterDay(jobId, day);
    res.json({ ok: true, jobId, day, deletedBytes: sizeBytes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin API: delete full job
app.delete("/admin/api/job/:jobId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const jobId = String(req.params.jobId);
    if (!isSafeJobId(jobId)) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    const jobDir = path.join(DATA_DIR, jobId);
    if (!fs.existsSync(jobDir)) return res.status(404).json({ ok: false, error: "Job not found" });
    const sizeBytes = await dirSizeBytes(jobDir);
    await fsp.rm(jobDir, { recursive: true, force: true });
    res.json({ ok: true, jobId, deletedBytes: sizeBytes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin API: days for job
app.get("/admin/api/job/:jobId/days", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobId = String(req.params.jobId);
    const days = await listDaysForJob(jobId);
    const detailed = [];
    for (const day of days) {
      const dayDir = resolveExistingDayDir(jobId, day);
      const stats = fs.existsSync(dayDir) ? await readLogStats(dayDir) : { items: 0, images: 0, audio: 0, pdfs: 0 };
      const pdfPath = path.join(dayDir, `Baustellenprotokoll_${jobId}_${day}.pdf`);
      const pdfExists = fs.existsSync(pdfPath);
      const sizeBytes = pdfExists ? (await fsp.stat(pdfPath).catch(() => ({ size: 0 }))).size : 0;
      detailed.push({ day, stats, pdfExists, sizeBytes, viewUrl: `/admin/pdf/${encodeURIComponent(jobId)}/${encodeURIComponent(day)}`, downloadUrl: `/admin/download/${encodeURIComponent(jobId)}/${encodeURIComponent(day)}` });
    }
    res.json({ ok: true, jobId, days, detailed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin API: stats for a day
app.get("/admin/api/job/:jobId/day/:day", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobId = String(req.params.jobId);
    const day = String(req.params.day);
    const dayDir = resolveExistingDayDir(jobId, day);
    if (!fs.existsSync(dayDir)) return res.status(404).json({ ok: false, error: "Day not found" });

    const stats = await readLogStats(dayDir);
    res.json({ ok: true, jobId, day, dayDir, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin: serve PDF (build if missing)
app.get("/admin/pdf/:jobId/:day", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobId = String(req.params.jobId);
    const day = String(req.params.day);

    const dayDir = resolveExistingDayDir(jobId, day);
    if (!fs.existsSync(dayDir)) return res.status(404).send("Day not found");

    const pdfPath = path.join(dayDir, `Baustellenprotokoll_${jobId}_${day}.pdf`);
    if (!fs.existsSync(pdfPath) || String(req.query.rebuild || "") === "1") {
      await buildPdfForJobDay(jobId, day, dayDir, pdfPath);
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${await protocolDownloadName(jobId, day)}"`);
    return res.sendFile(pdfPath);
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

// Admin: download PDF with filename (build if missing)
app.get("/admin/download/:jobId/:day", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobId = String(req.params.jobId);
    const day = String(req.params.day);
    const dayDir = resolveExistingDayDir(jobId, day);
    if (!fs.existsSync(dayDir)) return res.status(404).send("Day not found");

    const pdfPath = path.join(dayDir, `Baustellenprotokoll_${jobId}_${day}.pdf`);
    if (!fs.existsSync(pdfPath)) await buildPdfForJobDay(jobId, day, dayDir, pdfPath);

    res.download(pdfPath, await protocolDownloadName(jobId, day));
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

// Admin API: generate PDF now
app.post("/admin/api/job/:jobId/day/:day/build", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobId = String(req.params.jobId);
    const day = String(req.params.day);
    const dayDir = resolveExistingDayDir(jobId, day);
    if (!fs.existsSync(dayDir)) return res.status(404).json({ ok: false, error: "Day not found" });

    const pdfPath = path.join(dayDir, `Baustellenprotokoll_${jobId}_${day}.pdf`);
    const built = await buildPdfForJobDay(jobId, day, dayDir, pdfPath);
    res.json({ ok: true, jobId, day, pages: built.pages, sizeBytes: built.bytes, viewUrl: `/admin/pdf/${jobId}/${day}`, downloadUrl: `/admin/download/${jobId}/${day}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


// Admin: serve Baustellenakte (build if missing/rebuild=1)
app.get("/admin/akte/:jobId", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobId = String(req.params.jobId);
    if (!isSafeJobId(jobId)) return res.status(400).send("Invalid jobId");

    const jobDir = path.join(DATA_DIR, jobId);
    if (!fs.existsSync(jobDir)) return res.status(404).send("Job not found");

    const pdfPath = path.join(jobDir, `Baustellenakte_${jobId}.pdf`);
    await buildAkteForJob(jobId, pdfPath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${await akteDownloadName(jobId)}"`);
    return res.sendFile(pdfPath);
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

// Admin: download Baustellenakte
app.get("/admin/download-akte/:jobId", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobId = String(req.params.jobId);
    if (!isSafeJobId(jobId)) return res.status(400).send("Invalid jobId");

    const jobDir = path.join(DATA_DIR, jobId);
    if (!fs.existsSync(jobDir)) return res.status(404).send("Job not found");

    const pdfPath = path.join(jobDir, `Baustellenakte_${jobId}.pdf`);
    await buildAkteForJob(jobId, pdfPath);

    res.download(pdfPath, await akteDownloadName(jobId));
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});


// Legacy compatibility
app.get("/api/admin/list-jobs", (req, res) => res.redirect(307, `/admin/api/jobs${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`));
app.get("/admin/list-jobs", (req, res) => res.redirect(307, `/admin/api/jobs${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`));



// ===================== Version / Betrieb & Kalkulation 3.2.0d =====================
app.get("/admin/api/version", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, version: APP_VERSION, build: APP_BUILD, status: APP_STATUS, date: APP_BUILD_DATE });
});

app.get("/admin/api/company", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json({ ok: true, ...(await calculationSummary(Number(req.query.year || new Date().getFullYear()))) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});
app.put("/admin/api/company", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { await writeCompany(req.body || {}); res.json({ ok: true, ...(await calculationSummary(Number(req.query.year || new Date().getFullYear()))) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});

function systemDataDir() {
  return path.join(DATA_DIR, "_system");
}
function employeesPath() {
  return path.join(systemDataDir(), "employees.json");
}
function worktimeModelsPath() {
  return path.join(systemDataDir(), "worktime-models.json");
}
function companyPath() {
  return path.join(systemDataDir(), "company.json");
}
function vehiclesPath() { return path.join(systemDataDir(), "vehicles.json"); }
function ideasPath() { return path.join(systemDataDir(), "ideas.json"); }
async function readJsonArrayFile(file) { try { const d=JSON.parse(await fsp.readFile(file,"utf8")); return Array.isArray(d)?d:[]; } catch { return []; } }
async function writeJsonArrayFile(file, rows) { await ensureDir(systemDataDir()); await fsp.writeFile(file, JSON.stringify(rows,null,2), "utf8"); }
function uid(prefix="id") { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`; }
function cleanVehicle(v={}, id="") { return {
  id: String(id || v.id || uid("vehicle")).slice(0,80),
  label: String(v.label||"").trim().slice(0,100), plate: String(v.plate||"").trim().slice(0,30),
  make: String(v.make||"").trim().slice(0,60), model: String(v.model||"").trim().slice(0,60), year: Math.max(0,Number(v.year||0)),
  inspectionUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(v.inspectionUntil||""))?String(v.inspectionUntil):"",
  insuranceType: ["Haftpflicht","Vollkasko"].includes(String(v.insuranceType||"")) ? String(v.insuranceType) : "", insuranceUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(v.insuranceUntil||""))?String(v.insuranceUntil):"",
  leasingRate: Math.max(0,Number(v.leasingRate||0)), kmPerYear: Math.max(0,Number(v.kmPerYear||0)), kmRate: Math.max(0,Number(v.kmRate??0.52)), leasingUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(v.leasingUntil||""))?String(v.leasingUntil):"",
  registrationImage: String(v.registrationImage||"").startsWith("data:image/") ? String(v.registrationImage).slice(0,1800000) : "",
  updatedAt: new Date().toISOString()
}; }
function cleanIdea(v={}, id="") { return { id:String(id||v.id||uid("idea")).slice(0,80), title:String(v.title||"").trim().slice(0,160), note:String(v.note||"").trim().slice(0,2000), status:["offen","geplant","umgesetzt"].includes(v.status)?v.status:"offen", updatedAt:new Date().toISOString() }; }
const DEFAULT_COMPANY = {
  name: "Farben Krista GmbH & Co KG",
  productiveHoursPerFullTimeYear: 1650,
  defaultBillingRate: 0,
  profitMarkupPercent: 10,
  contingencyPercent: 5,
  overhead: { rent: 0, office: 0, vehicles: 0, insurance: 0, itPhone: 0, energy: 0, machines: 0, finance: 0, taxAdvisor: 0, advertising: 0, other: 0 },
  updatedAt: null
};
function cleanCompany(c = {}) {
  const src = c.overhead || {};
  const overhead = {};
  for (const key of Object.keys(DEFAULT_COMPANY.overhead)) overhead[key] = Math.max(0, Number(src[key] || 0));
  return {
    name: String(c.name || DEFAULT_COMPANY.name).trim().slice(0, 160),
    productiveHoursPerFullTimeYear: Math.max(1, Number(c.productiveHoursPerFullTimeYear || 1650)),
    defaultBillingRate: Math.max(0, Number(c.defaultBillingRate || 0)),
    profitMarkupPercent: Math.max(0, Number(c.profitMarkupPercent ?? 10)),
    contingencyPercent: Math.max(0, Number(c.contingencyPercent ?? 5)),
    overhead, updatedAt: new Date().toISOString()
  };
}
async function readCompany() {
  const p = companyPath();
  if (!fs.existsSync(p)) { await ensureDir(systemDataDir()); const c = cleanCompany(DEFAULT_COMPANY); await fsp.writeFile(p, JSON.stringify(c, null, 2), "utf8"); return c; }
  try { return cleanCompany(JSON.parse(await fsp.readFile(p, "utf8"))); } catch { return cleanCompany(DEFAULT_COMPANY); }
}
async function writeCompany(c) { const clean = cleanCompany(c); await ensureDir(systemDataDir()); await fsp.writeFile(companyPath(), JSON.stringify(clean, null, 2), "utf8"); return clean; }
function overlapFractionForYear(employee, year) {
  const ys = new Date(`${year}-01-01T12:00:00`), ye = new Date(`${year}-12-31T12:00:00`);
  let start = employee.employmentStart ? new Date(employee.employmentStart + "T12:00:00") : ys;
  let end = employee.employmentEnd ? new Date(employee.employmentEnd + "T12:00:00") : ye;
  if (Number.isNaN(start.getTime())) start = ys; if (Number.isNaN(end.getTime())) end = ye;
  start = start < ys ? ys : start; end = end > ye ? ye : end;
  if (end < start) return 0;
  const days = Math.floor((end - start) / 86400000) + 1;
  const daysInYear = Math.floor((ye - ys) / 86400000) + 1;
  return days / daysInYear;
}
function employeeCalculation(employee, overheadRate = 0, year = new Date().getFullYear(), hoursPerFullTime = 1650) {
  const productiveHours = employee.active === false ? 0 : hoursPerFullTime * (Number(employee.employmentPercent || 0) / 100) * overlapFractionForYear(employee, year);
  const salaryCostRate = Number(employee.grossMonthlySalary || 0) * 18 / 1650;
  return { productiveHours, salaryCostRate, fullCostRate: salaryCostRate + overheadRate };
}
async function calculationSummary(year = new Date().getFullYear()) {
  const company = await readCompany();
  const employees = await readEmployees();
  const employeeCalcs = employees.map(e => ({ employee: e, calculation: employeeCalculation(e, 0, year, company.productiveHoursPerFullTimeYear) }));
  const productiveHours = employeeCalcs.reduce((sum, x) => sum + x.calculation.productiveHours, 0);
  const annualSalaryCosts = employeeCalcs.reduce((sum, x) => {
    if (x.employee.active === false) return sum;
    const fraction = overlapFractionForYear(x.employee, year);
    const employment = Number(x.employee.employmentPercent || 0) / 100;
    return sum + Number(x.employee.grossMonthlySalary || 0) * 18 * employment * fraction;
  }, 0);
  const vehicles = await readJsonArrayFile(vehiclesPath());
  const vehicleLeasingAnnual = vehicles.reduce((sum, v) => sum + Number(v.leasingRate || 0) * 12, 0);
  const vehicleMileageAnnual = vehicles.reduce((sum, v) => sum + Number(v.kmPerYear || 0) * Number(v.kmRate ?? 0.52), 0);
  const vehicleCostsAnnual = vehicleLeasingAnnual + vehicleMileageAnnual;
  company.overhead.vehicles = vehicleCostsAnnual;
  const overheadTotal = Object.values(company.overhead || {}).reduce((sum, v) => sum + Number(v || 0), 0);
  const overheadRate = productiveHours > 0 ? overheadTotal / productiveHours : 0;
  const averageSalaryCostRate = productiveHours > 0 ? annualSalaryCosts / productiveHours : 0;
  const averageFullCostRate = averageSalaryCostRate + overheadRate;
  const currentBillingRate = averageFullCostRate * (1 + (Number(company.profitMarkupPercent || 0) + Number(company.contingencyPercent || 0)) / 100);
  return {
    company, year, productiveHours, annualSalaryCosts, vehicleLeasingAnnual, vehicleMileageAnnual, vehicleCostsAnnual, overheadTotal, overheadRate,
    averageSalaryCostRate, averageFullCostRate, currentBillingRate,
    employees: employeeCalcs.map(x => ({ ...x.employee, calculation: employeeCalculation(x.employee, overheadRate, year, company.productiveHoursPerFullTimeYear) }))
  };
}

const DEFAULT_WORKTIME_MODELS = [
  {
    id: "krista-standard",
    name: "Krista Standard",
    active: true,
    description: "Jänner bis März Freitag frei; April bis Dezember Freitag 07:00–14:15. Montag bis Donnerstag ganzjährig 07:00–17:00.",
    seasons: [
      {
        id: "winter", name: "Winter", months: [1,2,3],
        weekdays: {
          "1": { from: "07:00", to: "17:00", lunchBreakMinutes: 30, otherBreakMinutes: 15, targetHours: 9.25 },
          "2": { from: "07:00", to: "17:00", lunchBreakMinutes: 30, otherBreakMinutes: 15, targetHours: 9.25 },
          "3": { from: "07:00", to: "17:00", lunchBreakMinutes: 30, otherBreakMinutes: 15, targetHours: 9.25 },
          "4": { from: "07:00", to: "17:00", lunchBreakMinutes: 30, otherBreakMinutes: 15, targetHours: 9.25 },
          "5": { free: true, from: "", to: "", lunchBreakMinutes: 0, otherBreakMinutes: 0, targetHours: 0 }
        }
      },
      {
        id: "april-december", name: "April bis Dezember", months: [4,5,6,7,8,9,10,11,12],
        weekdays: {
          "1": { from: "07:00", to: "17:00", lunchBreakMinutes: 30, otherBreakMinutes: 15, targetHours: 9.25 },
          "2": { from: "07:00", to: "17:00", lunchBreakMinutes: 30, otherBreakMinutes: 15, targetHours: 9.25 },
          "3": { from: "07:00", to: "17:00", lunchBreakMinutes: 30, otherBreakMinutes: 15, targetHours: 9.25 },
          "4": { from: "07:00", to: "17:00", lunchBreakMinutes: 30, otherBreakMinutes: 15, targetHours: 9.25 },
          "5": { from: "07:00", to: "14:15", lunchBreakMinutes: 0, otherBreakMinutes: 15, targetHours: 7.0 }
        }
      }
    ]
  }
];
async function readWorktimeModels() {
  const p = worktimeModelsPath();
  if (!fs.existsSync(p)) {
    await ensureDir(systemDataDir());
    await fsp.writeFile(p, JSON.stringify(DEFAULT_WORKTIME_MODELS, null, 2), "utf8");
    return DEFAULT_WORKTIME_MODELS;
  }
  try {
    const data = JSON.parse(await fsp.readFile(p, "utf8"));
    return Array.isArray(data) && data.length ? data : DEFAULT_WORKTIME_MODELS;
  } catch {
    return DEFAULT_WORKTIME_MODELS;
  }
}
function scheduleForDate(model, dateStr) {
  const d = new Date(String(dateStr) + "T12:00:00");
  if (Number.isNaN(d.getTime())) return null;
  const month = d.getMonth() + 1;
  const weekday = d.getDay(); // 0 So, 1 Mo ... 5 Fr
  const season = (model?.seasons || []).find(s => (s.months || []).includes(month));
  const rule = season?.weekdays?.[String(weekday)] || { free: true, from: "", to: "", lunchBreakMinutes: 0, otherBreakMinutes: 0, targetHours: 0 };
  return {
    modelId: model?.id || "", modelName: model?.name || "", seasonId: season?.id || "", seasonName: season?.name || "",
    weekday, free: !!rule.free, from: rule.from || "", to: rule.to || "",
    lunchBreakMinutes: Number(rule.lunchBreakMinutes || 0), otherBreakMinutes: Number(rule.otherBreakMinutes || 0),
    breakMinutes: Number(rule.lunchBreakMinutes || 0) + Number(rule.otherBreakMinutes || 0), targetHours: Number(rule.targetHours || 0)
  };
}
function employeeIdFromName(name) {
  const base = String(name || "employee")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "employee";
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
function cleanEmployeeMaster(e, existingId = "") {
  const name = String(e?.name || "").trim().slice(0, 120);
  return {
    id: String(e?.id || existingId || employeeIdFromName(name)).trim().slice(0, 80),
    name,
    shortCode: String(e?.shortCode || "").trim().slice(0, 20),
    phone: String(e?.phone || "").trim().slice(0, 40),
    role: String(e?.role || "Maler").trim().slice(0, 80),
    team: String(e?.team || "").trim().slice(0, 80),
    specialties: Array.isArray(e?.specialties)
      ? e.specialties.map(x => String(x || "").trim()).filter(Boolean).slice(0, 30)
      : String(e?.specialties || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 30),
    foreman: !!e?.foreman,
    canManageTeam: !!e?.canManageTeam,
    active: e?.active !== false,
    worktimeModelId: String(e?.worktimeModelId || "krista-standard").trim().slice(0, 80),
    grossMonthlySalary: Math.max(0, Number(e?.grossMonthlySalary || 0)),
    employmentPercent: Math.min(100, Math.max(0, Number(e?.employmentPercent ?? 100))),
    employmentStart: /^\d{4}-\d{2}-\d{2}$/.test(String(e?.employmentStart || "")) ? String(e.employmentStart) : "",
    employmentEnd: /^\d{4}-\d{2}-\d{2}$/.test(String(e?.employmentEnd || "")) ? String(e.employmentEnd) : "",
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(String(e?.birthDate || "")) ? String(e.birthDate) : "",
    drivingLicenseLastCheck: /^\d{4}-\d{2}-\d{2}$/.test(String(e?.drivingLicenseLastCheck || "")) ? String(e.drivingLicenseLastCheck) : "",
    drivingLicenseFrontImage: String(e?.drivingLicenseFrontImage || e?.drivingLicenseImage || "").startsWith("data:image/") ? String(e.drivingLicenseFrontImage || e.drivingLicenseImage).slice(0, 3500000) : "",
    drivingLicenseBackImage: String(e?.drivingLicenseBackImage || "").startsWith("data:image/") ? String(e.drivingLicenseBackImage).slice(0, 3500000) : "",
    passportPage1Image: String(e?.passportPage1Image || e?.passportImage || "").startsWith("data:image/") ? String(e.passportPage1Image || e.passportImage).slice(0, 3500000) : "",
    passportPage2Image: String(e?.passportPage2Image || "").startsWith("data:image/") ? String(e.passportPage2Image).slice(0, 3500000) : "",
    passportExpiry: /^\d{4}-\d{2}-\d{2}$/.test(String(e?.passportExpiry || "")) ? String(e.passportExpiry) : "",
    clothingSizes: {
      tshirt: String(e?.clothingSizes?.tshirt || "").trim().slice(0, 12),
      polo: String(e?.clothingSizes?.polo || "").trim().slice(0, 12),
      pullover: String(e?.clothingSizes?.pullover || "").trim().slice(0, 12),
      jacket: String(e?.clothingSizes?.jacket || "").trim().slice(0, 12),
      trousers: String(e?.clothingSizes?.trousers || "").trim().slice(0, 12),
      shoes: String(e?.clothingSizes?.shoes || "").trim().slice(0, 12),
      gloves: String(e?.clothingSizes?.gloves || "").trim().slice(0, 12)
    },
    clothingIssues: Array.isArray(e?.clothingIssues) ? e.clothingIssues.slice(-100).map(x => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(x?.date || "")) ? String(x.date) : "",
      item: String(x?.item || "").trim().slice(0, 80),
      size: String(x?.size || "").trim().slice(0, 20),
      quantity: Math.max(0, Number(x?.quantity || 0)),
      note: String(x?.note || "").trim().slice(0, 200)
    })).filter(x => x.item) : [],
    // Legacy-Felder bleiben lesbar, werden aber nicht mehr als Stammdaten bearbeitet.
    standardStart: String(e?.standardStart || "").trim().slice(0, 5),
    standardEnd: String(e?.standardEnd || "").trim().slice(0, 5),
    standardBreakMinutes: Math.max(0, Number(e?.standardBreakMinutes ?? 0)),
    updatedAt: new Date().toISOString()
  };
}
async function readEmployees() {
  const p = employeesPath();
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(await fsp.readFile(p, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
async function writeEmployees(items) {
  await ensureDir(systemDataDir());
  const sorted = items.slice().sort((a, b) => {
    if (!!a.active !== !!b.active) return a.active ? -1 : 1;
    return String(a.name || "").localeCompare(String(b.name || ""), "de");
  });
  await fsp.writeFile(employeesPath(), JSON.stringify(sorted, null, 2), "utf8");
  return sorted;
}

app.get("/admin/api/vehicles", async (req,res)=>{ if(!requireAdmin(req,res))return; res.json({ok:true,vehicles:await readJsonArrayFile(vehiclesPath())}); });
app.post("/admin/api/vehicles", async (req,res)=>{ if(!requireAdmin(req,res))return; const rows=await readJsonArrayFile(vehiclesPath()); const row=cleanVehicle(req.body||{}); if(!row.label&&!row.plate)return res.status(400).json({ok:false,error:"Bezeichnung oder Kennzeichen fehlt"}); rows.push(row); await writeJsonArrayFile(vehiclesPath(),rows); res.json({ok:true,vehicle:row}); });
app.put("/admin/api/vehicles/:id", async (req,res)=>{ if(!requireAdmin(req,res))return; const rows=await readJsonArrayFile(vehiclesPath()); const i=rows.findIndex(x=>String(x.id)===String(req.params.id)); if(i<0)return res.status(404).json({ok:false,error:"Fahrzeug nicht gefunden"}); rows[i]=cleanVehicle({...rows[i],...(req.body||{})},req.params.id); await writeJsonArrayFile(vehiclesPath(),rows); res.json({ok:true,vehicle:rows[i]}); });
app.delete("/admin/api/vehicles/:id", async (req,res)=>{ if(!requireAdmin(req,res))return; let rows=await readJsonArrayFile(vehiclesPath()); rows=rows.filter(x=>String(x.id)!==String(req.params.id)); await writeJsonArrayFile(vehiclesPath(),rows); res.json({ok:true}); });
app.get("/admin/api/ideas", async (req,res)=>{ if(!requireAdmin(req,res))return; res.json({ok:true,ideas:await readJsonArrayFile(ideasPath())}); });
app.post("/admin/api/ideas", async (req,res)=>{ if(!requireAdmin(req,res))return; const rows=await readJsonArrayFile(ideasPath()); const row=cleanIdea(req.body||{}); if(!row.title)return res.status(400).json({ok:false,error:"Titel fehlt"}); rows.unshift(row); await writeJsonArrayFile(ideasPath(),rows); res.json({ok:true,idea:row}); });
app.put("/admin/api/ideas/:id", async (req,res)=>{ if(!requireAdmin(req,res))return; const rows=await readJsonArrayFile(ideasPath()); const i=rows.findIndex(x=>String(x.id)===String(req.params.id)); if(i<0)return res.status(404).json({ok:false,error:"Idee nicht gefunden"}); rows[i]=cleanIdea({...rows[i],...(req.body||{})},req.params.id); await writeJsonArrayFile(ideasPath(),rows); res.json({ok:true,idea:rows[i]}); });
app.delete("/admin/api/ideas/:id", async (req,res)=>{ if(!requireAdmin(req,res))return; let rows=await readJsonArrayFile(ideasPath()); rows=rows.filter(x=>String(x.id)!==String(req.params.id)); await writeJsonArrayFile(ideasPath(),rows); res.json({ok:true}); });

app.get("/admin/api/worktime-models", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const models = await readWorktimeModels();
    res.json({ ok: true, models });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/admin/api/worktime-models/:modelId/schedule", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const date = String(req.query.date || todayISO());
    const models = await readWorktimeModels();
    const model = models.find(m => String(m.id) === String(req.params.modelId));
    if (!model) return res.status(404).json({ ok: false, error: "Arbeitszeitmodell nicht gefunden" });
    res.json({ ok: true, schedule: scheduleForDate(model, date) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/admin/api/employees", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const summary = await calculationSummary(Number(req.query.year || new Date().getFullYear()));
    const today = new Date();
    const employees = summary.employees.map(e => {
      let nextDrivingLicenseCheck = "";
      let drivingLicenseCheckDue = false;
      if (e.drivingLicenseLastCheck) {
        const d = new Date(e.drivingLicenseLastCheck + "T12:00:00");
        d.setMonth(d.getMonth() + 6);
        nextDrivingLicenseCheck = todayISO(d);
        drivingLicenseCheckDue = d <= today;
      }
      let anniversaryYears = 0;
      if (e.employmentStart) {
        const start = new Date(e.employmentStart + "T12:00:00");
        anniversaryYears = Math.max(0, today.getFullYear() - start.getFullYear() -
          ((today.getMonth() < start.getMonth() || (today.getMonth() === start.getMonth() && today.getDate() < start.getDate())) ? 1 : 0));
      }
      return { ...e, nextDrivingLicenseCheck, drivingLicenseCheckDue, anniversaryYears };
    });
    res.json({ ok: true, employees, overheadRate: summary.overheadRate, productiveHours: summary.productiveHours, currentBillingRate: summary.currentBillingRate });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/admin/api/employees", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const employees = await readEmployees();
    const employee = cleanEmployeeMaster(req.body || {});
    if (!employee.name) return res.status(400).json({ ok: false, error: "Name fehlt" });
    employees.push(employee);
    await writeEmployees(employees);
    res.json({ ok: true, employee });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/admin/api/employees/:employeeId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.params.employeeId || "");
    const employees = await readEmployees();
    const idx = employees.findIndex(e => String(e.id) === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Mitarbeiter nicht gefunden" });
    const createdAt = employees[idx].createdAt || null;
    const employee = cleanEmployeeMaster({ ...employees[idx], ...(req.body || {}), id }, id);
    if (!employee.name) return res.status(400).json({ ok: false, error: "Name fehlt" });
    if (createdAt) employee.createdAt = createdAt;
    employees[idx] = employee;
    await writeEmployees(employees);
    res.json({ ok: true, employee });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/admin/api/employees/:employeeId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.params.employeeId || "");
    const employees = await readEmployees();
    const idx = employees.findIndex(e => String(e.id) === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Mitarbeiter nicht gefunden" });
    // Sicherer als endgültiges Löschen: deaktivieren, damit alte Tageserfassungen nachvollziehbar bleiben.
    employees[idx] = { ...employees[idx], active: false, updatedAt: new Date().toISOString() };
    await writeEmployees(employees);
    res.json({ ok: true, employee: employees[idx] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== Tageserfassung / Regie 3.2.0 =====================
function regiePathForDay(jobId, day) {
  return path.join(resolveExistingDayDir(jobId, day), "regie.json");
}

function emptyRegie(jobId, day) {
  const now = new Date().toISOString();
  return {
    version: "3.2.0",
    jobId: String(jobId),
    day: String(day),
    status: "Entwurf",
    employees: [],
    customerText: "",
    internalNote: "",
    materials: [],
    specialMaterial: "",
    materialTomorrow: { needed: false, text: "" },
    createdAt: now,
    updatedAt: now
  };
}

function cleanEmployee(e) {
  const totalHours = Number(e?.totalHours || 0);
  const regieHours = Math.min(Number(e?.regieHours || 0), totalHours || Number(e?.regieHours || 0));
  return {
    employeeId: String(e?.employeeId || "").trim().slice(0, 80),
    name: String(e?.name || "").trim().slice(0, 100),
    from: String(e?.from || "").trim().slice(0, 5),
    to: String(e?.to || "").trim().slice(0, 5),
    breakMinutes: Math.max(0, Number(e?.breakMinutes || 0)),
    totalHours: Math.max(0, totalHours),
    regieHours: Math.max(0, regieHours),
    regieDescription: String(e?.regieDescription || "").trim().slice(0, 1000)
  };
}

function cleanMaterial(m) {
  return {
    name: String(m?.name || "").trim().slice(0, 180),
    quantity: String(m?.quantity || "").trim().slice(0, 40),
    unit: String(m?.unit || "").trim().slice(0, 40)
  };
}

app.get("/admin/api/job/:jobId/day/:day/regie", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const jobId = String(req.params.jobId);
    const day = String(req.params.day);
    if (!isSafeJobId(jobId) || !isSafeDay(day)) return res.status(400).json({ ok: false, error: "Invalid jobId/day" });
    const dayDir = resolveExistingDayDir(jobId, day);
    if (!fs.existsSync(dayDir)) return res.json({ ok: true, exists: false, regie: emptyRegie(jobId, day) });
    const p = regiePathForDay(jobId, day);
    if (!fs.existsSync(p)) return res.json({ ok: true, exists: false, regie: emptyRegie(jobId, day) });
    const regie = JSON.parse(await fsp.readFile(p, "utf8"));
    return res.json({ ok: true, exists: true, regie });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/admin/api/job/:jobId/day/:day/regie", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const jobId = String(req.params.jobId);
    const day = String(req.params.day);
    if (!isSafeJobId(jobId) || !isSafeDay(day)) return res.status(400).json({ ok: false, error: "Invalid jobId/day" });
    const dayDir = resolveDayDirForWrite(jobId, day);
    await ensureDir(dayDir);

    const p = path.join(dayDir, "regie.json");
    let old = emptyRegie(jobId, day);
    if (fs.existsSync(p)) {
      try { old = JSON.parse(await fsp.readFile(p, "utf8")); } catch {}
    }
    const now = new Date().toISOString();
    const body = req.body || {};
    const regie = {
      version: "3.2.0",
      jobId,
      day,
      status: ["Entwurf", "Geprüft", "Freigegeben", "Abgerechnet"].includes(body.status) ? body.status : "Entwurf",
      employees: Array.isArray(body.employees) ? body.employees.map(cleanEmployee).filter(e => e.name) : [],
      customerText: String(body.customerText || "").trim().slice(0, 12000),
      internalNote: String(body.internalNote || "").trim().slice(0, 12000),
      materials: Array.isArray(body.materials) ? body.materials.map(cleanMaterial).filter(m => m.name) : [],
      specialMaterial: String(body.specialMaterial || "").trim().slice(0, 4000),
      materialTomorrow: {
        needed: !!body.materialTomorrow?.needed,
        text: String(body.materialTomorrow?.text || "").trim().slice(0, 4000)
      },
      createdAt: old.createdAt || now,
      updatedAt: now
    };
    await fsp.writeFile(p, JSON.stringify(regie, null, 2), "utf8");
    const totalHours = regie.employees.reduce((sum, employee) => sum + Number(employee.totalHours || 0), 0);
    await appendJobHistory(jobId, {
      type: "day_report_saved",
      title: "Tagesrapport gespeichert",
      detail: `${day} · ${regie.employees.length} Mitarbeiter · ${totalHours.toFixed(2)} Std.`,
      source: "admin",
      data: { day, employeeCount: regie.employees.length, totalHours }
    });
    res.json({ ok: true, regie });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== Morgenstatus 07:00 / 08:00 =====================
let morningStatus = null;
loadProtocolSessions().catch(console.error);
registerMorningStatus({
  dataDir: DATA_DIR,
  readEmployees,
  sendWhatsApp: sendWhatsAppKristineReply,
  chefPhone: process.env.CHEF_PHONE || "",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
}).then((service) => {
  morningStatus = service;
  console.log("✅ KRISTA Morgenstatus aktiv");
}).catch((error) => console.error("❌ Morgenstatus konnte nicht gestartet werden:", error));

// Manueller Test für Admin, ohne auf 07:00/08:00 warten zu müssen.
app.post("/admin/api/morning-status/test", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!morningStatus) return res.status(503).json({ ok: false, error: "Morgenstatus noch nicht bereit" });
  try {
    const date = String(req.body?.date || req.query.date || todayISO());
    const type = String(req.body?.type || req.query.type || "8");
    const result = type === "7" ? await morningStatus.runSevenOClock(date, true) : await morningStatus.runEightOClock(date, true);
    res.json({ ok: true, type, date, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== 404 handler (LAST) =====================
app.use((req, res) => res.status(404).send(`Not found: ${req.method} ${req.path}`));

// ===================== Start =====================
console.log(`Starting Krista ${APP_VERSION} Build ${APP_BUILD} (${APP_STATUS})…`);
console.log("DATA_DIR=", DATA_DIR);
console.log("MAIL_FROM=", MAIL_FROM);
console.log("MAIL_TO_DEFAULT=", MAIL_TO_DEFAULT);
console.log("PUBLIC_BASE_URL=", PUBLIC_BASE_URL);
console.log("OPENAI_API_KEY set:", !!OPENAI_API_KEY);
console.log("TRANSCRIBE_MODEL:", OPENAI_TRANSCRIBE_MODEL);
console.log("TEXT_MODEL:", OPENAI_TEXT_MODEL);
console.log("LOGO_PATH:", LOGO_PATH);

app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));
