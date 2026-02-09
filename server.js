// server.js (CommonJS) — WhatsApp webhook + Media download + Daily PDF + Email via Brevo
// Works on Render (Node 18+ / 20+ / 22+)

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const sharp = require("sharp");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;

const DATA_DIR = process.env.DATA_DIR || "/var/data";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; // 1026421043884083

// Mail (Brevo SMTP)
const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || ""; // e.g. a1e02a001@smtp-brevo.com
const SMTP_PASS = process.env.SMTP_PASS || ""; // SMTP key
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const MAIL_TO_DEFAULT = process.env.MAIL_TO_DEFAULT || "";

// Admin protection
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // set this!

// -------------------- APP --------------------
const app = express();
app.use(express.json({ limit: "25mb" }));

// simple logger
app.use((req, res, next) => {
  const t = new Date().toISOString();
  console.log(`[${t}] ${req.method} ${req.url}`);
  next();
});

// -------------------- HELPERS --------------------
function ensureEnvOrThrow() {
  if (!VERIFY_TOKEN) console.warn("⚠️ VERIFY_TOKEN missing");
  if (!WHATSAPP_TOKEN) console.warn("⚠️ WHATSAPP_TOKEN missing");
  if (!PHONE_NUMBER_ID) console.warn("⚠️ PHONE_NUMBER_ID missing");
  if (!SMTP_USER || !SMTP_PASS || !MAIL_TO_DEFAULT) {
    console.warn("⚠️ SMTP_USER/SMTP_PASS/MAIL_TO_DEFAULT missing (mail will fail)");
  }
  if (!ADMIN_TOKEN) console.warn("⚠️ ADMIN_TOKEN missing (admin endpoints unprotected!)");
}

function todayISO(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeName(s) {
  return String(s || "").replace(/[^\w.-]+/g, "_");
}

function parseJobIdFromText(text) {
  // expects "#260016 ..." -> "260016"
  const m = String(text || "").match(/#(\d{3,})/);
  return m ? m[1] : "unknown";
}

async function mkdirp(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function appendJsonl(filePath, obj) {
  await mkdirp(path.dirname(filePath));
  await fsp.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8");
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
  return await r.json();
}

async function fetchBuffer(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) return true; // if not set, allow (but you should set it!)
  const tok = req.headers["x-admin-token"] || req.query.token || "";
  if (tok !== ADMIN_TOKEN) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

// -------------------- WHATSAPP MEDIA DOWNLOAD --------------------
async function downloadWhatsAppMedia(mediaId, outPath) {
  // Step 1: get media URL
  const meta = await fetchJson(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!meta || !meta.url) throw new Error("No media url in Graph response");

  // Step 2: download bytes
  const buf = await fetchBuffer(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  await mkdirp(path.dirname(outPath));
  await fsp.writeFile(outPath, buf);
  return { bytes: buf.length, mime_type: meta.mime_type || "", sha256: meta.sha256 || "" };
}

// -------------------- ROUTES --------------------
app.get("/", (req, res) => res.type("text").send("webhook läuft ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Meta Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(String(challenge));
  }
  console.log("❌ Webhook verify failed");
  return res.sendStatus(403);
});

// Incoming messages (POST)
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("Incoming webhook:", JSON.stringify(body));

    // We always respond 200 quickly to Meta
    res.sendStatus(200);

    // Extract WhatsApp messages
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msgs = value?.messages || [];
    if (!Array.isArray(msgs) || msgs.length === 0) return;

    for (const msg of msgs) {
      const msgType = msg.type;
      const from = msg.from;
      const ts = Number(msg.timestamp || 0) * 1000 || Date.now();

      const text =
        msgType === "text" ? msg.text?.body :
        msgType === "button" ? msg.button?.text :
        msgType === "interactive" ? JSON.stringify(msg.interactive) :
        "";

      const jobId = parseJobIdFromText(text);
      const date = todayISO(new Date(ts));

      const baseDir = path.join(DATA_DIR, jobId, date);
      await mkdirp(baseDir);

      // Save full raw webhook into log.jsonl
      const logPath = path.join(baseDir, "log.jsonl");
      await appendJsonl(logPath, {
        at: new Date(ts).toISOString(),
        from,
        type: msgType,
        text,
        raw: msg,
      });

      // If media, download and store with timestamp prefix
      if (msgType === "image" && msg.image?.id) {
        const mediaId = msg.image.id;
        const filename = `${Math.floor(ts / 1000)}_${mediaId}.jpg`;
        const out = path.join(baseDir, filename);
        const info = await downloadWhatsAppMedia(mediaId, out);
        console.log(`✅ saved image for #${jobId} -> ${out} (${info.bytes} bytes)`);
      } else if (msgType === "document" && msg.document?.id) {
        const mediaId = msg.document.id;
        const ext = (msg.document.mime_type || "").includes("pdf") ? "pdf" : "bin";
        const filename = `${Math.floor(ts / 1000)}_${mediaId}.${ext}`;
        const out = path.join(baseDir, filename);
        const info = await downloadWhatsAppMedia(mediaId, out);
        console.log(`✅ saved document for #${jobId} -> ${out} (${info.bytes} bytes)`);
      } else if (msgType === "audio" && msg.audio?.id) {
        const mediaId = msg.audio.id;
        const filename = `${Math.floor(ts / 1000)}_${mediaId}.ogg`;
        const out = path.join(baseDir, filename);
        const info = await downloadWhatsAppMedia(mediaId, out);
        console.log(`✅ saved audio for #${jobId} -> ${out} (${info.bytes} bytes)`);
      }
    }
  } catch (e) {
    console.error("Webhook handler error:", e);
    // NOTE: response already sent above
  }
});

