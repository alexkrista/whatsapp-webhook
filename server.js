// server.js (CommonJS) – Baustellenprotokoll FINAL + Admin UI
// ✅ WhatsApp Webhook (Text/Foto/Audio/PDF) -> speichert alles
// ✅ Trigger per WhatsApp: "pdf" (oder "#260016 pdf")
// ✅ Layout A: Text + Transkripte seitenfüllend, danach Fotos (6 pro Seite), WhatsApp-PDFs (Seite 1) eingebettet
// ✅ Deckblatt mit Logo (optional)
// ✅ Kopf-/Fußzeile: Baustellennummer + Datum + Seitenzahl
// ✅ Ordnerstruktur neu: /var/data/<job>/<YYYY>/<MM>/<DD>/...
//    + Fallback liest auch alte Struktur: /var/data/<job>/<YYYY-MM-DD>/...
// ✅ Sprachnachricht: Audio speichern + transkribieren + Dialekt "sauber" formulieren (optional)
// ✅ Admin: /admin/run-daily (Cron), /admin/test-mail, /admin/check-logo, /admin/ui + API + PDF View
//
// Render ENV (wichtig):
// DATA_DIR=/var/data
// VERIFY_TOKEN=...
// WHATSAPP_TOKEN=...
// ADMIN_TOKEN=...
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

const app = express();
app.use(express.json({ limit: "25mb" }));

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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_TRANSCRIBE_LANG = process.env.OPENAI_TRANSCRIBE_LANG || "de";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

const LOGO_PATH = process.env.LOGO_PATH || "assets/krista-logo.png";

const PDF_ALLOWED_FROM = process.env.PDF_ALLOWED_FROM || "";
const PDF_IGNORE_UNKNOWN = String(process.env.PDF_IGNORE_UNKNOWN || "").trim() === "1";

// ===================== Baustellen-Merker =====================
const LAST_SITE_BY_SENDER = {}; // { wa_id: { siteCode, tsMs } }
const SITE_TTL_MS = 4 * 60 * 60 * 1000;

