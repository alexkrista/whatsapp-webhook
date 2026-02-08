// server.js (CommonJS)
// npm i express
// Node 18+ (bei dir Node 22) => fetch ist verfügbar

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// WhatsApp sendet JSON
app.use(express.json({ limit: "20mb" }));

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || ""; // muss mit Meta "Verifizierungstoken" übereinstimmen
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""; // Graph API Token
const DATA_DIR = process.env.DATA_DIR || "/var/data"; // bei Render Disk: /var/data

// Optional für /admin/run-daily Schutz:
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // wenn gesetzt: /admin/run-daily?key=...

// -------------------- HELPERS --------------------
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isoDateLocal(tsSeconds) {
  // WhatsApp timestamps sind Sekunden (String)
  const d = tsSeconds ? new Date(Number(tsSeconds) * 1000) : new Date();
  // YYYY-MM-DD
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function findSiteCode(text) {
  // Erwartet "#260016" -> "260016"
  if (!text) return "unknown";
  const m = text.match(/#(\d{3,})/); // mind. 3 Ziffern
  return m ? m[1] : "unknown";
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function extFromMime(mime) {
  if (!mime) return "";
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "video/mp4": ".mp4",
  };
  return map[mime] || "";
}

async function graphGet(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Graph GET failed ${res.status}: ${txt}`);
  }
  return res.json();
}

async function graphDownloadBinary(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Download failed ${res.status}: ${txt}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function downloadWhatsAppMedia(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN is missing");

  // 1) Media URL holen
  const meta = await graphGet(`https://graph.facebook.com/v22.0/${mediaId}`);
  // meta: { url, mime_type, sha256, file_size, id }
  if (!meta.url) throw new Error("Media meta has no url");

  // 2) Binary laden
  const buf = await graphDownloadBinary(meta.url);

  return {
    buffer: buf,
    mimeType: meta.mime_type || "",
    fileSize: meta.file_size || null,
    sha256: meta.sha256 || null,
  };
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

function safeName(name) {
  return String(name || "")
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120);
}

// -------------------- ROUTES --------------------

// Health / Root
app.get("/", (req, res) => {
  res.status(200).send("webhook läuft ✅");
});

// WhatsApp Verify (Meta Webhook Verification)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("❌ Webhook verify failed", { mode, tokenPresent: !!token });
  return res.sendStatus(403);
});

// WhatsApp Incoming Events
app.post("/webhook", async (req, res) => {
  // sofort 200 zurückgeben ist ok, aber wir loggen vorher minimal
  try {
    const payload = req.body;

    console.log("Incoming webhook:", JSON.stringify(payload));

    // Nur WhatsApp Business Account events relevant
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages || [];
    const contacts = value?.contacts || [];
    const contactName = contacts?.[0]?.profile?.name || null;
    const waFrom = messages?.[0]?.from || null;

    // Wenn keine message dabei ist (z.B. status updates), trotzdem loggen
    if (!messages.length) {
      return res.sendStatus(200);
    }

    // Wir handeln alle messages im Array
    for (const msg of messages) {
      const ts = msg.timestamp ? Number(msg.timestamp) : nowUnix();
      const day = isoDateLocal(ts);
      let textBody = "";

      if (msg.type === "text") {
        textBody = msg?.text?.body || "";
      }

      const siteCode = findSiteCode(textBody);

      const baseDir = path.join(DATA_DIR, siteCode, day);
      ensureDir(baseDir);

      const logPath = path.join(baseDir, "log.jsonl");

      // Grundlog
      appendJsonl(logPath, {
        kind: "message",
        ts,
        from: waFrom,
        contactName,
        msgId: msg.id || null,
        type: msg.type,
        text: textBody || null,
        raw: msg,
      });

      // Medien behandeln
      // WhatsApp msg.type kann "image", "document", "audio", "video" etc sein
      const mediaTypes = ["image", "document", "audio", "video", "sticker"];
      if (mediaTypes.includes(msg.type)) {
        const mediaObj = msg[msg.type];
        const mediaId = mediaObj?.id;

        if (!mediaId) {
          appendJsonl(logPath, {
            kind: "media_error",
            ts,
            error: "No media id found",
            raw: msg,
          });
        } else {
          try {
            const { buffer, mimeType, fileSize, sha256 } =
              await downloadWhatsAppMedia(mediaId);

            const ext = extFromMime(mimeType) || "";
            const filename =
              msg.type === "document" && mediaObj?.filename
                ? safeName(mediaObj.filename)
                : `${ts}_${mediaId}${ext || ""}`;

            const outPath = path.join(baseDir, filename);
            fs.writeFileSync(outPath, buffer);

            appendJsonl(logPath, {
              kind: "media_saved",
              ts,
              type: msg.type,
              mediaId,
              mimeType,
              fileSize,
              sha256,
              file: filename,
              path: outPath,
            });

            console.log(`✅ saved ${msg.type} for #${siteCode} -> ${outPath}`);
          } catch (e) {
            appendJsonl(logPath, {
              kind: "media_error",
              ts,
              type: msg.type,
              mediaId,
              error: String(e?.message || e),
            });
            console.log(`❌ media download failed: ${e?.message || e}`);
          }
        }
      }

      // kleine Console-Meldung wie bei dir
      if (msg.type === "text") {
        console.log(`✅ saved message for #${siteCode} -> ${logPath}`);
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    // Meta will trotzdem 200 oft – aber bei echter Exception geben wir 500 zurück
    return res.sendStatus(500);
  }
});

// Admin: manuell Tageslauf triggern (z.B. PDF bauen + mailen)
// aktuell: Platzhalter (damit der Endpoint nicht "Cannot GET" liefert)
app.get("/admin/run-daily", async (req, res) => {
  try {
    if (ADMIN_KEY) {
      if (req.query.key !== ADMIN_KEY) return res.status(403).send("Forbidden");
    }

    // TODO: Hier kannst du später dein Daily bauen:
    // - alle Baustellenordner unter DATA_DIR scannen
    // - WhatsApp Chatlog + Bilder zu PDF bauen (A3 quer, 6 Fotos pro Seite)
    // - per Mail versenden

    return res.status(200).json({
      ok: true,
      message: "run-daily triggered (placeholder)",
      dataDir: DATA_DIR,
      now: new Date().toISOString(),
    });
  } catch (e) {
    console.error("run-daily failed:", e);
    return res.status(500).send("run-daily failed");
  }
});

// 404 fallback (hilft beim Debuggen)
app.use((req, res) => {
  res.status(404).send(`Not found: ${req.method} ${req.path}`);
});

// -------------------- START --------------------
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
});
