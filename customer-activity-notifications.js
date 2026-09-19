"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeJob = value => /^[A-Za-z0-9_-]{1,80}$/.test(String(value));

function documentChanges(before, after) {
  const visible = row => row?.type === "regie_report" || (row?.customerVisible === true && /\.pdf$/i.test(row.storedName || ""));
  const version = row => hash([row.id, row.storedName, row.fingerprint, row.offerRevision, row.confirmationRevision, row.approvedAt, row.renderedAt]);
  const previous = new Set(before.filter(visible).map(version));
  return after.filter(visible).filter(row => !previous.has(version(row))).map(row => ({
    key:`document:${version(row)}`, audience:"customer", module:row.type === "regie_report" ? "regie" : "projectFile",
    title:row.source === "order-confirmation" ? "Auftragsbestätigung in Ihrer Akte" : row.type === "regie_report" ? "Neuer Regiebericht in Ihrer Projektakte" : "Neues Dokument in Ihrer Projektakte",
    text:`${String(row.name || "Ein neues Dokument").slice(0, 180)} wurde in Ihrer Projektakte abgelegt.`,
  }));
}

function createActivityNotifications({ dataDir, recipients, sendMail, sendWhatsApp, now = () => new Date().toISOString() }) {
  const queues = new Map();
  const folder = jobId => path.join(dataDir, String(jobId), "_customer-notifications");
  async function store(file, value) {
    await fs.mkdir(path.dirname(file), { recursive:true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode:0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force:true }); }
  }
  async function dispatch(jobId, event) {
    if (!safeJob(jobId) || !event.key || !["customer", "office"].includes(event.audience)) throw new Error("Ungültiges Mitteilungsereignis.");
    const id = hash([event.audience, event.key]), file = path.join(folder(jobId), `${id}.json`);
    const existing = await fs.readFile(file, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    // Repeated saves, reloads and restarts do not send the same event again.
    if (existing) return { ...existing, duplicate:true };
    const record = { id, jobId:String(jobId), key:event.key, audience:event.audience, title:String(event.title || "Neue Mitteilung").slice(0,180), createdAt:now(), status:"pending", sent:false, channels:[], deliveries:[], error:"" };
    await store(file, record);
    try {
      const targets = await recipients(jobId, event);
      if (!targets.length) throw new Error("Kein eindeutiger freigegebener Empfänger hinterlegt.");
      const seen = new Set();
      for (const target of targets) {
        const contactKey = target.key || hash([target.email, target.phone]);
        if (seen.has(contactKey)) continue;
        seen.add(contactKey);
        const delivery = { recipient:String(target.name || "Empfänger").slice(0,180), status:"sending", channel:"", error:"" };
        record.deliveries.push(delivery); record.status="sending"; await store(file, record);
        const greeting = event.audience === "office" ? "Neue Kundenrückmeldung" : target.name ? `Guten Tag ${target.name},` : "Guten Tag,";
        const message = `${greeting}\n\n${record.title}\nAuftrag #${jobId}\n${String(event.text || "").slice(0,2000)}${target.portalUrl ? `\n\nIhre Projektakte:\n${target.portalUrl}` : ""}${event.audience === "customer" ? "\n\nFreundliche Grüße\nFarben Krista" : ""}`;
        const errors = [];
        // E-mail also reaches customers outside WhatsApp's active conversation window.
        if (target.email) {
          try { const result=await sendMail({to:target.email,subject:`${record.title} · Auftrag #${jobId}`,text:message}); if (!result || (Array.isArray(result.accepted) && !result.accepted.length)) throw new Error("Mailserver hat den Versand nicht angenommen."); delivery.channel="E-Mail"; }
          catch(error) { errors.push(`E-Mail: ${error.message}`); }
        }
        if (!delivery.channel && target.phone) {
          try { await sendWhatsApp({to:target.phone,reply:message}); delivery.channel="WhatsApp"; }
          catch(error) { errors.push(`WhatsApp: ${error.message}`); }
        }
        delivery.status=delivery.channel ? "sent" : "failed";
        delivery.error=delivery.channel ? "" : errors.join(" · ") || "Telefon und E-Mail fehlen.";
        if (delivery.channel) delivery.sentAt=now();
        await store(file, record);
      }
      record.sent=record.deliveries.length > 0 && record.deliveries.every(row=>row.status === "sent");
      record.channels=[...new Set(record.deliveries.map(row=>row.channel).filter(Boolean))];
      record.error=record.deliveries.filter(row=>row.error).map(row=>`${row.recipient}: ${row.error}`).join(" · ").slice(0,2000);
      record.status=record.sent ? "sent" : record.channels.length ? "partial" : "failed";
    } catch(error) { record.status="failed"; record.error=String(error.message || error).slice(0,2000); }
    record.completedAt=now(); if (record.sent) record.sentAt=record.completedAt;
    await store(file, record);
    return record;
  }
  function publish(jobId, event) {
    const key=String(jobId), pending=(queues.get(key) || Promise.resolve()).catch(()=>{}).then(()=>dispatch(jobId,event));
    queues.set(key,pending);
    return pending.finally(()=>{if(queues.get(key)===pending)queues.delete(key)});
  }
  async function documents(jobId, before, after) {
    for (const event of documentChanges(before,after)) await publish(jobId,event);
  }
  async function list(jobId) {
    if (!safeJob(jobId)) return [];
    const names=await fs.readdir(folder(jobId)).catch(error=>{if(error.code === "ENOENT")return [];throw error});
    const records=await Promise.all(names.filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>fs.readFile(path.join(folder(jobId),name),"utf8").then(JSON.parse)));
    return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100);
  }
  return { publish, documents, list };
}

module.exports = { createActivityNotifications, documentChanges };
