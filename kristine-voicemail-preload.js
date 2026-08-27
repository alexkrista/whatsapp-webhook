"use strict";

// NFON-Voicemails im KRISTINE Eingang automatisch vertexten.
// Additiv: wir hängen uns nur an die bestehende /kristine/api/inbox/import-Antwort.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const express = require("express");
const { parseMsg, getMsgAttachment, available: msgReaderAvailable } = require("./kristine-msg-reader");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_TRANSCRIBE_MODEL = String(process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe").trim();
const OPENAI_TRANSCRIBE_LANG = String(process.env.OPENAI_TRANSCRIBE_LANG || "de").trim();
const OPENAI_TEXT_MODEL = String(process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini").trim();
const PATCH_FLAG = Symbol.for("krista.voicemail.inboxImport.v1");
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".oga", ".webm", ".aac", ".flac"]);

function safeId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 180);
}
function cleanText(value, max = 12000) {
  return String(value || "").replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim().slice(0, max);
}
function audioMime(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  return ({
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
    ".ogg": "audio/ogg", ".oga": "audio/ogg", ".webm": "audio/webm", ".aac": "audio/aac", ".flac": "audio/flac",
  })[ext] || "application/octet-stream";
}
function isVoicemailSubject(value) {
  return /neue\s+voicemail|voicemail\s+von|nfon/i.test(String(value || ""));
}
function normalizePhone(value) {
  const raw = String(value || "").trim();
  const plus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  return (plus ? "+" : "") + digits;
}
function callerPhone(...values) {
  for (const value of values) {
    const text = String(value || "");
    for (const match of text.matchAll(/\+\d[\d\s().\/-]{6,}\d/g)) {
      const phone = normalizePhone(match[0]);
      if (phone) return phone;
    }
  }
  return "";
}
function tidyCallerName(value) {
  let name = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "")
    .replace(/^(?:die\s+)?firma\s+/i, "")
    .replace(/^(?:frau|herr)\s+/i, "")
    .trim();
  // Bei „Firma Schlenker in Rosenau“ soll nur „Schlenker“ in den Betreff.
  name = name.split(/\s+(?:in|aus|von)\s+/i)[0].trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 5 || name.length > 70) return "";
  if (/^(?:ich|wir|das|hier|guten|hallo|bitte|telefon|voicemail)$/i.test(name)) return "";
  return name;
}
function callerNameFromTranscript(value) {
  const text = cleanText(value, 4000).replace(/\s+/g, " ").trim();
  if (!text) return "";
  const patterns = [
    /\bhier\s+ist\s+(?:die\s+)?firma\s+([^,.!?]{2,80})/i,
    /\bhier\s+ist\s+(?:frau\s+|herr\s+)?([^,.!?]{2,80})/i,
    /\bmein\s+name\s+ist\s+([^,.!?]{2,80})/i,
    /\bich\s+bin\s+(?:frau\s+|herr\s+)?([^,.!?]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = tidyCallerName(match?.[1] || "");
    if (name) return name;
  }
  return "";
}
function extractResponsesText(json) {
  if (!json) return "";
  if (typeof json.output_text === "string") return json.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(json.output) ? json.output : []) {
    for (const c of Array.isArray(item?.content) ? item.content : []) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("").trim();
}
async function transcribeAudio(buffer, filename) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY fehlt");
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: audioMime(filename) }), filename || "voicemail.wav");
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  if (OPENAI_TRANSCRIBE_LANG) form.append("language", OPENAI_TRANSCRIBE_LANG);
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Transkription fehlgeschlagen (${response.status}): ${body.slice(0, 400)}`);
  }
  const data = await response.json();
  return cleanText(data?.text || "", 12000);
}
async function polishTranscript(raw) {
  const source = cleanText(raw, 12000);
  if (!source || !OPENAI_API_KEY || !OPENAI_TEXT_MODEL) return source;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_TEXT_MODEL,
      input: [
        { role: "system", content: "Formuliere eine Telefon-Voicemail in sauberem, knappen Hochdeutsch. Namen, Telefonnummern, Termine und konkrete Anliegen exakt erhalten. Keine Details ergänzen. Nur den bereinigten Inhalt ausgeben." },
        { role: "user", content: source },
      ],
    }),
  });
  if (!response.ok) return source;
  return cleanText(extractResponsesText(await response.json()) || source, 12000);
}

function itemPaths(item) {
  const id = safeId(item?.id);
  const stored = path.basename(String(item?.storedFilename || item?.name || ""));
  return {
    itemFile: path.join(DATA_DIR, "_kristine", "inbox", "items", `${id}.json`),
    originalFile: path.join(DATA_DIR, "_kristine", "inbox", "files", id, stored),
  };
}
async function enrichVoicemailItem(item) {
  if (!item || !safeId(item.id) || !msgReaderAvailable()) return item;
  const filename = String(item.storedFilename || item.name || "");
  if (path.extname(filename).toLowerCase() !== ".msg") return item;
  const { itemFile, originalFile } = itemPaths(item);
  if (!fs.existsSync(originalFile)) return item;

  const msgBuffer = await fsp.readFile(originalFile);
  const parsed = parseMsg(msgBuffer);
  const mail = parsed.mail || item.mail || {};
  const audioMeta = (mail.attachments || []).find(att => AUDIO_EXTENSIONS.has(path.extname(String(att.name || "")).toLowerCase()));
  const voicemail = isVoicemailSubject(mail.subject || item.analysis?.subject || item.name) || Boolean(audioMeta);
  if (!voicemail) return item;

  const phone = callerPhone(mail.subject, item.analysis?.subject, item.name, mail.body);
  const previous = item.analysis || {};
  item.analysis = {
    ...previous,
    recommended: "task",
    confidence: Math.max(Number(previous.confidence || 0), 0.98),
    reasons: ["NFON-Voicemail erkannt"],
    contactPhone: phone || previous.contactPhone || "",
    title: phone ? `Rückruf ${phone}` : "Voicemail beantworten",
    subject: mail.subject || previous.subject || item.name,
  };
  item.mail = { ...(item.mail || {}), ...mail };

  if (!audioMeta) {
    item.voicemail = { provider: "NFON", callerPhone: phone, error: "Keine Audiodatei gefunden", detectedAt: new Date().toISOString() };
    await fsp.writeFile(itemFile, JSON.stringify(item, null, 2), "utf8").catch(() => {});
    return item;
  }

  try {
    const attachment = getMsgAttachment(msgBuffer, audioMeta.index);
    if (!attachment?.content?.length) throw new Error("Audiodatei konnte nicht gelesen werden");
    const rawTranscript = await transcribeAudio(attachment.content, attachment.name);
    if (!rawTranscript) throw new Error("kein erkennbarer Sprachinhalt");
    const transcript = await polishTranscript(rawTranscript);
    const callerName = callerNameFromTranscript(transcript) || callerNameFromTranscript(rawTranscript);
    item.analysis = {
      ...item.analysis,
      confidence: 0.99,
      reasons: ["NFON-Voicemail erkannt", "Sprachnachricht transkribiert", ...(callerName ? ["Anrufername erkannt"] : [])],
      contactName: callerName || item.analysis.contactName || "",
      title: callerName ? `Rückruf ${callerName}` : (phone ? `Rückruf ${phone}` : "Voicemail beantworten"),
      summary: transcript,
      excerpt: `${callerName ? `Voicemail von ${callerName}${phone ? ` · ${phone}` : ""}` : (phone ? `Voicemail von ${phone}` : "Voicemail")}\n\n${transcript}`,
      textAvailable: true,
    };
    item.voicemail = {
      provider: "NFON",
      callerPhone: phone,
      callerName,
      attachmentName: attachment.name,
      rawTranscript,
      transcript,
      transcribedAt: new Date().toISOString(),
      model: OPENAI_TRANSCRIBE_MODEL,
    };
  } catch (error) {
    item.analysis = {
      ...item.analysis,
      reasons: ["NFON-Voicemail erkannt", "Transkription noch nicht möglich"],
      summary: phone ? `Voicemail von ${phone} – Audio bitte prüfen.` : "Voicemail – Audio bitte prüfen.",
    };
    item.voicemail = {
      provider: "NFON",
      callerPhone: phone,
      attachmentName: audioMeta.name || "",
      error: String(error?.message || error).slice(0, 800),
      detectedAt: new Date().toISOString(),
    };
  }

  item.status = "analyzed";
  item.updatedAt = new Date().toISOString();
  await fsp.writeFile(itemFile, JSON.stringify(item, null, 2), "utf8").catch(() => {});
  return item;
}
async function enrichPayload(payload) {
  if (!payload?.item) return payload;
  try {
    const item = await enrichVoicemailItem(payload.item);
    return { ...payload, item };
  } catch (error) {
    console.warn("KRISTINE Voicemail-Import:", String(error?.message || error));
    return payload;
  }
}

if (!express.application[PATCH_FLAG]) {
  express.application[PATCH_FLAG] = true;
  const originalPost = express.application.post;
  express.application.post = function patchedPost(route, ...handlers) {
    if (route === "/kristine/api/inbox/import" && handlers.length) {
      const wrapped = handlers.map(handler => {
        if (typeof handler !== "function") return handler;
        return function voicemailInboxImportWrapper(req, res, next) {
          const originalJson = res.json.bind(res);
          let sent = false;
          res.json = function voicemailJson(payload) {
            if (sent) return originalJson(payload);
            sent = true;
            return enrichPayload(payload).then(originalJson).catch(() => originalJson(payload));
          };
          return handler(req, res, next);
        };
      });
      return originalPost.call(this, route, ...wrapped);
    }
    return originalPost.call(this, route, ...handlers);
  };
}

console.log("KRISTINE Voicemail-Import aktiv");
