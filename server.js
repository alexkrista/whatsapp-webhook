const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

const DATA_ROOT = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_TOKEN = process.env.META_TOKEN;

// ---------------- HELPERS ----------------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toISODate(tsSeconds) {
  const d = new Date(Number(tsSeconds) * 1000);
  return d.toISOString().substring(0, 10);
}

function extractSiteCode(text) {
  const m = (text || "").match(/#(\d{6})\b/);
  return m ? m[1] : null;
}

async function downloadMedia(mediaId, targetPath) {
  const meta = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${META_TOKEN}` } }
  );
  const file = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${META_TOKEN}` },
    responseType: "arraybuffer",
  });
  fs.writeFileSync(targetPath, file.data);
}

// ---------------- WEBHOOK VERIFY ----------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------------- RECEIVE MESSAGES ----------------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const ts = msg.timestamp;
    const date = toISODate(ts);
    const text = msg.text?.body || "";
    const siteCode = extractSiteCode(text) || "unknown";

    const baseDir = path.join(DATA_ROOT, siteCode, date);
    ensureDir(baseDir);

    const record = {
      time: new Date(Number(ts) * 1000).toISOString(),
      type: msg.type,
      text,
    };

    // TEXT
    if (msg.type === "text") {
      fs.appendFileSync(
        path.join(baseDir, "log.jsonl"),
        JSON.stringify(record) + "\n"
      );
    }

    // IMAGE
    if (msg.type === "image") {
      const fileName = `${ts}_${msg.image.id}.jpg`;
      const target = path.join(baseDir, fileName);
      await downloadMedia(msg.image.id, target);
      record.file = fileName;
      fs.appendFileSync(
        path.join(baseDir, "log.jsonl"),
        JSON.stringify(record) + "\n"
      );
    }

    // AUDIO / VOICE
    if (msg.type === "audio" || msg.type === "voice") {
      const fileName = `${ts}_${msg.audio.id}.ogg`;
      const target = path.join(baseDir, fileName);
      await downloadMedia(msg.audio.id, target);
      record.file = fileName;
      fs.appendFileSync(
        path.join(baseDir, "log.jsonl"),
        JSON.stringify(record) + "\n"
      );
    }

    console.log(`✅ gespeichert ${siteCode} ${date}`);
  } catch (e) {
    console.error(e);
  }
});

// ---------------- PDF + MAIL JOB ----------------
app.post("/jobs/daily", async (req, res) => {
  const today = new Date();
  today.setDate(today.getDate() - 1);
  const date = today.toISOString().substring(0, 10);

  const sites = fs.readdirSync(DATA_ROOT);

  for (const site of sites) {
    const dayDir = path.join(DATA_ROOT, site, date);
    if (!fs.existsSync(dayDir)) continue;

    const pdfPath = path.join(dayDir, `Tagesprotokoll_${site}_${date}.pdf`);
    const doc = new PDFDocument({ size: "A3", layout: "landscape" });
    doc.pipe(fs.createWriteStream(pdfPath));

    doc.fontSize(18).text(`Baustelle ${site} – ${date}`);
    doc.moveDown();

    const images = fs.readdirSync(dayDir).filter(f => f.endsWith(".jpg"));
    let x = 40, y = 120, c = 0;

    for (const img of images) {
      doc.image(path.join(dayDir, img), x, y, { width: 250 });
      doc.fontSize(8).text(img, x, y + 260);
      x += 270;
      c++;
      if (c % 3 === 0) { x = 40; y += 300; }
      if (c % 6 === 0) doc.addPage();
    }

    doc.end();

    // MAIL
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject: `Tagesprotokoll Baustelle ${site} – ${date}`,
      text: "Automatisch erstellt.",
      attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
    });
  }

  res.json({ status: "ok" });
});

// HEALTH
app.get("/", (_, res) => res.send("webhook läuft"));
app.listen(3000);
