"use strict";

const path = require("path");

let MsgReader = null;
try {
  const loaded = require("@kenjiuno/msgreader");
  MsgReader = loaded?.default || loaded;
} catch (error) {
  console.warn("⚠️ KRISTINE MSG-Reader nicht verfügbar:", String(error?.message || error));
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function htmlToText(html) {
  return cleanText(decodeHtmlEntities(String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")));
}

function safeFilename(value, fallback = "Anlage") {
  const name = path.basename(String(value || fallback)).replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_").trim();
  return (name || fallback).slice(0, 180);
}

function mimeFromName(filename, explicit = "") {
  if (explicit) return String(explicit).slice(0, 160);
  const ext = path.extname(String(filename || "")).toLowerCase();
  return ({
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".msg": "application/vnd.ms-outlook",
    ".eml": "message/rfc822",
  })[ext] || "application/octet-stream";
}

function person(recipient) {
  const name = cleanText(recipient?.name || "");
  const email = cleanText(recipient?.email || recipient?.emailAddress || "");
  return { name, email, label: name && email && name.toLowerCase() !== email.toLowerCase() ? `${name} <${email}>` : (email || name) };
}

function dateValue(info) {
  return cleanText(info?.clientSubmitTime || info?.messageDeliveryTime || info?.creationTime || info?.lastModificationTime || "");
}

function readerFor(buffer) {
  if (!MsgReader) throw new Error("MSG-Reader ist nicht installiert");
  return new MsgReader(buffer);
}

function parseMsg(buffer) {
  const reader = readerFor(buffer);
  const info = reader.getFileData() || {};
  const recipients = Array.isArray(info.recipients) ? info.recipients : [];
  const to = recipients.filter((row) => row?.recipType === "to" || !row?.recipType).map(person).filter((row) => row.label);
  const cc = recipients.filter((row) => row?.recipType === "cc").map(person).filter((row) => row.label);
  const bcc = recipients.filter((row) => row?.recipType === "bcc").map(person).filter((row) => row.label);
  const senderName = cleanText(info.senderName || "");
  const senderEmail = cleanText(info.senderEmail || "");
  const subject = cleanText(info.subject || "");
  const bodyHtml = String(info.bodyHtml || "").trim();
  const body = cleanText(info.body || "") || htmlToText(bodyHtml);
  const attachments = (Array.isArray(info.attachments) ? info.attachments : [])
    .map((att, index) => {
      const name = safeFilename(att?.fileName || att?.fileNameShort || `Anlage-${index + 1}`);
      return {
        index,
        name,
        size: Number(att?.contentLength || 0),
        mimeType: mimeFromName(name, att?.attachMimeTag || ""),
        hidden: Boolean(att?.attachmentHidden),
      };
    })
    .filter((att) => !att.hidden);

  const mail = {
    kind: "msg",
    subject,
    senderName,
    senderEmail,
    to,
    cc,
    bcc,
    sentAt: dateValue(info),
    body,
    bodyHtml: bodyHtml.slice(0, 500000),
    attachments,
  };

  const sender = senderName && senderEmail ? `${senderName} <${senderEmail}>` : (senderEmail || senderName);
  const text = [
    subject ? `Betreff: ${subject}` : "",
    sender ? `Von: ${sender}` : "",
    to.length ? `An: ${to.map((row) => row.label).join("; ")}` : "",
    cc.length ? `Cc: ${cc.map((row) => row.label).join("; ")}` : "",
    mail.sentAt ? `Gesendet: ${mail.sentAt}` : "",
    "",
    body,
  ].filter((part, index, all) => part || (index > 0 && all[index - 1])).join("\n").trim();

  return { mail, text, info };
}

function getMsgAttachment(buffer, index) {
  const reader = readerFor(buffer);
  const info = reader.getFileData() || {};
  const attachments = Array.isArray(info.attachments) ? info.attachments : [];
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= attachments.length) return null;
  const source = attachments[idx];
  const attachment = reader.getAttachment(source);
  if (!attachment?.content) return null;
  const name = safeFilename(attachment.fileName || source?.fileName || source?.fileNameShort || `Anlage-${idx + 1}`);
  return {
    name,
    mimeType: mimeFromName(name, source?.attachMimeTag || ""),
    content: Buffer.from(attachment.content),
  };
}

function available() {
  return Boolean(MsgReader);
}

module.exports = { parseMsg, getMsgAttachment, available, htmlToText };
