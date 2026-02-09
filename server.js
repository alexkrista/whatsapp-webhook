import express from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "25mb" }));

// --- ENV / CONFIG ---
const PORT = process.env.PORT || 10000;

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID_ENV = process.env.PHONE_NUMBER_ID || "";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

const STATE_DIR = path.join(DATA_DIR, "_state");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const UNKNOWN_REPLY_TEXT = "Bitte Baustellennummer mit # davor senden";
const PROMPT_COOLDOWN_SEC = 600; // 10 min

// --- Helpers ---
function nowIso() {
  return new Date().toISOString();
}

function ymdFromUnixSeconds(ts) {
  const n = Number(ts);
  const d = Number.isFinite(n) ? new Date(n * 1000) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function extractCodeFromText(text) {
  const m = String(text || "").match(/#(\d{3,})/);
  return m ? m[1] : null;
}

function mimeToExt(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("pdf")) return "pdf";
  return "bin";
}

async function appendJsonl(filePath, obj) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8");
}

// --- State (ROBUST DEFAULTS) ---
function normalizeState(parsed) {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  return {
    lastCodeBySender:
      p.lastCodeBySender && typeof p.lastCodeBySender === "object" ? p.lastCodeBySender : {},
    lastPromptAtBySender:
      p.lastPromptAtBySender && typeof p.lastPromptAtBySender === "object" ? p.lastPromptAtBySender : {},
    lastPhoneNumberId: typeof p.lastPhoneNumberId === "string" ? p.lastPhoneNumberId : "",
    seenMessageIds:
      p.seenMessageIds && typeof p.seenMessageIds === "object" ? p.seenMessageIds : {},
  };
}

