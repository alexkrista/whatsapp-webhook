import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; // required for sending replies
const DATA_DIR = process.env.DATA_DIR || "/var/data";

const STATE_DIR = path.join(DATA_DIR, "_state");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const UNKNOWN_REPLY_TEXT = "Bitte Baustellennummer mit # davor senden";
const UNKNOWN_REPLY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ---------- Helpers ----------
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function tsUnix() {
  return Math.floor(Date.now() / 1000);
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function safeJsonParse(txt, fallback) {
  try {
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function loadState() {
  await ensureDir(STATE_DIR);
  try {
    const txt = await fs.promises.readFile(STATE_FILE, "utf8");
    const parsed = safeJsonParse(txt, {});

    // robust defaults
    const state = {
      lastCodeBySender: parsed.lastCodeBySender && typeof parsed.lastCodeBySender === "object" ? parsed.lastCodeBySender : {},
      lastUnknownReplyAtBySender:
        parsed.lastUnknownReplyAtBySender && typeof parsed.lastUnknownReplyAtBySender === "object"
          ? parsed.lastUnknownReplyAtBySender
          : {},
    };
    return state;
  } catch {
    return { lastCodeBySender: {}, lastUnknownReplyAtBySender: {} };
  }
}

async function saveState(state) {
  await ensureDir(STATE_DIR);
  const tmp = STATE_FILE + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.promises.rename(tmp, STATE_FILE);
}

function extractCodeFromText(text) {
  if (!text) return null;
  // matches: #260016 or # 260016
  const m = text.match(/#\s*([0-9]{3,20})/);
  return m ? m[1] : null;
}

function getExtFromMime(mime) {
  if (!mime) return "";
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "application/pdf": ".pdf",
  };
  return map[mime] || "";
}

function randomId(n = 8) {
  return crypto.randomBytes(n).toString("hex");
}

async function appendJsonl(filePath, obj) {
  await ensureDir(path.dirname(filePath));
  await fs.promises.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8");
}

async function downloadWhatsAppMedia(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN missing");

  // 1) get media URL
  const metaUrl = `https://graph.facebook.com/v22.0/${mediaId}`;
  const r1 = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!r1.ok) {
    const t = await r1.text();
    throw new Error(`Media meta fetch failed: ${r1.status} ${t}`);
  }
  const meta = await r1.json();
  const url = meta.url;
  const mime = meta.mime_type || meta.mimeType || "";

  // 2) download file bytes
  const r2 = await fetch(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!r2.ok) {
    const t = await r2.text();
    throw new Error(`Media download failed: ${r2.status} ${t}`);
  }
  const buf = Buffer.from(await r2.arrayBuffer());
  return { buf, mime };
}

async function sendWhatsAppText(toWaId, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return;

  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "text",
    text: { body: text },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    console.error("WhatsApp send failed:", r.status, t);
  }
}

// ---------- Express Middleware ----------
app.use(express.json({ limit: "25mb" }));
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.status(200).send("webhook läuft");
});

// WhatsApp verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// WhatsApp incoming
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;

    // ACK fast
    res.sendStatus(200);

    const state = await loadState();

    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    for (const msg of messages) {
      const from = msg.from; // wa_id
      const type = msg.type;

      // ensure objects exist
      state.lastCodeBySender = state.lastCodeBySender || {};
      state.lastUnknownReplyAtBySender = state.lastUnknownReplyAtBySender || {};

      // If text contains code, remember it
      if (type === "text") {
        const body = msg?.text?.body || "";
        const code = extractCodeFromText(body);
        if (code) {
          state.lastCodeBySender[from] = code;
          await saveState(state);

          // also log text under that code
          const codeDir = path.join(DATA_DIR, code, todayISO());
          const logFile = path.join(codeDir, "log.jsonl");
          await appendJsonl(logFile, {
            kind: "text",
            from,
            at: new Date().toISOString(),
            whatsapp_timestamp: msg.timestamp,
            text: body,
            code,
          });

          console.log(`✅ saved text for #${code} -> ${logFile}`);
          continue;
        }
      }

      // Determine active code (last known)
      const activeCode = state.lastCodeBySender[from] || "unknown";
      const baseDir = path.join(DATA_DIR, activeCode, todayISO());
      const logFile = path.join(baseDir, "log.jsonl");

      if (type === "text") {
        const body = msg?.text?.body || "";
        await appendJsonl(logFile, {
          kind: "text",
          from,
          at: new Date().toISOString(),
          whatsapp_timestamp: msg.timestamp,
          text: body,
          code: activeCode,
        });
        console.log(`✅ saved text for #${activeCode} -> ${logFile}`);
      } else {
        // media types: image, video, audio, document, sticker...
        const mediaObj = msg[type] || {};
        const mediaId = mediaObj.id;
        const caption = mediaObj.caption || "";
        let filename = mediaObj.filename || "";

        if (!mediaId) {
          // still log something
          await appendJsonl(logFile, {
            kind: "media",
            from,
            at: new Date().toISOString(),
            whatsapp_timestamp: msg.timestamp,
            media_type: type,
            note: "no media id found",
            code: activeCode,
          });
          console.log(`⚠️ media without id for #${activeCode}`);
        } else {
          const { buf, mime } = await downloadWhatsAppMedia(mediaId);
          const ext = path.extname(filename) || getExtFromMime(mime) || "";
          const finalName = `${tsUnix()}_${randomId(6)}${ext || ""}`;
          const filePath = path.join(baseDir, finalName);

          await ensureDir(baseDir);
          await fs.promises.writeFile(filePath, buf);

          await appendJsonl(logFile, {
            kind: "media",
            from,
            at: new Date().toISOString(),
            whatsapp_timestamp: msg.timestamp,
            media_type: type,
            mime,
            file: finalName,
            caption,
            code: activeCode,
          });

          console.log(`✅ saved ${type} for #${activeCode} -> ${filePath}`);
        }
      }

      // If unknown: reply with cooldown
      if (activeCode === "unknown") {
        const last = state.lastUnknownReplyAtBySender[from] || 0;
        const now = Date.now();
        if (now - last >= UNKNOWN_REPLY_COOLDOWN_MS) {
          await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT);
          state.lastUnknownReplyAtBySender[from] = now;
          await saveState(state);
          console.log(`↩️ replied to ${from} (unknown) with cooldown`);
        } else {
          console.log(`⏳ cooldown active for ${from} (unknown)`);
        }
      } else {
        // keep state updated (optional)
        await saveState(state);
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
    // response already sent
  }
});

// Optional manual upload endpoint (falls du willst)
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const code = req.body.code || "unknown";
    const file = req.file;
    if (!file) return res.status(400).send("missing file");

    const dir = path.join(DATA_DIR, code, todayISO());
    await ensureDir(dir);
    const ext = path.extname(file.originalname) || "";
    const name = `${tsUnix()}_${randomId(6)}${ext}`;
    const filePath = path.join(dir, name);
    await fs.promises.writeFile(filePath, file.buffer);

    res.json({ ok: true, savedAs: filePath });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- Start ----------
(async () => {
  await ensureDir(DATA_DIR);
  await ensureDir(STATE_DIR);
  const state = await loadState();

  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`PHONE_NUMBER_ID set: ${Boolean(PHONE_NUMBER_ID)}`);

  // ensure defaults
  state.lastCodeBySender = state.lastCodeBySender || {};
  state.lastUnknownReplyAtBySender = state.lastUnknownReplyAtBySender || {};
  await saveState(state);

  app.listen(PORT, () => {
    console.log("==> Your service is live 🚀");
  });
})();
