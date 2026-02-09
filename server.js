import express from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const app = express();

// --- Config ---
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID_ENV = process.env.PHONE_NUMBER_ID || ""; // optional
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

const STATE_DIR = path.join(DATA_DIR, "_state");
const STATE_FILE = path.join(STATE_DIR, "state.json");

// WhatsApp sometimes sends large payloads
app.use(express.json({ limit: "25mb" }));

// --- Helpers ---
function nowIso() {
  return new Date().toISOString();
}

function ymd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function loadState() {
  await ensureDir(STATE_DIR);
  if (!fs.existsSync(STATE_FILE)) {
    const init = {
      lastCodeBySender: {},        // { "4366...": "260016" }
      lastPromptAtBySender: {},    // { "4366...": 1700000000 }
      lastPhoneNumberId: "",       // last seen from webhook metadata
      seenMessageIds: {},          // { "wamid....": 1700000000 } for dedup
    };
    await fsp.writeFile(STATE_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
  const raw = await fsp.readFile(STATE_FILE, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    // if file got corrupted, start fresh
    const init = {
      lastCodeBySender: {},
      lastPromptAtBySender: {},
      lastPhoneNumberId: "",
      seenMessageIds: {},
    };
    await fsp.writeFile(STATE_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
}

async function saveState(state) {
  await ensureDir(STATE_DIR);
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function extractCodeFromText(text) {
  // Accept: "#260016" anywhere in message
  const m = String(text || "").match(/#(\d{3,})/);
  return m ? m[1] : null;
}

function mimeToExt(mime) {
  if (!mime) return "bin";
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("pdf")) return "pdf";
  return "bin";
}

async function appendJsonl(filePath, obj) {
  const line = JSON.stringify(obj) + "\n";
  await fsp.appendFile(filePath, line, "utf8");
}

async function sendWhatsAppText(toWaId, text, phoneNumberIdFromWebhook = "") {
  const phoneNumberId = PHONE_NUMBER_ID_ENV || phoneNumberIdFromWebhook;
  if (!WHATSAPP_TOKEN) {
    console.log("⚠️ WHATSAPP_TOKEN fehlt – kann keine Antwort senden.");
    return;
  }
  if (!phoneNumberId) {
    console.log("⚠️ PHONE_NUMBER_ID fehlt – kann keine Antwort senden.");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "text",
    text: { body: text },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.log(`⚠️ WhatsApp send failed (${res.status}): ${t}`);
  }
}

// Download media bytes from WhatsApp
async function fetchMediaBinary(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN missing");

  // 1) get media metadata incl. url + mime_type
  const metaUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}?fields=url,mime_type`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  if (!metaRes.ok) {
    const t = await metaRes.text().catch(() => "");
    throw new Error(`Meta fetch failed (${metaRes.status}): ${t}`);
  }

  const meta = await metaRes.json();
  const mediaUrl = meta?.url;
  const mime = meta?.mime_type || "";

  if (!mediaUrl) throw new Error("No media url in metadata");

  // 2) download bytes from url using token
  const binRes = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  if (!binRes.ok) {
    const t = await binRes.text().catch(() => "");
    throw new Error(`Binary fetch failed (${binRes.status}): ${t}`);
  }

  const arrayBuffer = await binRes.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);

  return { buf, meta, mime };
}

function unixToDate(ts) {
  // ts is string seconds
  const n = Number(ts);
  if (!Number.isFinite(n)) return new Date();
  return new Date(n * 1000);
}

// --- Routes ---
app.get("/", (req, res) => {
  res.status(200).send("webhook läuft");
});

// Meta webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && challenge) {
    if (token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified");
      return res.status(200).send(String(challenge));
    }
    console.log("❌ Webhook verify failed (token mismatch)");
    return res.sendStatus(403);
  }

  return res.status(200).send("ok");
});

// Main webhook receiver
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    console.log("Incoming webhook:", JSON.stringify(body));

    // quick ack to Meta
    res.sendStatus(200);

    const state = await loadState();

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const field = changes?.field;

    if (field !== "messages" || !value) return;

    const phoneNumberIdFromWebhook = value?.metadata?.phone_number_id || "";
    if (phoneNumberIdFromWebhook) {
      state.lastPhoneNumberId = phoneNumberIdFromWebhook;
    }

    const messages = value?.messages || [];
    const contacts = value?.contacts || [];
    const contactWaId = contacts?.[0]?.wa_id || "";

    // process each message
    for (const msg of messages) {
      const msgId = msg?.id;
      const from = msg?.from || contactWaId;
      const type = msg?.type;

      // Dedup protection (if Meta retries)
      if (msgId) {
        if (state.seenMessageIds[msgId]) {
          console.log("↩️ duplicate message ignored:", msgId);
          continue;
        }
        state.seenMessageIds[msgId] = Math.floor(Date.now() / 1000);
      }

      const activeCode = state.lastCodeBySender[from] || null;
      const dt = unixToDate(msg?.timestamp);
      const day = ymd(dt);

      // --- TEXT ---
      if (type === "text") {
        const text = msg?.text?.body || "";
        const foundCode = extractCodeFromText(text);

        if (foundCode) {
          state.lastCodeBySender[from] = foundCode;
        }

        const codeForSave = state.lastCodeBySender[from] || "unknown";
        const dir = path.join(DATA_DIR, codeForSave, day);
        await ensureDir(dir);

        const logPath = path.join(dir, "log.jsonl");
        await appendJsonl(logPath, {
          at: nowIso(),
          timestamp: msg?.timestamp,
          from,
          type: "text",
          message_id: msgId,
          text,
          active_code: state.lastCodeBySender[from] || null,
        });

        console.log(`✅ saved text for #${codeForSave} -> ${logPath}`);

        // If still unknown, remind once per 10 minutes
        if (!state.lastCodeBySender[from]) {
          const nowSec = Math.floor(Date.now() / 1000);
          const last = Number(state.lastPromptAtBySender[from] || 0);
          if (nowSec - last >= 600) {
            state.lastPromptAtBySender[from] = nowSec;
            await sendWhatsAppText(from, "Bitte Baustellennummer mit # davor senden", phoneNumberIdFromWebhook || state.lastPhoneNumberId);
          }
        }

        continue;
      }

      // --- IMAGE ---
      if (type === "image") {
        const mediaId = msg?.image?.id;
        const sha = msg?.image?.sha256 || "";
        const mime = msg?.image?.mime_type || "";

        const codeForSave = state.lastCodeBySender[from] || "unknown";
        const dir = path.join(DATA_DIR, codeForSave, day);
        await ensureDir(dir);

        // always save meta json
        const metaPath = path.join(dir, `${msg?.timestamp || Date.now()}_${mediaId}_meta.json`);
        await fsp.writeFile(
          metaPath,
          JSON.stringify(
            {
              at: nowIso(),
              timestamp: msg?.timestamp,
              from,
              message_id: msgId,
              type: "image",
              image: { id: mediaId, mime_type: mime, sha256: sha },
            },
            null,
            2
          ),
          "utf8"
        );

        console.log(`✅ saved image meta for #${codeForSave} -> ${metaPath}`);

        // download binary + save as file
        if (mediaId) {
          try {
            const { buf, meta, mime: metaMime } = await fetchMediaBinary(mediaId);
            const ext = mimeToExt(metaMime || mime);
            const filePath = path.join(dir, `${msg?.timestamp || Date.now()}_${mediaId}.${ext}`);
            await fsp.writeFile(filePath, buf);
            console.log(`✅ saved image file for #${codeForSave} -> ${filePath}`);

            // also append to log
            const logPath = path.join(dir, "log.jsonl");
            await appendJsonl(logPath, {
              at: nowIso(),
              timestamp: msg?.timestamp,
              from,
              type: "image",
              message_id: msgId,
              media_id: mediaId,
              file: path.basename(filePath),
              mime_type: metaMime || mime,
              active_code: state.lastCodeBySender[from] || null,
              graph_meta: meta || null,
            });

          } catch (e) {
            console.log("❌ media download failed:", e?.message || e);
          }
        }

        // If unknown, remind once per 10 minutes
        if (!state.lastCodeBySender[from]) {
          const nowSec = Math.floor(Date.now() / 1000);
          const last = Number(state.lastPromptAtBySender[from] || 0);
          if (nowSec - last >= 600) {
            state.lastPromptAtBySender[from] = nowSec;
            await sendWhatsAppText(from, "Bitte Baustellennummer mit # davor senden", phoneNumberIdFromWebhook || state.lastPhoneNumberId);
          }
        }

        continue;
      }

      // other types (document/audio/video) can be added later
      const codeForSave = state.lastCodeBySender[from] || "unknown";
      const dir = path.join(DATA_DIR, codeForSave, day);
      await ensureDir(dir);
      const logPath = path.join(dir, "log.jsonl");
      await appendJsonl(logPath, {
        at: nowIso(),
        timestamp: msg?.timestamp,
        from,
        type: type || "unknown_type",
        message_id: msgId,
        raw: msg,
        active_code: state.lastCodeBySender[from] || null,
      });
      console.log(`✅ saved ${type} for #${codeForSave} -> ${logPath}`);
    }

    // cleanup seenMessageIds (optional, keep last 7 days)
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    for (const [k, v] of Object.entries(state.seenMessageIds || {})) {
      if (Number(v) < cutoff) delete state.seenMessageIds[k];
    }

    await saveState(state);
  } catch (err) {
    console.log("Webhook error:", err);
    // response already 200’d above, so just log
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  const state = await loadState();
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`PHONE_NUMBER_ID env set: ${Boolean(PHONE_NUMBER_ID_ENV)}`);
  console.log("==> Your service is live 🎉");
});
