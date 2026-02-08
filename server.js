import express from "express";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import multer from "multer";
import dayjs from "dayjs";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ENV
const DATA_DIR = process.env.DATA_DIR || "./data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Uploads
const upload = multer({ dest: "uploads/" });

// Root check
app.get("/", (req, res) => {
  res.send("Webhook läuft ✅");
});

// WhatsApp Verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// WhatsApp Incoming
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from || "unknown";
    const date = dayjs().format("YYYY-MM-DD");
    const dir = path.join(DATA_DIR, from, date);

    fs.mkdirSync(dir, { recursive: true });

    // TEXT
    if (msg.type === "text") {
      const file = path.join(dir, "log.jsonl");
      fs.appendFileSync(file, JSON.stringify(msg) + "\n");
      console.log(`✅ saved text for #${from} -> ${file}`);
    }

    // IMAGE
    if (msg.type === "image") {
      const mediaId = msg.image.id;
      const urlRes = await fetch(
        `https://graph.facebook.com/v19.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      );
      const media = await urlRes.json();

      const imgRes = await fetch(media.url, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      });

      const buffer = await imgRes.arrayBuffer();
      const filename = `${msg.timestamp}_${mediaId}.jpg`;

      const imgPath = path.join(dir, filename);
      fs.writeFileSync(imgPath, Buffer.from(buffer));

      console.log(`✅ saved image for #${from} -> ${imgPath}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
