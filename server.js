import express from "express";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import multer from "multer";
import dayjs from "dayjs";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "25mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================
// ENV
// =====================
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";

// Mail
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const MAIL_TO = process.env.MAIL_TO || ""; // z.B. "office@krista.at"
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // für manuellen Trigger

// =====================
// Helpers
// =====================
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function listJobDirs() {
  if (!fs.existsSync(DATA_DIR)) return [];
  // DATA_DIR/<job>/<date>/
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  return lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function extractJobCodeFromText(text) {
  // erwartet #260016 (6-stellig) – du kannst auch mehr Stellen erlauben
  const m = (text || "").match(/#(\d{4,12})/);
  return m ? m[1] : null;
}

function todayYMD() {
  return dayjs().format("YYYY-MM-DD");
}

function ymdFromUnix(ts) {
  // WhatsApp liefert "timestamp" als String Sekunden
  const n = Number(ts || 0);
  if (!n) return todayYMD();
  return dayjs(n * 1000).format("YYYY-MM-DD");
}

// =====================
// Uploads
// =====================
const upload = multer({ dest: "uploads/" });

// =====================
// Basic endpoints
// =====================
app.get("/", (req, res) => res.send("Webhook läuft ✅"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified ✅");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =====================
// Incoming WhatsApp messages
// =====================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    // Text
    let jobCode = null;
    if (msg.type === "text") {
      jobCode = extractJobCodeFromText(msg.text?.body);
    }

    // Wenn kein Jobcode im Text: als unknown
    const job = jobCode || "unknown";
    const date = ymdFromUnix(msg.timestamp);
    const dir = path.join(DATA_DIR, job, date);
    ensureDir(dir);

    // TEXT speichern (log.jsonl)
    if (msg.type === "text") {
      const file = path.join(dir, "log.jsonl");
      fs.appendFileSync(file, JSON.stringify(msg) + "\n");
      console.log(`✅ saved text for #${job} -> ${file}`);
    }

    // IMAGE speichern
    if (msg.type === "image") {
      const mediaId = msg.image?.id;
      if (!mediaId) return res.sendStatus(200);

      const urlRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      });
      const media = await urlRes.json();
      if (!media?.url) throw new Error("No media URL from Meta");

      const imgRes = await fetch(media.url, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      });

      const buffer = await imgRes.arrayBuffer();
      const filename = `${msg.timestamp}_${mediaId}.jpg`;
      const imgPath = path.join(dir, filename);
      fs.writeFileSync(imgPath, Buffer.from(buffer));

      // zusätzlich auch den Raw-Webhook ins log schreiben
      const file = path.join(dir, "log.jsonl");
      fs.appendFileSync(file, JSON.stringify(msg) + "\n");

      console.log(`✅ saved image for #${job} -> ${imgPath}`);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(500);
  }
});

// =====================
// PDF generation
// =====================
function drawHeader(doc, job, dateStr) {
  doc.fontSize(20).text("WhatsApp Fotoprotokoll", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Baustelle: #${job}`);
  doc.text(`Datum: ${dateStr}`);
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(1);
}

function addImagesGrid(doc, images, startIndex) {
  // A3 quer: wir nutzen landscape layout beim Erstellen
  // 6 Bilder pro Seite: 3x2
  const margin = doc.page.margins.left;
  const usableW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const usableH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

  const cols = 3;
  const rows = 2;
  const gap = 10;

  const cellW = (usableW - gap * (cols - 1)) / cols;
  const cellH = (usableH - gap * (rows - 1)) / rows;

  let idx = startIndex;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (idx >= images.length) return idx;

      const x = doc.page.margins.left + c * (cellW + gap);
      const y = doc.page.margins.top + r * (cellH + gap);

      const imgPath = images[idx].path;
      const label = images[idx].name;

      // Bild oben, Dateiname darunter
      const labelH = 18;
      const imgBoxH = cellH - labelH;

      try {
        doc.image(imgPath, x, y, {
          fit: [cellW, imgBoxH],
          align: "center",
          valign: "center"
        });
      } catch (e) {
        doc.rect(x, y, cellW, imgBoxH).stroke();
        doc.fontSize(10).text("Bild konnte nicht geladen werden", x + 5, y + 5, { width: cellW - 10 });
      }

      doc.fontSize(9).text(label, x, y + imgBoxH + 2, { width: cellW, align: "center" });

      idx++;
    }
  }
  return idx;
}