async function loadState() {
  await ensureDir(STATE_DIR);
  if (!fs.existsSync(STATE_FILE)) {
    const init = normalizeState({});
    await fsp.writeFile(STATE_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const st = normalizeState(parsed);
    // Falls alte Datei Felder hatte die fehlen: hier sicherstellen
    return st;
  } catch {
    const init = normalizeState({});
    await fsp.writeFile(STATE_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
}

async function saveState(state) {
  const st = normalizeState(state);
  await ensureDir(STATE_DIR);
  await fsp.writeFile(STATE_FILE, JSON.stringify(st, null, 2), "utf8");
}

// --- WhatsApp Send Text ---
async function sendWhatsAppText(toWaId, text, phoneNumberIdFromWebhook = "") {
  const phoneNumberId = PHONE_NUMBER_ID_ENV || phoneNumberIdFromWebhook;
  if (!WHATSAPP_TOKEN) return;
  if (!phoneNumberId) return;

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

// --- WhatsApp Media Download ---
async function fetchMediaBinary(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN missing");

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

  const binRes = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  if (!binRes.ok) {
    const t = await binRes.text().catch(() => "");
    throw new Error(`Binary fetch failed (${binRes.status}): ${t}`);
  }

  const buf = Buffer.from(await binRes.arrayBuffer());
  return { buf, meta, mime };
}

// --- Routes ---
app.get("/", (req, res) => res.status(200).send("webhook läuft"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && challenge) {
    if (token === VERIFY_TOKEN) return res.status(200).send(String(challenge));
    return res.sendStatus(403);
  }

  return res.status(200).send("ok");
});

app.post("/webhook", async (req, res) => {
  // ACK schnell
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log("Incoming webhook:", JSON.stringify(body));

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const field = change?.field;

    if (field !== "messages" || !value) return;

    const phoneNumberIdFromWebhook = value?.metadata?.phone_number_id || "";

    const messages = value?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return;

    const state = await loadState();

    if (phoneNumberIdFromWebhook) state.lastPhoneNumberId = phoneNumberIdFromWebhook;

    for (const msg of messages) {
      const msgId = msg?.id || "";
      const from = msg?.from || "";
      const type = msg?.type || "unknown";

      if (!from) continue;

      // ✅ DEDUP (und jetzt garantiert nicht undefined)
      if (msgId) {
        if (state.seenMessageIds[msgId]) {
          console.log("↩️ duplicate ignored:", msgId);
          continue;
        }
        state.seenMessageIds[msgId] = Math.floor(Date.now() / 1000);
      }

      const day = ymdFromUnixSeconds(msg?.timestamp);
      const activeCode = state.lastCodeBySender[from] || null;

      // TEXT
      if (type === "text") {
        const text = msg?.text?.body || "";
        const found = extractCodeFromText(text);
        if (found) state.lastCodeBySender[from] = found;

        const codeForSave = state.lastCodeBySender[from] || "unknown";
        const dir = path.join(DATA_DIR, codeForSave, day);
        await ensureDir(dir);

        const logPath = path.join(dir, "log.jsonl");
        await appendJsonl(logPath, {
          at: nowIso(),
          from,
          message_id: msgId,
          type: "text",
          text,
          active_code: state.lastCodeBySender[from] || null,
        });

        console.log(`✅ saved text for #${codeForSave} -> ${logPath}`);

        if (!state.lastCodeBySender[from]) {
          const nowSec = Math.floor(Date.now() / 1000);
          const last = Number(state.lastPromptAtBySender[from] || 0);
          if (nowSec - last >= PROMPT_COOLDOWN_SEC) {
            state.lastPromptAtBySender[from] = nowSec;
            await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT, phoneNumberIdFromWebhook || state.lastPhoneNumberId);
          }
        }

        continue;
      }

      // IMAGE (JPG speichern)
      if (type === "image") {
        const mediaId = msg?.image?.id;
        const mimeFromHook = msg?.image?.mime_type || "";

        const codeForSave = state.lastCodeBySender[from] || "unknown";
        const dir = path.join(DATA_DIR, codeForSave, day);
        await ensureDir(dir);

        // Meta-Datei (optional)
        const metaPath = path.join(dir, `${msg?.timestamp || Date.now()}_${mediaId}_meta.json`);
        await fsp.writeFile(
          metaPath,
          JSON.stringify(
            {
              at: nowIso(),
              from,
              message_id: msgId,
              media_id: mediaId,
              mime_type: mimeFromHook,
              raw: msg,
            },
            null,
            2
          ),
          "utf8"
        );

        if (mediaId) {
          try {
            const { buf, mime } = await fetchMediaBinary(mediaId);
            const ext = mimeToExt(mime || mimeFromHook);
            const filePath = path.join(dir, `${msg?.timestamp || Date.now()}_${mediaId}.${ext}`);
            await fsp.writeFile(filePath, buf);

            const logPath = path.join(dir, "log.jsonl");
            await appendJsonl(logPath, {
              at: nowIso(),
              from,
              message_id: msgId,
              type: "image",
              media_id: mediaId,
              file: path.basename(filePath),
              mime_type: mime || mimeFromHook,
              active_code: state.lastCodeBySender[from] || null,
            });

            console.log(`✅ saved image file for #${codeForSave} -> ${filePath}`);
          } catch (e) {
            console.log("❌ media download failed:", e?.message || e);
          }
        } else {
          console.log("⚠️ image without media id");
        }

        if (!state.lastCodeBySender[from]) {
          const nowSec = Math.floor(Date.now() / 1000);
          const last = Number(state.lastPromptAtBySender[from] || 0);
          if (nowSec - last >= PROMPT_COOLDOWN_SEC) {
            state.lastPromptAtBySender[from] = nowSec;
            await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT, phoneNumberIdFromWebhook || state.lastPhoneNumberId);
          }
        }

        continue;
      }

      // OTHER TYPES -> log raw
      const codeForSave = state.lastCodeBySender[from] || "unknown";
      const dir = path.join(DATA_DIR, codeForSave, day);
      await ensureDir(dir);

      const logPath = path.join(dir, "log.jsonl");
      await appendJsonl(logPath, {
        at: nowIso(),
        from,
        message_id: msgId,
        type,
        raw: msg,
        active_code: state.lastCodeBySender[from] || null,
      });

      console.log(`✅ saved ${type} for #${codeForSave} -> ${logPath}`);

      if (!state.lastCodeBySender[from]) {
        const nowSec = Math.floor(Date.now() / 1000);
        const last = Number(state.lastPromptAtBySender[from] || 0);
        if (nowSec - last >= PROMPT_COOLDOWN_SEC) {
          state.lastPromptAtBySender[from] = nowSec;
          await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT, phoneNumberIdFromWebhook || state.lastPhoneNumberId);
        }
      }
    }

    // Cleanup seenMessageIds older than 7 days
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    for (const [k, v] of Object.entries(state.seenMessageIds)) {
      if (Number(v) < cutoff) delete state.seenMessageIds[k];
    }

    await saveState(state);
  } catch (err) {
    console.log("Webhook error:", err);
  }
});

// Start
app.listen(PORT, async () => {
  await ensureDir(DATA_DIR);
  await ensureDir(STATE_DIR);
  await loadState();

  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`PHONE_NUMBER_ID env set: ${Boolean(PHONE_NUMBER_ID_ENV)}`);
  console.log("==> Your service is live 🎉");
});
