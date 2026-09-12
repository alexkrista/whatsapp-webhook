"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { importInboxBuffer } = require("./kristine-inbox");

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const DEFAULT_MAILBOX = "kristine@krista.at";
const POLL_MS = 60 * 1000;

function installKristineSharedMailbox(app, deps = {}) {
  const dataDir = deps.dataDir || process.env.DATA_DIR || "/var/data";
  const requireAdmin = deps.requireAdmin;
  const getAccessToken = deps.accessToken;
  const logger = deps.logger || console;
  const mailbox = String(process.env.KRISTINE_MAILBOX_ADDRESS || deps.mailbox || DEFAULT_MAILBOX).trim().toLowerCase();
  const root = path.join(dataDir, "_kristine");
  const stateFile = path.join(root, "shared-mailbox-state.json");
  let running = null;
  let lastResult = { mailbox, imported:0, duplicates:0, lastSuccessAt:"", lastError:"" };

  const allowed = (req, res) => typeof requireAdmin !== "function" ? true : requireAdmin(req, res);

  async function readState() {
    try { return JSON.parse(await fsp.readFile(stateFile, "utf8")); }
    catch { return {}; }
  }

  async function writeState(value) {
    await fsp.mkdir(root, { recursive:true });
    const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(temporary, stateFile);
  }

  async function graph(url, options = {}) {
    if (typeof getAccessToken !== "function") throw new Error("Microsoft-Anmeldung ist nicht eingerichtet.");
    const token = await getAccessToken();
    const target = /^https:\/\//i.test(String(url)) ? String(url) : `${GRAPH_ROOT}${url}`;
    const response = await fetch(target, { ...options, headers:{ Authorization:`Bearer ${token}`, ...(options.headers || {}) } });
    if (response.ok) return response;
    const body = await response.json().catch(() => ({}));
    const message = String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`);
    if (response.status === 403) throw new Error(`Kein Zugriff auf ${mailbox}. Alexander bitte als Mitglied mit Vollzugriff eintragen und Microsoft neu verbinden. (${message})`);
    throw new Error(message);
  }

  function address(person) {
    const email = person?.emailAddress || person || {};
    const name = String(email.name || "").trim();
    const value = String(email.address || "").trim().toLowerCase();
    return { name, email:value, label:name && value ? `${name} <${value}>` : (value || name) };
  }

  function plainBody(message) {
    const content = String(message?.body?.content || message?.bodyPreview || "");
    if (String(message?.body?.contentType || "").toLowerCase() !== "html") return content;
    return content
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim();
  }

  function mailMetadata(message, attachments) {
    const sender = address(message.from);
    return {
      reader:"microsoft-graph-v1",
      subject:String(message.subject || "(ohne Betreff)"),
      senderName:sender.name,
      senderEmail:sender.email,
      to:(message.toRecipients || []).map(address),
      cc:(message.ccRecipients || []).map(address),
      sentAt:String(message.sentDateTime || message.receivedDateTime || ""),
      receivedAt:String(message.receivedDateTime || ""),
      body:plainBody(message),
      bodyHtml:String(message?.body?.contentType || "").toLowerCase() === "html" ? String(message.body.content || "") : "",
      internetMessageId:String(message.internetMessageId || ""),
      attachments:attachments.map(({ content, ...metadata }, index) => ({ ...metadata, index })),
    };
  }

  async function attachmentFiles(message) {
    if (!message.hasAttachments) return [];
    const base = `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(message.id)}/attachments`;
    const list = await graph(`${base}?$select=id,name,contentType,size,isInline`).then(response => response.json());
    const files = [];
    for (const attachment of list.value || []) {
      if (attachment.isInline || !attachment.id || Number(attachment.size || 0) > 25 * 1024 * 1024) continue;
      const detail = await graph(`${base}/${encodeURIComponent(attachment.id)}`).then(response => response.json());
      const content = detail.contentBytes ? Buffer.from(detail.contentBytes, "base64") : null;
      if (!content?.length) continue;
      files.push({
        name:String(detail.name || attachment.name || "Anlage"),
        mimeType:String(detail.contentType || attachment.contentType || "application/octet-stream"),
        isInline:false,
        content,
      });
    }
    return files;
  }

  function messageFilename(message) {
    const day = String(message.receivedDateTime || new Date().toISOString()).slice(0, 10);
    const subject = String(message.subject || "ohne Betreff").replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_").trim().slice(0, 120);
    return `${day} - ${subject || "ohne Betreff"}.eml`;
  }

  async function importMessage(message) {
    const base = `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(message.id)}`;
    const mime = Buffer.from(await graph(`${base}/$value`).then(response => response.arrayBuffer()));
    const attachments = await attachmentFiles(message);
    const mail = mailMetadata(message, attachments);
    const source = {
      kind:"microsoft-shared-mailbox",
      mailbox,
      messageId:String(message.id || ""),
      internetMessageId:String(message.internetMessageId || ""),
      receivedAt:String(message.receivedDateTime || new Date().toISOString()),
    };
    return importInboxBuffer({
      dataDir,
      buffer:mime,
      name:messageFilename(message),
      mimeType:"message/rfc822",
      externalKey:`microsoft:${mailbox}:${message.id}`,
      source,
      mail,
      attachments,
    });
  }

  async function performSync() {
    const previous = await readState();
    let next = previous.deltaLink || `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta?$select=id,internetMessageId,subject,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,body,bodyPreview,hasAttachments&$top=50`;
    let imported = 0;
    let duplicates = 0;
    let deltaLink = previous.deltaLink || "";
    while (next) {
      const page = await graph(next).then(response => response.json());
      for (const message of page.value || []) {
        if (!message.id || message["@removed"]) continue;
        const result = await importMessage(message);
        if (result.duplicate) duplicates += 1; else imported += 1;
      }
      next = String(page["@odata.nextLink"] || "");
      deltaLink = String(page["@odata.deltaLink"] || deltaLink);
    }
    const now = new Date().toISOString();
    await writeState({ mailbox, deltaLink, lastSuccessAt:now, importedTotal:Number(previous.importedTotal || 0) + imported });
    lastResult = { mailbox, imported, duplicates, lastSuccessAt:now, lastError:"" };
    if (imported) logger.log(`✅ KRISTINE Postfach: ${imported} neue Mail(s) aus ${mailbox} übernommen`);
    return lastResult;
  }

  function sync() {
    if (!running) running = performSync().catch(error => {
      lastResult = { ...lastResult, lastError:String(error?.message || error), failedAt:new Date().toISOString() };
      logger.warn?.("⚠️ KRISTINE Postfach-Sync:", lastResult.lastError);
      throw error;
    }).finally(() => { running = null; });
    return running;
  }

  app.get("/kristine/api/mailbox/status", async (req, res) => {
    if (!allowed(req, res)) return;
    const stored = await readState();
    res.json({ ok:true, mailbox, polling:true, ...stored, ...lastResult, running:!!running });
  });

  app.post("/kristine/api/mailbox/sync", async (req, res) => {
    if (!allowed(req, res)) return;
    try { res.json({ ok:true, ...(await sync()) }); }
    catch (error) { res.status(502).json({ ok:false, mailbox, error:String(error?.message || error) }); }
  });

  const first = setTimeout(() => sync().catch(() => {}), Number(deps.initialDelayMs ?? 10000));
  first.unref?.();
  const timer = setInterval(() => sync().catch(() => {}), Number(deps.pollMs || POLL_MS));
  timer.unref?.();
  logger.log(`✅ KRISTINE gemeinsames Postfach registriert · ${mailbox}`);
  return { sync, mailbox, stop(){ clearTimeout(first); clearInterval(timer); } };
}

module.exports = { installKristineSharedMailbox };
