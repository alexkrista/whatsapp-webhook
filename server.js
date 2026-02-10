// server.js (CommonJS) – WhatsApp Webhook + Media speichern + PDF (Text/Fotos/PDFs) + Audio-Transkription
// Trigger: WhatsApp Text enthält "pdf" -> Protokoll-PDF erstellen + mailen
//
// NEU:
// - Audio (Sprachnachricht) wird transkribiert (OpenAI /v1/audio/transcriptions) und als Textseite ins Protokoll übernommen.
// - PDF (WhatsApp Document mime application/pdf) wird gespeichert und die 1. Seite wird in das Protokoll eingebettet.
//
// ENV (zusätzlich):
// OPENAI_API_KEY=...
// OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe  (optional)
// OPENAI_TRANSCRIBE_LANG=de                  (optional)

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const sharp = require("sharp");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

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

// OpenAI transcription
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const OPENAI_TRANSCRIBE_LANG = process.env.OPENAI_TRANSCRIBE_LANG || "de";

// Optional allowlist for "pdf" trigger
const PDF_ALLOWED_FROM = process.env.PDF_ALLOWED_FROM || "";
const PDF_IGNORE_UNKNOWN = String(process.env.PDF_IGNORE_UNKNOWN || "").trim() === "1";

// ===================== App =====================
const app = express();
app.use(express.json({ limit: "25mb" }));

// ===================== Baustellen-Merker (Option B) =====================
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

// ===================== OpenAI Transcription =====================
async function transcribeAudio({ audioBuffer, filename = "audio.ogg" }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const form = new FormData();
  // Node 18+ supports Blob/FormData
  const blob = new Blob([audioBuffer], { type: "audio/ogg" });
  form.append("file", blob, filename);
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  if (OPENAI_TRANSCRIBE_LANG) form.append("language", OPENAI_TRANSCRIBE_LANG);

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI transcription failed (${r.status}): ${t}`);
  }
  const j = await r.json();
  // docs: response includes "text"
  return j.text || "";
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

// ===================== PDF Build (A3 quer) =====================
async function listFiles(dayDir) {
  const files = await fsp.readdir(dayDir).catch(() => []);
  return files.slice().sort();
}
async function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = await fsp.readFile(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const items = [];
  for (const line of lines) {
    try { items.push(JSON.parse(line)); } catch {}
  }
  return items;
}

async function buildPdfForJobDay(jobId, date, dayDir, outPdfPath) {
  const PAGE_W = 1190.55; // A3 landscape
  const PAGE_H = 841.89;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const logPath = path.join(dayDir, "log.jsonl");
  const logs = await readJsonLines(logPath);

  // Sort by timestamp if present
  logs.sort((a, b) => (a.raw?.timestamp ? Number(a.raw.timestamp) : 0) - (b.raw?.timestamp ? Number(b.raw.timestamp) : 0));

  const imageFiles = (await listFiles(dayDir)).filter(f => /\.(jpg|jpeg|png)$/i.test(f));

  // ---- Cover ----
  {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawText("Baustellenprotokoll", { x: 60, y: PAGE_H - 90, size: 38, font: fontBold });
    page.drawText(`#${jobId}`, { x: 60, y: PAGE_H - 140, size: 24, font: fontBold });
    page.drawText(`Datum: ${date}`, { x: 60, y: PAGE_H - 180, size: 16, font });
    page.drawText(`Einträge: ${logs.length}`, { x: 60, y: PAGE_H - 210, size: 16, font });
    page.drawText(`Fotos: ${imageFiles.length}`, { x: 60, y: PAGE_H - 240, size: 16, font });
    page.drawText("Text, Fotos, PDFs & Sprachnachrichten (Transkript)", {
      x: 60, y: 80, size: 12, font, color: rgb(0.3,0.3,0.3),
    });
  }

  // ---- Per-entry pages (Text / Audio transcript / PDF page 1) ----
  for (const entry of logs) {
    const raw = entry.raw || {};
    const ts = raw.timestamp ? Number(raw.timestamp) : null;
    const stamp = ts ? stampDE(ts) : "";

    // TEXT
    if (entry.type === "text" && raw.text?.body) {
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      page.drawText("Text", { x: 60, y: PAGE_H - 80, size: 18, font: fontBold });
      page.drawText(stamp, { x: 60, y: PAGE_H - 110, size: 12, font, color: rgb(0.2,0.2,0.2) });
      page.drawText(raw.text.body, { x: 60, y: PAGE_H - 160, size: 14, font, maxWidth: PAGE_W - 120 });
      continue;
    }

    // AUDIO (transcript)
    if (entry.type === "audio_transcript" && entry.transcript) {
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      page.drawText("Sprachnachricht (Transkript)", { x: 60, y: PAGE_H - 80, size: 18, font: fontBold });
      page.drawText(stamp, { x: 60, y: PAGE_H - 110, size: 12, font, color: rgb(0.2,0.2,0.2) });
      page.drawText(entry.transcript, { x: 60, y: PAGE_H - 160, size: 14, font, maxWidth: PAGE_W - 120 });
      continue;
    }

    // PDF (embed first page)
    if (entry.type === "pdf" && entry.file) {
      const pdfFilePath = path.join(dayDir, entry.file);
      if (fs.existsSync(pdfFilePath)) {
        try {
          const srcBytes = await fsp.readFile(pdfFilePath);
          const srcPdf = await PDFDocument.load(srcBytes);
          const [srcPage] = await pdf.copyPages(srcPdf, [0]); // first page
          pdf.addPage(srcPage);

          // Add a small header overlay (timestamp + filename) on the copied page
          const last = pdf.getPages()[pdf.getPages().length - 1];
          last.drawRectangle({ x: 40, y: PAGE_H - 70, width: PAGE_W - 80, height: 40, color: rgb(1,1,1), opacity: 0.8 });
          last.drawText(`PDF: ${entry.file}`, { x: 60, y: PAGE_H - 55, size: 12, font, color: rgb(0,0,0) });
          if (stamp) last.drawText(stamp, { x: PAGE_W - 260, y: PAGE_H - 55, size: 12, font, color: rgb(0,0,0) });
        } catch (e) {
          const page = pdf.addPage([PAGE_W, PAGE_H]);
          page.drawText("PDF (Fehler beim Einbetten)", { x: 60, y: PAGE_H - 80, size: 18, font: fontBold });
          page.drawText(stamp, { x: 60, y: PAGE_H - 110, size: 12, font });
          page.drawText(String(e?.message || e), { x: 60, y: PAGE_H - 160, size: 12, font, maxWidth: PAGE_W - 120 });
        }
      }
      continue;
    }
  }

  // ---- Photos: 6 per page (3x2) ----
  if (imageFiles.length) {
    const cols = 3, rows = 2;
    const margin = 40;
    const gutter = 18;
    const cellW = (PAGE_W - margin * 2 - gutter * (cols - 1)) / cols;
    const cellH = (PAGE_H - margin * 2 - gutter * (rows - 1)) / rows;

    for (let i = 0; i < imageFiles.length; i += 6) {
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      const chunk = imageFiles.slice(i, i + 6);

      for (let j = 0; j < chunk.length; j++) {
        const col = j % cols;
        const row = Math.floor(j / cols);

        const x0 = margin + col * (cellW + gutter);
        const yTop = PAGE_H - margin - row * (cellH + gutter);

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
        try { img = await pdf.embedJpg(imgBuf); } catch { img = await pdf.embedPng(imgBuf); }

        const w0 = img.width;
        const h0 = img.height;
        const scale = Math.min(targetW / w0, targetH / h0);
        const drawW = w0 * scale;
        const drawH = h0 * scale;

        const x = x0 + (targetW - drawW) / 2;
        const y = (yTop - captionH) - drawH;

        page.drawImage(img, { x, y, width: drawW, height: drawH });

        const stamp = stampDEFromFilename(fname);
        const caption = stamp ? `${stamp}  |  ${fname}` : fname;

        page.drawText(caption, { x: x0, y: yTop - captionH + 8, size: 10, font, color: rgb(0.2,0.2,0.2) });
      }
    }
  }

  const bytes = await pdf.save();
  await ensureDir(path.dirname(outPdfPath));
  await fsp.writeFile(outPdfPath, bytes);
  return { pages: pdf.getPageCount(), bytes: bytes.length };
}