// -------------------- PDF BUILD --------------------
async function listImages(dir) {
  const files = await fsp.readdir(dir).catch(() => []);
  return files
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .map(f => path.join(dir, f))
    .sort();
}

async function readTextLog(dir) {
  const logPath = path.join(dir, "log.jsonl");
  const exists = fs.existsSync(logPath);
  if (!exists) return [];
  const content = await fsp.readFile(logPath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const items = [];
  for (const line of lines) {
    try { items.push(JSON.parse(line)); } catch {}
  }
  return items;
}

async function buildPdfForJobDay(jobId, dayDir, outPdfPath) {
  // A3 landscape in points: 420mm x 297mm -> 1190.55 x 841.89
  const PAGE_W = 1190.55;
  const PAGE_H = 841.89;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const images = await listImages(dayDir);
  const logs = await readTextLog(dayDir);

  // --- Cover page ---
  {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawText("Baustellenprotokoll", { x: 60, y: PAGE_H - 90, size: 38, font: fontBold });
    page.drawText(`#${jobId}`, { x: 60, y: PAGE_H - 140, size: 24, font: fontBold });
    page.drawText(`Datum: ${path.basename(dayDir)}`, { x: 60, y: PAGE_H - 180, size: 16, font });
    page.drawText(`Fotos: ${images.length}`, { x: 60, y: PAGE_H - 210, size: 16, font });
    page.drawText(`Einträge: ${logs.length}`, { x: 60, y: PAGE_H - 240, size: 16, font });

    const hint = "Hinweis: Fotos sind chronologisch nach Dateiname sortiert.";
    page.drawText(hint, { x: 60, y: 60, size: 12, font, color: rgb(0.3,0.3,0.3) });
  }

  // --- Photos: 6 per page (3x2) ---
  const cols = 3, rows = 2;
  const margin = 40;
  const gutter = 18;
  const cellW = (PAGE_W - margin * 2 - gutter * (cols - 1)) / cols;
  const cellH = (PAGE_H - margin * 2 - gutter * (rows - 1)) / rows;

  for (let i = 0; i < images.length; i += 6) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const chunk = images.slice(i, i + 6);

    for (let j = 0; j < chunk.length; j++) {
      const imgPath = chunk[j];
      const col = j % cols;
      const row = Math.floor(j / cols);

      const x0 = margin + col * (cellW + gutter);
      const yTop = PAGE_H - margin - row * (cellH + gutter);
      const captionH = 24;

      // Fit image into (cellW x (cellH - captionH))
      const targetW = Math.floor(cellW);
      const targetH = Math.floor(cellH - captionH);

      // Resize/compress to keep PDF smaller
      let imgBuf = await fsp.readFile(imgPath);
      try {
        imgBuf = await sharp(imgBuf)
          .resize({ width: targetW, height: targetH, fit: "inside" })
          .jpeg({ quality: 72 })
          .toBuffer();
      } catch {
        // if sharp fails, keep original
      }

      const img = await pdf.embedJpg(imgBuf).catch(async () => {
        // try png
        return await pdf.embedPng(imgBuf);
      });

      const { width, height } = img.scale(1);
      const scale = Math.min(targetW / width, targetH / height);
      const drawW = width * scale;
      const drawH = height * scale;

      const x = x0 + (targetW - drawW) / 2;
      const y = (yTop - captionH) - drawH;

      page.drawImage(img, { x, y, width: drawW, height: drawH });

      // caption = original filename
      const fname = path.basename(imgPath);
      page.drawText(fname, {
        x: x0,
        y: yTop - captionH + 6,
        size: 10,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
    }
  }

  const bytes = await pdf.save();
  await mkdirp(path.dirname(outPdfPath));
  await fsp.writeFile(outPdfPath, bytes);
  return { pages: pdf.getPageCount(), bytes: bytes.length };
}

// -------------------- EMAIL --------------------
function makeMailer() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendMailWithPdf({ to, subject, text, pdfPath }) {
  const mailer = makeMailer();
  const pdfBuf = await fsp.readFile(pdfPath);
  const info = await mailer.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    text,
    attachments: [
      { filename: path.basename(pdfPath), content: pdfBuf, contentType: "application/pdf" },
    ],
  });
  return info;
}

