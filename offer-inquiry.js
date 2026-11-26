"use strict";

const { createHash } = require("node:crypto");
const { parseMsg, getMsgAttachment } = require("./kristine-msg-reader");

function measurements(text) {
  const rows = text.split("\n").map(line => line.trim().split(/\s*\t\s*/));
  const groups = [];
  const add = (area, title, quantity, suggestions, alternative = false) =>
    groups.push({ area, title, quantity: Math.round(quantity * 100) / 100, suggestions, alternative, unit: "m²" });
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

function onlvMeasurements(xml, info = {}) {
  const { SaxesParser } = require("saxes");
  const parser = new SaxesParser({ xmlns: true });
  const stack = [], groups = [];
  let position = null;
  parser.on("doctype", () => { throw new Error("DTD in Leistungsverzeichnis"); });
  parser.on("opentag", tag => {
    const name = tag.local.toLowerCase();
    if(!stack.length&&name!=="onlv")throw new Error("Kein ONLV-Leistungsverzeichnis");
    if(name==="angebots-lv")info.submitted=true;
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
    const parent=stack.at(-1)?.name;
    if(parent==="kenndaten"&&frame.name==="vorhaben")info.projectName=value;
    if(parent==="kenndaten"&&frame.name==="lvcode")info.code=value;
    if(parent==="firma"&&frame.name==="name"&&stack.some(item=>item.name==="auftraggeber"))info.owner=value;
    if(parent==="firma"&&frame.name==="name"&&stack.some(item=>item.name==="lversteller"))info.author=value;
    if(["gesamtpreis","ustsatz","ustbetrag","angebotspreis"].includes(frame.name)&&stack.some(item=>item.name==="summenormalausfuehrung"))info[frame.name]=Number(value.replace(",","."));
    if (!position) return;
    if(parent==="preis"&&frame.name==="gesamt"&&value)position.unitPrice=Number(value.replace(",","."));
    if(parent==="pos-eigenschaften"&&frame.name==="pospreis"&&value)position.lineTotal=Number(value.replace(",","."));
    if (stack.at(-1)?.name === "pos-eigenschaften") {
      if (frame.name === "stichwort") position.title = value;
      if (frame.name === "einheit") position.unit = value;
      if (frame.name === "lvmenge") position.quantity = value;
    }
    if (frame.name !== "pos-eigenschaften") return;
    const quantity = position.quantity ? Number(position.quantity.replace(",", ".")) : NaN;
    if (position.unit && position.title && Number.isFinite(quantity) && quantity >= 0) {
      const group = stack.findLast(item => item.name === "ulg");
      const outer = /außen|aussen|fassade|sockel|wdvs/i.test((group?.title || "") + " " + position.title);
      const number = stack.filter(item => ["og", "lg", "ulg", "grundtextnr"].includes(item.name))
        .map(item => item.number).filter(Boolean).join(".") + (stack.at(-1)?.name === "folgeposition" ? stack.at(-1).number : "");
      groups.push({
        area: outer ? "Außen" : "Innen",
        title: [number, position.title].filter(Boolean).join(" · "),
        quantity,
        unit: position.unit,
        eventual: position.eventual,
        alternative: position.eventual,
        suggestions: [position.title],
        ...(Number.isFinite(position.unitPrice)?{unitPrice:position.unitPrice}:{}),
        ...(Number.isFinite(position.lineTotal)?{lineTotal:position.lineTotal}:{}),
      });
    }
    position = null;
  });
  parser.write(xml).close();
  if(groups.length>250)throw new Error("Das LV enthält mehr als 250 Positionen");
  return groups;
}

function projectDetails(cover, subject, mail = {}) {
  const lines = cover.split(/\r?\n/).map(line => line.trim());
  const find = pattern => lines.findIndex(line => pattern.test(line));
  const value = (index, pattern) => index < 0 ? "" : lines[index].replace(pattern, "").trim();
  const project = find(/^Bauvorhaben:/i), owner = find(/^(Auftraggeber|Bauherrschaft):/i);
  const architect = find(/^(Planung|Architekt(?:urbüro)?):/i);
  const submission = find(/^Angebotsabgabe(?:\/Anschrift)?:/i);
  const address = (street = "", place = "") => {
    const road = street.match(/^([\p{L}][^:\n]*?)\s+(\d+[\p{L}\d/.-]*)$/u);
    const locality = place.match(/^(?:A[- ]?)?(\d{4})\s+([\p{L}][^:\n]*)$/u);
    return locality ? { street: road?.[1] || "", house: road?.[2] || "", postal: locality[1], city: locality[2] } : {};
  };
  const architectLine = value(architect, /^(Planung|Architekt(?:urbüro)?):/i);
  const architectParts = architectLine.match(/^(.*),\s*([^,]+),\s*((?:A[- ]?)?\d{4}\s+.+)$/);
  const signature = String(mail.body || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const architectIndex = signature.findLastIndex(line => /^Architekt(?:in)?\s+(?:DI|Dipl[.-]?Ing\.?)\s+\p{L}/iu.test(line));
  const signer = architectIndex < 0 ? null : signature[architectIndex].match(/^Architekt(?:in)?\s+(DI|Dipl[.-]?Ing\.?)\s+(.+?)\s+(\S+)$/iu);
  const signatureAddress = signer ? address(signature[architectIndex + 1], signature[architectIndex + 2]) : {};
  const signaturePhone = signer && /^\+?[\d ()/-]{7,}$/.test(signature[architectIndex + 3] || "") ? signature[architectIndex + 3] : "";
  const subjectHint = subject?.match(/^(?:EFH|Einfamilienhaus)\s+([\p{L}-]+)\s+([\p{L}-]+)$/iu);
  const reportedDeadline = signature.find(line => /(?:anbot|angebot|abgabe)/i.test(line) && /\bbis\s*\d/i.test(line))?.match(/\bbis\s*(\d{1,2}\.\d{1,2}\.\d{2,4})\b/i)?.[1] || "";
  const reportedStart = signature.find(line => /Ausführung\s+(?:ab|ab ca\.)/i.test(line))?.match(/Ausführung\s+(.+?)\s*\.?$/i)?.[1] || "";
  return {
    name: value(project, /^Bauvorhaben:/i) || subject,
    site: project < 0 ? { city: subjectHint?.[2] || "" } : address(lines[project + 1], lines[project + 2]),
    owner: owner < 0 ? { name: subjectHint?.[1] || "" } : { name: value(owner, /^(Auftraggeber|Bauherrschaft):/i), ...address(lines[owner + 1], lines[owner + 2]) },
    architect: !architectLine && signer ? { title: signer[1], firstName: signer[2], lastName: signer[3], ...signatureAddress, phone: signaturePhone, email: mail.senderEmail || "" } : { name: architectParts?.[1] || architectLine, ...address(architectParts?.[2], architectParts?.[3]), phone: architect < 0 ? "" : (lines[architect + 1]?.match(/^Tel\.?\s*:?\s*(.*)$/i)?.[1] || "") },
    hints: project < 0 && subjectHint ? ["Bauherrschaft und Baustellenort aus dem Betreff vorgeschlagen. Bitte bestätigen."] : [],
    deadline: value(find(/^Angebotsfrist(?:\/Abgabetermin)?:/i), /^Angebotsfrist(?:\/Abgabetermin)?:/i) || reportedDeadline,
    start: value(find(/^Leistungsbeginn:/i), /^Leistungsbeginn:/i) || reportedStart,
    submissionEmail: submission < 0 ? "" : (lines[submission + 1]?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)?.[0] || ""),
  };
}

async function pdfText(buffer, pages) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try { return (await parser.getText({ first: pages })).text.slice(0, 60000); }
  finally { await parser.destroy(); }
}