// ===================== PDF trigger =====================
async function triggerPdfForJobDay({ jobId, date, to }) {
  const dayDir = path.join(DATA_DIR, jobId, date);
  if (!fs.existsSync(dayDir)) throw new Error(`No data dir for #${jobId} at ${date}`);

  const outPdf = path.join(dayDir, `Baustellenprotokoll_${jobId}_${date}.pdf`);
  const built = await buildPdfForJobDay(jobId, date, dayDir, outPdf);

  const subject = `Baustellenprotokoll #${jobId} – ${date}`;
  const body = `PDF per WhatsApp-Befehl erstellt.\nBaustelle: #${jobId}\nDatum: ${date}\nSeiten: ${built.pages}\n`;

  const sent = await sendMailWithAttachment({ to, subject, text: body, filePath: outPdf });
  return { outPdf, built, mailed: !!sent, messageId: sent?.messageId || null };
}

// ===================== Routes =====================
app.get("/", (req, res) => res.type("text").send("webhook läuft ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === VERIFY_TOKEN) return res.status(200).send(String(challenge));
  return res.sendStatus(403);
});

// Incoming WhatsApp
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

      const dayDir = path.join(DATA_DIR, siteCode, date);
      ensureDirSync(dayDir);

      const logPath = path.join(dayDir, "log.jsonl");

      // ---- Save base entry ----
      await appendJsonl(logPath, {
        at: new Date(Number(tsSec || 0) * 1000 || Date.now()).toISOString(),
        from: sender,
        type: msg.type,
        text: textOrCaption || "",
        raw: msg,
      });

      // ---- Media handling ----
      if (msg.type === "image" && msg.image?.id) {
        const mediaId = msg.image.id;
        const { buf, mime } = await downloadWhatsAppMedia(mediaId);
        const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}.jpg`;
        await fsp.writeFile(path.join(dayDir, filename), buf);
        console.log(`✅ saved image for #${siteCode} -> ${filename}`);
      }

      if (msg.type === "document" && msg.document?.id) {
        const mediaId = msg.document.id;
        const { buf, mime } = await downloadWhatsAppMedia(mediaId);

        const isPdf = String(mime).toLowerCase().includes("pdf");
        const ext = isPdf ? ".pdf" : ".bin";
        const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}${ext}`;
        await fsp.writeFile(path.join(dayDir, filename), buf);

        if (isPdf) {
          // Add an additional log record for PDF embedding
          await appendJsonl(logPath, {
            at: new Date(Number(tsSec || 0) * 1000 || Date.now()).toISOString(),
            from: sender,
            type: "pdf",
            file: filename,
            raw: msg,
          });
        }
        console.log(`✅ saved document for #${siteCode} -> ${filename}`);
      }

      if (msg.type === "audio" && msg.audio?.id) {
        const mediaId = msg.audio.id;
        const { buf, mime } = await downloadWhatsAppMedia(mediaId);
        const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}.ogg`;
        await fsp.writeFile(path.join(dayDir, filename), buf);
        console.log(`✅ saved audio for #${siteCode} -> ${filename}`);

        // Transcribe
        if (OPENAI_API_KEY) {
          try {
            const transcript = await transcribeAudio({ audioBuffer: buf, filename });
            await appendJsonl(logPath, {
              at: new Date(Number(tsSec || 0) * 1000 || Date.now()).toISOString(),
              from: sender,
              type: "audio_transcript",
              transcript,
              file: filename,
              raw: msg,
            });
            console.log(`✅ transcribed audio for #${siteCode}`);
          } catch (e) {
            console.error("❌ transcription failed:", e?.message || e);
          }
        }
      }

      // ---- Trigger PDF ----
      if (msg.type === "text" && isPdfCommand(textOrCaption)) {
        if (!isAllowedPdfSender(sender)) {
          console.log(`⛔ pdf command blocked (sender ${sender} not allowed)`);
          continue;
        }

        let jobId = parseSiteCodeFromText(textOrCaption) || siteCode;
        if (!jobId || jobId === "unknown") {
          console.log("⚠️ pdf command: jobId unknown (schreibe '#260016 pdf')");
          continue;
        }
        if (PDF_IGNORE_UNKNOWN && (jobId === "unknown" || jobId === "_unassigned")) continue;

        const to = MAIL_TO_DEFAULT;
        if (!to) {
          console.log("⚠️ pdf command: MAIL_TO_DEFAULT missing");
          continue;
        }

        try {
          const result = await triggerPdfForJobDay({ jobId, date, to });
          console.log(`📨 pdf command: sent #${jobId} ${date} -> ${to} (${result.built.pages} pages)`);
        } catch (e) {
          console.error("❌ pdf command failed:", e?.message || e);
        }
      }
    }
  } catch (e) {
    console.error("❌ webhook error:", e?.message || e);
  }
});