function rememberSite(sender, siteCode) {
  LAST_SITE_BY_SENDER[sender] = { siteCode, tsMs: Date.now() };
}
function recallSite(sender) {
  const rec = LAST_SITE_BY_SENDER[sender];
  if (!rec) return null;
  if (Date.now() - rec.tsMs > SITE_TTL_MS) return null;
  return rec.siteCode;
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
function parseSiteCodeFromText(text) {
  const m = String(text || "").match(/#(\d{3,})\b/);
  return m ? m[1] : null;
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

  function drawHeaderFooter(page, pageNo, totalPages) {
    page.drawText(`#${jobId}  |  ${date}`, {
      x: 60,
      y: PAGE_H - 40,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
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
    page.drawText(`Datum: ${date}`, { x: 60, y: PAGE_H - 180, size: 16, font });
    page.drawText(`Einträge: ${logs.length}`, { x: 60, y: PAGE_H - 210, size: 16, font });
    page.drawText(`Fotos: ${imageFiles.length}`, { x: 60, y: PAGE_H - 240, size: 16, font });

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

  // PDF SECTION (embed first page of WhatsApp PDFs)
  for (const entry of logs) {
    if (entry.type !== "pdf" || !entry.file) continue;
    const pdfFilePath = path.join(dayDir, entry.file);
    if (!fs.existsSync(pdfFilePath)) continue;

    try {
      const srcBytes = await fsp.readFile(pdfFilePath);
      const srcPdf = await PDFDocument.load(srcBytes);
      const [srcPage] = await pdf.copyPages(srcPdf, [0]);
      pdf.addPage(srcPage);

      const stamp = entry.raw?.timestamp ? stampDE(entry.raw.timestamp) : "";
      const last = pdf.getPages()[pdf.getPages().length - 1];

      last.drawRectangle({
        x: 40,
        y: PAGE_H - 90,
        width: PAGE_W - 80,
        height: 55,
        color: rgb(1, 1, 1),
        opacity: 0.85,
      });
      last.drawText(`PDF aus WhatsApp: ${entry.file}`, {
        x: 60,
        y: PAGE_H - 70,
        size: 12,
        font,
        color: rgb(0, 0, 0),
      });
      if (stamp) {
        last.drawText(stamp, {
          x: PAGE_W - 60 - 200,
          y: PAGE_H - 70,
          size: 12,
          font,
          color: rgb(0, 0, 0),
        });
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
          imgBuf = await sharp(imgBuf)
            .resize({ width: targetW, height: targetH, fit: "inside" })
            .jpeg({ quality: 72 })
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

// ===================== Trigger PDF =====================
async function triggerPdfForJobDay({ jobId, date, to }) {
  const dayDir = resolveExistingDayDir(jobId, date);
  if (!fs.existsSync(dayDir)) throw new Error(`No data dir for #${jobId} at ${date}`);

  const outPdf = path.join(dayDir, `Baustellenprotokoll_${jobId}_${date}.pdf`);
  const built = await buildPdfForJobDay(jobId, date, dayDir, outPdf);

  const subject = `Baustellenprotokoll #${jobId} – ${date}`;
  const body = `Im Anhang: Baustellenprotokoll #${jobId} (${date}).\nSeiten: ${built.pages}\n`;

  const sent = await sendMailWithAttachment({ to, subject, text: body, filePath: outPdf });
  return { outPdf, built, mailed: !!sent, messageId: sent?.messageId || null };
}

// ===================== Base Routes =====================
app.get("/", (req, res) => res.type("text").send("webhook läuft ✅"));

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    time: new Date().toISOString(),
    openai_key: !!OPENAI_API_KEY,
    transcribe_model: OPENAI_TRANSCRIBE_MODEL,
    text_model: OPENAI_TEXT_MODEL,
    logo_path: LOGO_PATH,
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

// ===================== WhatsApp Incoming =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msgs = value?.messages || [];
    if (!Array.isArray(msgs) || msgs.length === 0) return;

    for (const msg of msgs) {
      const sender = msg.from || "unknown_sender";
      const tsSec = msg.timestamp || null;
      const date = isoDateFromWhatsAppTs(tsSec);

      const textOrCaption = parseCaptionTextFromMessage(msg);
      let siteCode = parseSiteCodeFromText(textOrCaption);

      if (siteCode) rememberSite(sender, siteCode);
      else siteCode = recallSite(sender) || "unknown";

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

      // TRIGGER PDF via WhatsApp "pdf"
      if (msg.type === "text" && isPdfCommand(textOrCaption)) {
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

      const subject = `Baustellenprotokoll #${jobId} – ${date}`;
      const text = `Im Anhang: Baustellenprotokoll #${jobId} (${date}).\nSeiten: ${built.pages}\n`;

      const sent = await sendMailWithAttachment({ to, subject, text, filePath: outPdf });
      results.push({ jobId, date, pages: built.pages, mailed: !!sent });
    }

    res.json({ ok: true, date, to, count: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== Admin UI + API + PDF =====================

// Admin UI (serves /public/admin.html)
app.get("/admin/ui", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.sendFile(path.join(process.cwd(), "public", "admin.html"));
});

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

// Admin API: list jobs
app.get("/admin/api/jobs", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobIds = await fsp.readdir(DATA_DIR).catch(() => []);
    const filtered = jobIds
      .filter((j) => j && j !== "unknown" && j !== "_unassigned")
      .filter((j) => fs.existsSync(path.join(DATA_DIR, j)));

    const jobs = [];
    for (const jobId of filtered) {
      const days = await listDaysForJob(jobId);
      const latestDay = days[0] || null;
      let stats = { items: 0, images: 0, audio: 0, pdfs: 0 };

      if (latestDay) {
        const dayDir = resolveExistingDayDir(jobId, latestDay);
        if (fs.existsSync(dayDir)) stats = await readLogStats(dayDir);
      }

      jobs.push({
        jobId,
        daysCount: days.length,
        latestDay,
        itemsLastDay: stats.items,
        imagesLastDay: stats.images,
        audioLastDay: stats.audio,
        pdfsLastDay: stats.pdfs,
      });
    }

    jobs.sort((a, b) => (b.latestDay || "").localeCompare(a.latestDay || ""));
    res.json({ ok: true, jobs });
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
    res.json({ ok: true, jobId, days });
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
    if (!fs.existsSync(pdfPath)) {
      await buildPdfForJobDay(jobId, day, dayDir, pdfPath);
    }

    res.setHeader("Content-Type", "application/pdf");
    return res.sendFile(pdfPath);
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

// ===================== 404 handler (LAST) =====================
app.use((req, res) => res.status(404).send(`Not found: ${req.method} ${req.path}`));
// Admin: list jobs
app.get("/admin/list-jobs", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const jobs = [];
    const jobIds = await fsp.readdir(DATA_DIR).catch(() => []);

    for (const jobId of jobIds) {
      if (jobId.startsWith(".")) continue;

      const jobDir = path.join(DATA_DIR, jobId);
      const stat = await fsp.stat(jobDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const days = await fsp.readdir(jobDir).catch(() => []);
      const validDays = [];

      for (const d of days) {
        const dayDir = path.join(jobDir, d);
        const s = await fsp.stat(dayDir).catch(() => null);
        if (s && s.isDirectory()) validDays.push(d);
      }

      validDays.sort().reverse();

      let items = 0, images = 0, audio = 0;

      if (validDays.length > 0) {
        const latestDir = path.join(jobDir, validDays[0]);
        const files = await fsp.readdir(latestDir).catch(() => []);

        for (const f of files) {
          if (f.endsWith(".jsonl")) items++;
          if (f.match(/\.(jpg|jpeg|png)$/i)) images++;
          if (f.match(/\.(mp3|ogg|m4a|wav)$/i)) audio++;
        }
      }

      jobs.push({
        jobId,
        daysCount: validDays.length,
        latestDay: validDays[0] || null,
        itemsLastDay: items,
        imagesLastDay: images,
        audioLastDay: audio,
      });
    }

    jobs.sort((a, b) => (b.latestDay || "").localeCompare(a.latestDay || ""));

    res.json({ ok: true, jobs });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ===================== Start =====================
console.log("Starting…");
console.log("DATA_DIR=", DATA_DIR);
console.log("MAIL_FROM=", MAIL_FROM);
console.log("MAIL_TO_DEFAULT=", MAIL_TO_DEFAULT);
console.log("OPENAI_API_KEY set:", !!OPENAI_API_KEY);
console.log("TRANSCRIBE_MODEL:", OPENAI_TRANSCRIBE_MODEL);
console.log("TEXT_MODEL:", OPENAI_TEXT_MODEL);
console.log("LOGO_PATH:", LOGO_PATH);

app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));