function readOnlvInquiry(buffer){
  const info={};
  const groups=onlvMeasurements(buffer.toString("utf8"),info);
  if(!groups.length)throw new Error("Das ONLV enthält keine importierbaren Positionen");
  const cent=value=>Math.round(value*100);
  const calculated=groups.filter(group=>!group.eventual).reduce((sum,group)=>sum+cent(group.quantity*(group.unitPrice??0)),0);
  const source=info.gesamtpreis;
  const offer=info.submitted?{net:source,gross:info.angebotspreis,vatRate:info.ustsatz,calculated:calculated/100,
    matches:Number.isFinite(source)&&cent(source)===calculated&&groups.every(group=>Number.isFinite(group.unitPrice))}:null;
  const subject=info.projectName||info.code||"ONLV-Angebot";
  return {subject,project:{name:subject,owner:{name:info.owner},architect:{name:info.author}},offer,
    documents:[{name:info.code||"ONLV",hash:createHash("sha256").update(buffer).digest("hex"),groups,text:""}]};
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
  const structuredDocument = documents.find(document => !document.unreadable);
  if (structuredDocument) {
    const pdf = mail.attachments.find(item => item.name.toLowerCase() === structuredDocument.name.replace(/\.onlv$/i, ".pdf").toLowerCase());
    const cover = pdf ? await pdfText(getMsgAttachment(buffer, pdf.index).content, 1).catch(() => "") : "";
    return { subject: mail.subject, sender: mail.senderName || mail.senderEmail, project: projectDetails(cover || mail.body, mail.subject, mail), documents };
  }
  for (const metadata of mail.attachments.filter(item => /\.pdf$/i.test(item.name)).slice(0, 12)) {
    const attachment = getMsgAttachment(buffer, metadata.index);
    if (!attachment) continue;
    const hash = createHash("sha256").update(attachment.content).digest("hex");
    let source = "";
    try {
      source = await pdfText(attachment.content, 40);
    } catch { /* Keep the attachment listed for manual review. */ }
    documents.push({ name: attachment.name, hash, text: source, groups: measurements(source) });
  }
  return { subject: mail.subject, sender: mail.senderName || mail.senderEmail, project: projectDetails(documents.map(document => document.text).find(text => /^Bauvorhaben:/im.test(text)) || mail.body, mail.subject, mail), documents };
}

module.exports = { readInquiry, readOnlvInquiry, measurements, onlvMeasurements, projectDetails };
