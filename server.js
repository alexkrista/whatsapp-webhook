import express from "express";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

const app = express();
app.use(express.json());

/* ===============================
   KONFIG
================================ */
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

/* ===============================
   SMTP (Brevo)
================================ */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/* ===============================
   HELFER
================================ */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function sendMail({ to, subject, text }) {
  try {
    await transporter.sendMail({
      from: `Baustellenprotokoll <${process.env.MAIL_FROM}>`,
      to,
      subject,
      text,
    });
    console.log("✅ Mail gesendet an", to);
  } catch (err) {
    console.error("❌ Mail-Fehler:", err.message);
    // ❗ NICHT crashen lassen → kein 502
  }
}

/* ===============================
   ROOT
================================ */
app.get("/", (req, res) => {
  res.send("Webhook läuft ✅");
});

/* ===============================
   META VERIFY (GET)
================================ */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verifiziert");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Webhook Verify fehlgeschlagen");
  res.sendStatus(403);
});

/* ===============================
   META EVENTS (POST)
================================ */
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 Incoming webhook:", JSON.stringify(req.body));

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from || "unknown";
    const text = message.text?.body || "";
    const timestamp = Number(message.timestamp) * 1000;
    const date = new Date(timestamp);

    const projectMatch = text.match(/#(\d+)/);
    const project = projectMatch ? projectMatch[1] : "unknown";

    const day = date.toISOString().slice(0, 10);
    const dir = path.join(DATA_DIR, project, day);
    ensureDir(dir);

    /* TEXT SPEICHERN */
    if (text) {
      const file = path.join(dir, "log.jsonl");
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: "text",
          from,
          text,
          at: date.toISOString(),
        }) + "\n"
      );

      console.log(`✅ saved text for #${project} -> ${file}`);

      // optional: Mail bei Text
      await sendMail({
        to: "alex@krista.at",
        subject: `Neuer WhatsApp Text #${project}`,
        text,
      });
    }

    /* MEDIEN */
    if (message.type === "image" && message.image?.id) {
      const mediaFile = path.join(dir, `${Date.now()}_${message.image.id}.jpg`);
      fs.writeFileSync(mediaFile, "");
      console.log(`✅ saved image for #${project} -> ${mediaFile}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Fehler:", err);
    res.sendStatus(200); // NIE 500 → Meta & Render happy
  }
});

/* ===============================
   START
================================ */
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});