// Admin: test mail
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

// Admin: manual run daily
app.get("/admin/run-daily", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const date = req.query.date || todayISO();
    const to = req.query.to || MAIL_TO_DEFAULT;
    if (!to) return res.status(400).send("MAIL_TO_DEFAULT missing (or pass ?to=...)");

    const jobIds = await fsp.readdir(DATA_DIR).catch(() => []);
    const results = [];

    for (const jobId of jobIds) {
      if (PDF_IGNORE_UNKNOWN && (jobId === "unknown" || jobId === "_unassigned")) continue;

      const dayDir = path.join(DATA_DIR, jobId, date);
      if (!fs.existsSync(dayDir)) continue;

      const outPdf = path.join(dayDir, `Baustellenprotokoll_${jobId}_${date}.pdf`);
      const built = await buildPdfForJobDay(jobId, date, dayDir, outPdf);

      const subject = `Baustellenprotokoll #${jobId} – ${date}`;
      const text = `Im Anhang: Baustellenprotokoll #${jobId} (${date}).\nSeiten: ${built.pages}\n`;

      const sent = await sendMailWithAttachment({ to, subject, text, filePath: outPdf });
      results.push({ jobId, date, pdf: outPdf, pages: built.pages, mailed: !!sent });

      console.log(`📧 sent ${jobId} ${date} -> ${to} (${built.pages} pages)`);
    }

    res.json({ ok: true, date, to, count: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.use((req, res) => res.status(404).send(`Not found: ${req.method} ${req.path}`));

console.log("Starting…");
console.log("DATA_DIR=", DATA_DIR);
console.log("MAIL_FROM=", MAIL_FROM);
console.log("MAIL_TO_DEFAULT=", MAIL_TO_DEFAULT);
console.log("OPENAI_API_KEY set:", !!OPENAI_API_KEY);
app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));
