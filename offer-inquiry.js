"use strict";

const { createHash } = require("node:crypto");
const { parseMsg, getMsgAttachment } = require("./kristine-msg-reader");

function measurements(text) {
  const rows = text.split("\n").map(line => line.trim().split(/\s*\t\s*/));
  const groups = [];
  const add = (area, title, quantity, suggestions, alternative = false) =>
    groups.push({ area, title, quantity: Math.round(quantity * 100) / 100, suggestions, alternative });
  const number = cell => /^\d+(?:[,.]\d+)?$/.test(cell || "") ? Number(cell.replace(",", ".")) : NaN;
  const header = (row, pattern) => /^\d+(?:\.\d+)*$/.test(row[0]) && pattern.test(row[1] || "");
  if (/Kalkputz/i.test(text) && /Türleibung.*Fensterleibungen.*Decke/i.test(text)) {
    let concrete = 0, ceiling = 0, drywall = 0, floor = "";
    for (const row of rows) {
      if (header(row, /^(KG|EG|DG)$/i)) { floor = row[1].toUpperCase(); continue; }
      if (!floor || !/^\p{L}/u.test(row[0]) || !Number.isFinite(number(row[1]))) continue;
      const amounts = row.slice(1).map(number);
      if (amounts.some(value => !Number.isFinite(value))) continue;
      if (floor === "KG") {
        if (amounts.length !== 3 && amounts.length !== 4) continue;
        concrete += amounts.slice(0, -1).reduce((sum, value) => sum + value, 0);
        ceiling += amounts.at(-1);
      } else if (amounts.length <= 3) drywall += amounts.reduce((sum, value) => sum + value, 0);
    }
    if (concrete) add("Innen", "KG · Betonwände inkl. Leibungen", concrete, ["Kalkdünnputz auf Betonwänden"]);
    if (ceiling) add("Innen", "KG · Betondecken", ceiling, ["Kalkdünnputz auf Betondecken"]);
    if (drywall) add("Innen", "EG und DG · Gipskartonwände inkl. Leibungen", drywall, ["Kalkdünnputz auf Gipskartonwänden"]);
    if (/geglättet.*Dispersionsanstrich/i.test(text)) {
      if (concrete) add("Innen", "Variante · Betonwände", concrete, ["Glätte auf Betonwänden"], true);
      if (ceiling) add("Innen", "Variante · Betondecken", ceiling, ["Glätte auf Betondecken"], true);
      if (drywall) add("Innen", "Variante · Gipskartonwände", drywall, ["Q3-Spachtelung auf Gipskartonwänden"], true);
      if (concrete + ceiling + drywall) add("Innen", "Variante · Gesamte Innenfläche", concrete + ceiling + drywall, ["Dispersionsanstrich auf allen geglätteten Flächen"], true);
    }
  }
  if (/Aussenputzarbeiten|Außenputzarbeiten/i.test(text) && rows.filter(row => header(row, /^Sockelbereich$/i)).length >= 2) {
    const surface = rows.filter(row => /^(westen|osten|süden|norden)$/i.test(row[0]))
      .reduce((sum, row) => sum + (number(row[1]) || 0), 0);
    if (surface) add("Außen", "Sockel · gemeinsame Aufmaßfläche", surface, [
      "Sockelplatte gemäß Anfrage liefern und montieren",
      "Sockelbeschichtung passend zum Putzsystem",
    ]);
  }
  return groups;
}

function onlvMeasurements(xml) {
  const { SaxesParser } = require("saxes");
  const parser = new SaxesParser({ xmlns: true });
  const stack = [], groups = [];
  let position = null;
  parser.on("doctype", () => { throw new Error("DTD in Leistungsverzeichnis"); });
  parser.on("opentag", tag => {
    const name = tag.local.toLowerCase();
    const attr = key => Object.values(tag.attributes).find(value => value.local === key)?.value || "";
    const frame = { name, number: attr(name === "folgeposition" ? "ftnr" : "nr"), text: "" };
    stack.push(frame);
    if (name === "pos-eigenschaften") position = { title: "", unit: "", quantity: "", eventual: false };
    if (position && stack.at(-2)?.name === "pzzv" && /eventual|bedarf/.test(name)) position.eventual = true;
  });
  const readText = value => { if (stack.length) stack.at(-1).text += value; };
  parser.on("text", readText);
  parser.on("cdata", readText);
  parser.on("closetag", () => {
    const frame = stack.pop();
    const value = frame.text.trim();
    if (frame.name === "ueberschrift" && stack.at(-1)?.name === "ulg-eigenschaften") {
      const group = stack.findLast(item => item.name === "ulg");
      if (group) group.title = value;
    }
    if (!position) return;
    if (stack.at(-1)?.name === "pos-eigenschaften") {
      if (frame.name === "stichwort") position.title = value;
      if (frame.name === "einheit") position.unit = value;
      if (frame.name === "lvmenge") position.quantity = value;
    }
    if (frame.name !== "pos-eigenschaften") return;
    const quantity = position.quantity ? Number(position.quantity.replace(",", ".")) : NaN;
    if (/^(?:m²|m2|qmt)$/i.test(position.unit) && position.title && Number.isFinite(quantity) && quantity >= 0) {
      const group = stack.findLast(item => item.name === "ulg");
      const outer = /außen|aussen|fassade|sockel/i.test((group?.title || "") + " " + position.title);
      const number = stack.filter(item => ["og", "lg", "ulg", "grundtextnr"].includes(item.name))
        .map(item => item.number).filter(Boolean).join(".") + (stack.at(-1)?.name === "folgeposition" ? stack.at(-1).number : "");
      groups.push({
        area: outer ? "Außen" : "Innen",
        title: [number, position.title].filter(Boolean).join(" · "),
        quantity,
        eventual: position.eventual,
        alternative: position.eventual,
        suggestions: [position.title],
      });
    }
    position = null;
  });
  parser.write(xml).close();
  return groups.slice(0, 250);
}

async function readInquiry(buffer) {
  const { mail } = parseMsg(buffer);
  const documents = [];
  const structured = mail.attachments.filter(item => /\.onlv$/i.test(item.name)).slice(0, 12);
  for (const metadata of structured) {
    const attachment = getMsgAttachment(buffer, metadata.index);
    if (!attachment) continue;
    const hash = createHash("sha256").update(attachment.content).digest("hex");
    try {
      const groups = onlvMeasurements(attachment.content.toString("utf8"));
      documents.push({ name: attachment.name, hash, groups, text: "" });
    } catch {
      documents.push({ name: attachment.name, hash, groups: [], text: "", unreadable: true });
    }
  }
  if (documents.some(document => !document.unreadable)) {
    return { subject: mail.subject, sender: mail.senderName || mail.senderEmail, body: mail.body.slice(0, 20000), documents };
  }
  for (const metadata of mail.attachments.filter(item => /\.pdf$/i.test(item.name)).slice(0, 12)) {
    const attachment = getMsgAttachment(buffer, metadata.index);
    if (!attachment) continue;
    const hash = createHash("sha256").update(attachment.content).digest("hex");
    let source = "";
    try {
      const { PDFParse } = require("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(attachment.content) });
      try { source = (await parser.getText({ first: 40 })).text.slice(0, 60000); }
      finally { await parser.destroy(); }
    } catch { /* Keep the attachment listed for manual review. */ }
    documents.push({ name: attachment.name, hash, text: source, groups: measurements(source) });
  }
  return { subject: mail.subject, sender: mail.senderName || mail.senderEmail, body: mail.body.slice(0, 20000), documents };
}

module.exports = { readInquiry, measurements, onlvMeasurements };