// -------------------- ADMIN: RUN DAILY --------------------
app.get("/admin/run-daily", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    // Run for "today" by default, can override ?date=YYYY-MM-DD
    const date = req.query.date || todayISO();
    const to = req.query.to || MAIL_TO_DEFAULT;

    if (!to) return res.status(400).send("MAIL_TO_DEFAULT missing (or pass ?to=...)");

    // For each jobId folder, build PDF for that day if folder exists
    const jobIds = await fsp.readdir(DATA_DIR).catch(() => []);
    const results = [];

    for (const jobId of jobIds) {
      const dayDir = path.join(DATA_DIR, jobId, date);
      if (!fs.existsSync(dayDir)) continue;

      const outPdf = path.join(DATA_DIR, jobId, date, `Baustellenprotokoll_${jobId}_${date}.pdf`);
      const built = await buildPdfForJobDay(jobId, dayDir, outPdf);

      // send
      const subject = `Baustellenprotokoll #${jobId} – ${date}`;
      const body = `Im Anhang: Baustellenprotokoll #${jobId} (${date}).\nSeiten: ${built.pages}\n`;
      const sent = await sendMailWithPdf({ to, subject, text: body, pdfPath: outPdf });

      results.push({ jobId, date, pdf: outPdf, pages: built.pages, bytes: built.bytes, messageId: sent.messageId });
      console.log(`📧 sent ${jobId} ${date} -> ${to} (${built.pages} pages)`);
    }

    res.json({ ok: true, date, to, count: results.length, results });
  } catch (e) {
    console.error("admin/run-daily error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Simple SMTP test
app.get("/admin/test-mail", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const to = req.query.to || MAIL_TO_DEFAULT;
    if (!to) return res.status(400).send("MAIL_TO_DEFAULT missing (or pass ?to=...)");
    const mailer = makeMailer();
    const info = await mailer.sendMail({
      from: MAIL_FROM,
      to,
      subject: "Testmail (Brevo SMTP)",
      text: "Wenn du das liest, passt SMTP ✅",
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    console.error("admin/test-mail error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

ensureEnvOrThrow();

app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
});
