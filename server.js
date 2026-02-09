// server.js (CommonJS) – WhatsApp Webhook + Media speichern + PDF (Textseite + Fotoseiten)
// Trigger: Wenn du in WhatsApp "pdf" schreibst, wird für die Baustelle ein PDF erstellt + per Mail gesendet.
// - Baustellencode: #260016 (nur Nummern nach #)
// - Option B: Wenn du einmal #260016 geschickt hast, werden folgende Fotos ohne # automatisch dieser Baustelle zugeordnet (4h TTL)
// - PDF: A3 quer, Deckblatt, Textseite(n) mit Zeitstempel, Fotoseiten (6 pro Seite) mit Zeitstempel + Dateiname
// - Mail: SMTP (bei dir SendGrid), Empfänger MAIL_TO_DEFAULT (oder per Admin Endpoint)
//
// Render ENV (mindestens):
// DATA_DIR=/var/data
// VERIFY_TOKEN=...
// WHATSAPP_TOKEN=...
// ADMIN_TOKEN=... (für /admin/*)
// SMTP_HOST=smtp.sendgrid.net
// SMTP_PORT=587
// SMTP_USER=apikey
// SMTP_PASS=<SENDGRID_API_KEY>
// MAIL_FROM=<verifizierter Sender bei SendGrid>
// MAIL_TO_DEFAULT=alex@krista.at
// Optional:
// PDF_ALLOWED_FROM=436643203577 (oder mehrere: "4366...,4366...") -> wer darf per WhatsApp "pdf" auslösen
// PDF_IGNORE_UNKNOWN=1 -> unknown/_unassigned nicht mailen im Daily-Run

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

// Admin protection
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// SMTP (SendGrid recommended)
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

const MAIL_FROM = process.env.MAIL_FROM || "";
const MAIL_TO_DEFAULT = process.env.MAIL_TO_DEFAULT || "";

const PDF_ALLOWED_FROM = process.env.PDF_ALLOWED_FROM || ""; // comma separated WhatsApp wa_id(s)
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
  if (!PDF_ALLOWED_FROM.trim()) return true; // if not set: allow everyone (not recommended)
  const allowed = PDF_ALLOWED_FROM.split(",").map(s => s.trim()).filter(Boolean);
  return allowed.includes(String(sender || "").trim());
}
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) return true; // if not set: unprotected (not recommended)
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
async function downloadWhatsAppMedia(mediaId, outPath) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN missing");

  const meta = await fetchJson(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!meta?.url) throw new Error("No media url from Graph");

  const buf = await fetchBuffer(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  await ensureDir(path.dirname(outPath));
  await fsp.writeFile(outPath, buf);
  return { bytes: buf.length, mime_type: meta.mime_type || "" };
}

// ===================== Mail (SMTP) =====================
function makeMailer() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false, // STARTTLS for 587
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
    return null; // never crash
  }
}

