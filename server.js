const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const DATA_ROOT = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Debug beim Start
console.log("DATA_DIR env:", process.env.DATA_DIR);
console.log("DATA_ROOT used:", DATA_ROOT);
console.log("VERIFY_TOKEN set:", Boolean(VERIFY_TOKEN));
console.log("WHATSAPP_TOKEN set:", Boolean(WHATSAPP_TOKEN));

// ===== Option B: letzte Baustelle pro Absender merken =====
const LAST_SITE_BY_SENDER = {}; // { wa_id: { siteCode, ts } }
const SITE_TTL_MS = 4 * 60 * 60 * 1000; // 4 Stunden

function rememberSite(sender, siteCode) {
  LAST_SITE_BY_SENDER[sender] = { siteCode, ts: Date.now() };
}

function recallSite(sender) {
  const rec = LAST_SITE_BY_SENDER[sender];
  if (!rec) return null;
  if (Date.now() - rec.ts > SITE_TTL_MS) return null;
  return rec.siteCode;
}

// ===== Helpers =====
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toISODate(tsSeconds) {
  const d = new Date(Number(tsSeconds) * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function extractSiteCode(text) {
  // Baustellennummern wie #260016
  const m = (text || "").match(/#(\d{6})\b/);
  return m ? m[1] : null;
}

function appendJsonLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

async function fetchMediaInfo(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN fehlt (Render Environment)");
  const url = `https://graph.facebook.com/v19.0/${mediaId}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 20000,
  });
  return resp.data; // { url, mime_type, sha256, file_size, ... }
}

async function downloadMediaToFile(mediaUrl, targetPath) {
  const resp = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });
  fs.writeFileSync(targetPath, resp.data);
}

// ===== Meta Webhook Verify (GET /webhook) =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!VERIFY_TOKEN) {
    console.error("❌ VERIFY_TOKEN fehlt (Render Environment)");
    return res.sendStatus(500);
  }

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== Receive WhatsApp events (POST /webhook) =====
app.post("/webhook", async (req, res) => {
  // Wichtig: sofort antworten
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const sender = msg.from; // wa_id
    const ts = msg.timestamp; // seconds
    const date = toISODate(ts);

    // Text nur bei type=text (bei image/audio kann es caption geben, aber nicht immer)
    const text =
      msg.type === "text"
        ? (msg.text?.body || "")
        : (msg.image?.caption || msg.video?.caption || "");

    // Baustelle bestimmen:
    // 1) Code im Text -> merken
    // 2) sonst letzte Baustelle vom Absender (4h)
    let siteCode = extractSiteCode(text);
    if (siteCode) {
      rememberSite(sender, siteCode);
    } else {
      siteCode = recallSite(sender) || "unknown";
    }

    // Ordner: /var/data/<site>/<YYYY-MM-DD>/
    const dayDir = path.join(DATA_ROOT, siteCode, date);
    ensureDir(dayDir);

    const logPath = path.join(dayDir, "log.jsonl");

    // Grundrecord
    const record = {
      received_at: new Date().toISOString(),
      site_code: siteCode,
      from: sender,
      message_id: msg.id,
      timestamp: ts,
      type: msg.type,
      text: text || "",
    };

    // TEXT
    if (msg.type === "text") {
      appendJsonLine(logPath, record);
      console.log(`✅ saved text for #${siteCode} -> ${logPath}`);
      return;
    }

    // IMAGE
    if (msg.type === "image" && msg.image?.id) {
      const mediaId = msg.image.id;
      const info = await fetchMediaInfo(mediaId);

      const ext = (info.mime_type || "").includes("png") ? "png" : "jpg";
      const fileName = `${ts}_${mediaId}.${ext}`;
      const filePath = path.join(dayDir, fileName);

      await downloadMediaToFile(info.url, filePath);

      record.media = {
        id: mediaId,
        mime_type: info.mime_type,
        file_name: fileName,
        file_path: filePath,
      };

      appendJsonLine(logPath, record);
      console.log(`✅ saved image for #${siteCode} -> ${filePath}`);
      return;
    }

    // AUDIO / VOICE
    // WhatsApp sendet oft msg.type === "audio" (voice notes sind auch audio)
    if ((msg.type === "audio" || msg.type === "voice") && msg.audio?.id) {
      const mediaId = msg.audio.id;
      const info = await fetchMediaInfo(mediaId);

      // meist audio/ogg (opus)
      const ext = (info.mime_type || "").includes("mpeg") ? "mp3" : "ogg";
      const fileName = `${ts}_${mediaId}.${ext}`;
      const filePath = path.join(dayDir, fileName);

      await downloadMediaToFile(info.url, filePath);

      record.media = {
        id: mediaId,
        mime_type: info.mime_type,
        file_name: fileName,
        file_path: filePath,
      };

      appendJsonLine(logPath, record);
      console.log(`✅ saved audio for #${siteCode} -> ${filePath}`);
      return;
    }

    // Alles andere (optional später: video, document, sticker, etc.)
    appendJsonLine(logPath, { ...record, note: "unhandled_type_or_missing_media" });
    console.log(`ℹ️ saved unhandled for #${siteCode} -> ${logPath}`);
  } catch (err) {
    console.error("❌ webhook handler error:", err?.response?.data || err);
  }
});

// Health
app.get("/", (req, res) => res.send("webhook läuft"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