function addTextTimeline(doc, messages) {
  doc.fontSize(12).text("Text / Notizen (chronologisch)", { underline: true });
  doc.moveDown(0.5);

  messages.forEach(m => {
    const time = dayjs(Number(m.timestamp) * 1000).format("HH:mm");
    const body = m.text?.body || "";
    doc.fontSize(10).text(`${time}  ${body}`);
  });

  doc.moveDown(1);
}

function buildDailyPdf(job, dateStr) {
  const dir = path.join(DATA_DIR, job, dateStr);
  const logPath = path.join(dir, "log.jsonl");
  const outPath = path.join(dir, `Fotoprotokoll_${job}_${dateStr}.pdf`);

  const msgs = readJsonl(logPath);

  const textMsgs = msgs.filter(m => m.type === "text");
  const imageMsgs = msgs.filter(m => m.type === "image");

  // Bilder: suche im Ordner nach jpg/png, sortiert nach filename (=timestamp vorne)
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const images = files
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .sort()
    .map(f => ({ name: f, path: path.join(dir, f) }));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A3",
      layout: "landscape",
      margin: 36,
      compress: true
    });

    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // Deckblatt
    drawHeader(doc, job, dateStr);
    doc.fontSize(11).text("Inhalt:", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).text("- Text und Fotos in zeitlicher Abfolge");
    doc.text("- 6 Fotos pro Seite (3×2), proportional (nicht verzerren)");
    doc.text("- Unter jedem Foto: originaler Dateiname");
    doc.text("- PDF komprimiert (kleiner Speicher)");
    doc.moveDown(1);

    if (textMsgs.length) addTextTimeline(doc, textMsgs);

    // Fotos
    if (images.length) {
      doc.addPage();
      doc.fontSize(12).text("Fotos", { underline: true });
      doc.moveDown(0.5);

      // Grid-Seiten
      let i = 0;
      while (i < images.length) {
        // auf jeder Seite Grid ab Top (wir setzen y wieder auf top)
        // Wenn nicht erste Foto-Seite: neue Seite
        if (i !== 0) doc.addPage();
        i = addImagesGrid(doc, images, i);
      }
    }

    doc.end();

    stream.on("finish", () => resolve(outPath));
    stream.on("error", reject);
  });
}

// =====================
// Mail
// =====================
async function sendMailWithAttachment(subject, text, filePath) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_TO) {
    throw new Error("SMTP ENV missing: SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_TO");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    text,
    attachments: [
      {
        filename: path.basename(filePath),
        path: filePath
      }
    ]
  });
}

// =====================
// Daily run (manual trigger)
// =====================
app.get("/admin/run-daily", async (req, res) => {
  try {
    const key = req.query.key || "";
    const dateStr = req.query.date || todayYMD();

    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return res.status(403).send("Forbidden");
    }

    const jobs = listJobDirs().filter(j => j !== "unknown");
    const results = [];

    for (const job of jobs) {
      const jobDateDir = path.join(DATA_DIR, job, dateStr);
      const logPath = path.join(jobDateDir, "log.jsonl");
      if (!fs.existsSync(logPath)) continue; // nichts zu tun

      const pdfPath = await buildDailyPdf(job, dateStr);

      await sendMailWithAttachment(
        `Baustellenprotokoll #${job} – ${dateStr}`,
        `Anbei das WhatsApp Fotoprotokoll für Baustelle #${job} (${dateStr}).`,
        pdfPath
      );

      results.push({ job, pdf: pdfPath, mailed: true });
      console.log(`📧 mailed PDF for #${job} -> ${MAIL_TO}`);
    }

    res.json({ ok: true, date: dateStr, results });
  } catch (err) {
    console.error(err);
    res.status(500).send(String(err));
  }
});

// =====================
// Start
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