// ===================== PDF Build =====================
async function listImages(dayDir) {
  const files = await fsp.readdir(dayDir).catch(() => []);
  return files
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .sort()
    .map((f) => ({ name: f, path: path.join(dayDir, f) }));
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
  // A3 landscape points
  const PAGE_W = 1190.55;
  const PAGE_H = 841.89;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const logPath = path.join(dayDir, "log.jsonl");
  const logs = await readJsonLines(logPath);
  const images = await listImages(dayDir);

  // ---- Cover ----
  {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawText("Baustellenprotokoll", { x: 60, y: PAGE_H - 90, size: 38, font: fontBold });
    page.drawText(`#${jobId}`, { x: 60, y: PAGE_H - 140, size: 24, font: fontBold });
    page.drawText(`Datum: ${date}`, { x: 60, y: PAGE_H - 180, size: 16, font });
    page.drawText(`Text-Einträge: ${logs.length}`, { x: 60, y: PAGE_H - 210, size: 16, font });
    page.drawText(`Fotos: ${images.length}`, { x: 60, y: PAGE_H - 240, size: 16, font });

    page.drawText("Format: A3 quer | 6 Fotos pro Seite | Zeitstempel + Dateiname", {
      x: 60, y: 80, size: 12, font, color: rgb(0.3, 0.3, 0.3),
    });
  }

  // ---- Text page(s) ----
  const textItems = logs
    .map((l) => {
      const raw = l?.raw;
      const body = raw?.text?.body;
      if (!body) return null;
      const ts = raw?.timestamp;
      const stamp = ts ? stampDE(ts) : "";
      return `${stamp}  ${body}`.trim();
    })
    .filter(Boolean);

  if (textItems.length) {
    let page = pdf.addPage([PAGE_W, PAGE_H]);

    const drawHeader = (headline) => {
      page.drawText(headline, { x: 60, y: PAGE_H - 80, size: 20, font: fontBold });
      page.drawLine({
        start: { x: 60, y: PAGE_H - 92 },
        end: { x: PAGE_W - 60, y: PAGE_H - 92 },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
      });
      return PAGE_H - 130;
    };

    let y = drawHeader("Text / Notizen (chronologisch)");
    const left = 60;
    const maxWidth = PAGE_W - 120;
    const fontSize = 12;
    const lineH = 16;

    for (const line of textItems) {
      if (y < 90) {
        page = pdf.addPage([PAGE_W, PAGE_H]);
        y = drawHeader("Text / Notizen (Fortsetzung)");
      }
      page.drawText(line, { x: left, y, size: fontSize, font, maxWidth, color: rgb(0.1, 0.1, 0.1) });
      y -= lineH;
    }
  }

  // ---- Photos: 6 per page (3x2) ----
  if (images.length) {
    const cols = 3, rows = 2;
    const margin = 40;
    const gutter = 18;
    const cellW = (PAGE_W - margin * 2 - gutter * (cols - 1)) / cols;
    const cellH = (PAGE_H - margin * 2 - gutter * (rows - 1)) / rows;

    for (let i = 0; i < images.length; i += 6) {
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      const chunk = images.slice(i, i + 6);

      for (let j = 0; j < chunk.length; j++) {
        const col = j % cols;
        const row = Math.floor(j / cols);

        const x0 = margin + col * (cellW + gutter);
        const yTop = PAGE_H - margin - row * (cellH + gutter);

        const captionH = 28;
        const targetW = Math.floor(cellW);
        const targetH = Math.floor(cellH - captionH);

        const fname = chunk[j].name;
        const imgPath = chunk[j].path;

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

  const bytes = await pdf.save();
  await ensureDir(path.dirname(outPdfPath));
  await fsp.writeFile(outPdfPath, bytes);
  return { pages: pdf.getPageCount(), bytes: bytes.length };
}

// ===================== PDF Trigger from WhatsApp ("pdf") =====================
async function triggerPdfForJobDay({ jobId, date, to }) {
  const dayDir = path.join(DATA_DIR, jobId, date);
  if (!fs.existsSync(dayDir)) {
    throw new Error(`No data dir for #${jobId} at ${date}`);
  }

  const outPdf = path.join(dayDir, `Baustellenprotokoll_${jobId}_${date}.pdf`);
  const built = await buildPdfForJobDay(jobId, date, dayDir, outPdf);

  const subject = `Baustellenprotokoll #${jobId} – ${date}`;
  const body = `PDF per WhatsApp-Befehl erstellt.\nBaustelle: #${jobId}\nDatum: ${date}\nSeiten: ${built.pages}\n`;

  const sent = await sendMailWithAttachment({
    to,
    subject,
    text: body,
    filePath: outPdf,
  });

  return { outPdf, built, mailed: !!sent, messageId: sent?.messageId || null };
}

// ===================== Routes =====================
app.get("/", (req, res) => res.type("text").send("webhook läuft ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Webhook Verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(String(challenge));
  }
  return res.sendStatus(403);
});

// Incoming WhatsApp
app.post("/webhook", async (req, res) => {
  // Meta wants quick 200
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

      // Option B: remember / recall
      if (siteCode) rememberSite(sender, siteCode);
      else siteCode = recallSite(sender) || "unknown";

      const dayDir = path.join(DATA_DIR, siteCode, date);
      ensureDirSync(dayDir);

      const logPath = path.join(dayDir, "log.jsonl");

      await appendJsonl(logPath, {
        at: new Date(Number(tsSec || 0) * 1000 || Date.now()).toISOString(),
        from: sender,
        type: msg.type,
        text: textOrCaption || "",
        raw: msg,
      });

      // Media speichern
      if (msg.type === "image" && msg.image?.id) {
        const mediaId = msg.image.id;
        const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}.jpg`;
        const out = path.join(dayDir, filename);
        const info = await downloadWhatsAppMedia(mediaId, out);
        console.log(`✅ saved image for #${siteCode} -> ${out} (${info.bytes} bytes)`);
      } else if (msg.type === "document" && msg.document?.id) {
        const mediaId = msg.document.id;
        const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}.bin`;
        const out = path.join(dayDir, filename);
        const info = await downloadWhatsAppMedia(mediaId, out);
        console.log(`✅ saved document for #${siteCode} -> ${out} (${info.bytes} bytes)`);
      } else if (msg.type === "audio" && msg.audio?.id) {
        const mediaId = msg.audio.id;
        const filename = `${String(tsSec || Math.floor(Date.now() / 1000))}_${mediaId}.ogg`;
        const out = path.join(dayDir, filename);
        const info = await downloadWhatsAppMedia(mediaId, out);
        console.log(`✅ saved audio for #${siteCode} -> ${out} (${info.bytes} bytes)`);
      } else if (msg.type === "text") {
        console.log(`✅ saved text for #${siteCode} -> ${logPath}`);
      }

      // ✅ Trigger: WhatsApp Text enthält "pdf"
      if (msg.type === "text" && isPdfCommand(textOrCaption)) {
        if (!isAllowedPdfSender(sender)) {
          console.log(`⛔ pdf command blocked (sender ${sender} not allowed)`);
          continue;
        }

        // Baustelle bestimmen: bevorzugt #Code im Text, sonst gemerkte Baustelle
        let jobId = parseSiteCodeFromText(textOrCaption) || siteCode;

        if (!jobId || jobId === "unknown") {
          console.log("⚠️ pdf command: jobId unknown (schreibe z.B. '#260016 pdf')");
          continue;
        }

        // optional: unknown unterdrücken
        if (PDF_IGNORE_UNKNOWN && (jobId === "unknown" || jobId === "_unassigned")) {
          console.log("⚠️ pdf command ignored for unknown/_unassigned");
          continue;
        }

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

// ===================== Admin endpoints =====================
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
    console.error("❌ test-mail error:", e?.message || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Daily run (PDF + Mail) – GET /admin/run-daily?token=...&date=YYYY-MM-DD&to=...
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

      results.push({
        jobId,
        date,
        pdf: outPdf,
        pages: built.pages,
        bytes: built.bytes,
        mailed: !!sent,
        messageId: sent?.messageId || null,
      });

      console.log(`📧 sent ${jobId} ${date} -> ${to} (${built.pages} pages)`);
    }

    res.json({ ok: true, date, to, count: results.length, results });
  } catch (e) {
    console.error("❌ run-daily error:", e?.message || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 404 helper
app.use((req, res) => res.status(404).send(`Not found: ${req.method} ${req.path}`));

// ===================== Start =====================
console.log("Starting…");
console.log("DATA_DIR=", DATA_DIR);
console.log("MAIL_FROM=", MAIL_FROM);
console.log("MAIL_TO_DEFAULT=", MAIL_TO_DEFAULT);
console.log("ADMIN_TOKEN set:", !!ADMIN_TOKEN);
console.log("PDF_ALLOWED_FROM=", PDF_ALLOWED_FROM || "(not set => allow all)");

app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
