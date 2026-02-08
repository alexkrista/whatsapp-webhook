const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

// ================= ENV =================
const DATA_ROOT = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// ================= DEBUG =================
console.log("DATA_ROOT:", DATA_ROOT);
console.log("VERIFY_TOKEN set:", !!VERIFY_TOKEN);
console.log("WHATSAPP_TOKEN set:", !!WHATSAPP_TOKEN);

// ================= OPTION B =================
const LAST_SITE_BY_SENDER = {};
const SITE_TTL_MS = 4 * 60 * 60 * 1000;

function rememberSite(sender, siteCode) {
  LAST_SITE_BY_SENDER[sender] = { siteCode, ts: Date.now() };
}

function recallSite(sender) {
  const r = LAST_SITE_BY_SENDER[sender];
  if (!r) return null;
  if (Date.now() - r.ts > SITE_TTL_MS) return null;
  return r.siteCode;
}

// ================= HELPERS =================
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toISODate(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

function extractSiteCode(text) {
  const m = (text || "").match(/#(\d{6})\b/);
  return m ? m[1] : null;
}

function appendJsonLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

async function fetchMedia(mediaId) {
  const meta = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  const bin = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
  });
  return { info: meta.data, data: bin.data };
}

// ================= WEBHOOK VERIFY =================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ================= RECEIVE WHATSAPP =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const sender = msg.from;
    const ts = msg.timestamp;
    const date = toISODate(ts);

    const text =
      msg.type === "text"
        ? msg.text?.body || ""
        : msg.image?.caption || msg.video?.caption || "";

    let siteCode = extractSiteCode(text);
    if (siteCode) rememberSite(sender, siteCode);
    else siteCode = recallSite(sender) || "unknown";

    const dayDir = path.join(DATA_ROOT, siteCode, date);
    ensureDir(dayDir);

    const logFile = path.join(dayDir, "log.jsonl");

    const record = {
      time: new Date(Number(ts) * 1000).toISOString(),
      type: msg.type,
      text,
    };

    // TEXT
    if (msg.type === "text") {
      appendJsonLine(logFile, record);
      console.log(`✅ saved text for #${siteCode}`);
      return;
    }

    // IMAGE
    if (msg.type === "image") {
      const { info, data } = await fetchMedia(msg.image.id);
      const file = `${ts}_${msg.image.id}.jpg`;
      fs.writeFileSync(path.join(dayDir, file), data);
      record.file = file;
      appendJsonLine(logFile, record);
      console.log(`✅ saved image for #${siteCode}`);
      return;
    }

    // AUDIO
    if (msg.type === "audio" || msg.type === "voice") {
      const { info, data } = await fetchMedia(msg.audio.id);
      const file = `${ts}_${msg.audio.id}.ogg`;
      fs.writeFileSync(path.join(dayDir, file), data);
      record.file = file;
      appendJsonLine(logFile, record);
      console.log(`✅ saved audio for #${siteCode}`);
      return;
    }
  } catch (e) {
    console.error("❌ webhook error:", e);
  }
});

// ================= PDF + MAIL JOB =================
app.post("/jobs/daily", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const sites = fs.readdirSync(DATA_ROOT);

    for (const site of sites) {
      const dayDir = path.join(DATA_ROOT, site, date);
      if (!fs.existsSync(dayDir)) continue;

      const pdfPath = path.join(dayDir, `Tagesprotokoll_${site}_${date}.pdf`);
      const doc = new PDFDocument({ size: "A3", layout: "landscape", margin: 30 });
      doc.pipe(fs.createWriteStream(pdfPath));

      doc.fontSize(20).text(`Tagesprotokoll Baustelle #${site}`);
      doc.fontSize(12).text(`Datum: ${date}`);
      doc.moveDown();

      const logs = readJsonLines(path.join(dayDir, "log.jsonl"));
      doc.fontSize(12).text("Notizen:");
      logs.filter(l => l.type === "text").forEach(l => {
        doc.fontSize(10).text(`- ${l.text}`);
      });

      const images = fs.readdirSync(dayDir).filter(f => f.endsWith(".jpg"));
      if (images.length) doc.addPage();

      let x = 40, y = 80, i = 0;
      for (const img of images) {
        doc.image(path.join(dayDir, img), x, y, { fit: [250, 180] });
        doc.fontSize(8).text(img, x, y + 185);
        x += 270;
        i++;
        if (i % 3 === 0) { x = 40; y += 220; }
        if (i % 6 === 0) { doc.addPage(); x = 40; y = 80; }
      }

      doc.end();

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: process.env.MAIL_TO,
        subject: `Tagesprotokoll Baustelle #${site} – ${date}`,
        text: "Automatisch erstellt um 22:00",
        attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
      });

      console.log(`📧 Mail sent for #${site}`);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ job error:", e);
    res.status(500).json({ ok: false });
  }
});

// ================= HEALTH =================
app.get("/", (_, res) => res.send("webhook läuft"));
app.listen(3000, () => console.log("Server läuft auf Port 3000"));
