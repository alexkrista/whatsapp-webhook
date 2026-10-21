"use strict";

/** Printed A4 folder cover. This module never creates or changes projects. */
function clean(value, fallback = "") {
  return String(value == null ? "" : value).replace(/[\r\n\t]+/g, " ").trim() || fallback;
}
function projectContact(row, fallback = "") {
  if (!row || typeof row !== "object") return clean(fallback);
  const person = [row.title, row.firstName, row.lastName].map(x => clean(x)).filter(Boolean).join(" ");
  const family = [row.womanFirstName, row.manFirstName, row.sharedLastName]
    .map(x => clean(x)).filter(Boolean).join(" ");
  return clean(row.customer || row.company || person || family || row.name || fallback);
}
function coverInfo(jobId, meta, taskRows, baseUrl) {
  const m = meta && typeof meta === "object" ? meta : {};
  const contacts = m.projectContacts || {};
  const owner = projectContact(contacts.owner, m.contactName || m.customerMaster?.name);
  const architect = projectContact(contacts.architect);
  const manager = projectContact(contacts.siteManager);
  const address = [
    [m.street, m.houseNumber].map(x => clean(x)).filter(Boolean).join(" "),
    [m.postalCode, m.city].map(x => clean(x)).filter(Boolean).join(" ")
  ].filter(Boolean).join(", ");
  const rows = Array.isArray(taskRows) ? taskRows : [];
  const dates = rows.filter(row => String(row?.jobId || "") === String(jobId) &&
    row.appointment?.date &&
    (row.appointmentPurpose === "offer_site_visit" || /besichtigung|angebotstermin/i.test(String(row.title || ""))))
    .map(row => ({
      date: String(row.appointment.date || "").slice(0, 10),
      from: clean(row.appointment.from),
      to: clean(row.appointment.to),
      title: clean(row.title),
    })).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  const intake = m.intakeAppointment;
  if (intake && /^\d{4}-\d{2}-\d{2}$/.test(String(intake.date || "")) && !dates.length) {
    dates.push({ date: String(intake.date).slice(0, 10), from: clean(intake.from), to: clean(intake.to), title: "Besichtigung" });
  }
  const current = new Date().toISOString().slice(0, 10);
  const ordered = dates.sort((a, b) => a.date.localeCompare(b.date));
  const appointment = ordered.find(a => a.date >= current) || ordered.at(-1) || null;
  const base = String(baseUrl || "https://protokoll.krista.at").replace(/\/$/, "");
  return {
    jobId: String(jobId),
    name: clean(m.name, "Noch keine Bezeichnung"),
    status: clean(m.status, "Angebot"),
    address: clean(address),
    owner, architect, manager, appointment,
    qrUrl: base + "/kristine/baustellen#" + encodeURIComponent(String(jobId)),
  };
}
function pdfText(text) {
  return clean(text).replace(/[^\u0020-\u00FF]/g, "-").slice(0, 500);
}
function pdfField(page, font, bold, x, y, label, value, width, pdfLib) {
  const { rgb } = pdfLib;
  const heading = pdfText(label).toUpperCase();
  page.drawText(heading, { x, y, size: 9.5, font: bold, color: rgb(.39, .47, .45) });
  const text = pdfText(value || "Noch nicht erfasst");
  const fontSize = 14;
  const words = text.split(/\s+/);
  const lines = []; let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(next, fontSize) > width && line) {
      lines.push(line); line = word;
      if (lines.length >= 2) break;
    } else line = next;
  }
  if (line && lines.length < 2) lines.push(line);
  for (let i = 0; i < lines.length; i++) {
    let current = lines[i];
    while (current && font.widthOfTextAtSize(current, fontSize) > width) current = current.slice(0, -1);
    page.drawText(current || "-", { x, y: y - 20 - 19 * i, size: fontSize, font,
      color: rgb(.12, .18, .17) });
  }
  page.drawLine({ start: { x, y: y - 52 }, end: { x: x + width, y: y - 52 },
    thickness: .7, color: rgb(.84, .87, .85) });
}
function dateText(appointment) {
  if (!appointment) return "Noch nicht vereinbart";
  const [year,month,day] = appointment.date.split("-");
  const time = appointment.from ? "  " + appointment.from + (appointment.to ? " - " + appointment.to : "") + " Uhr" : "";
  return day + "." + month + "." + year + time;
}
async function createCoverPdf({jobId, meta, tasks, publicBaseUrl}) {
  const info = coverInfo(jobId, meta, tasks, publicBaseUrl);
  const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
  const QRCode = require("qrcode");
  const fs = require("node:fs");
  const path = require("node:path");
  const pdf = await PDFDocument.create();
  pdf.setTitle("Baustellenmappe " + info.jobId + " - Deckblatt");
  pdf.setAuthor("Farben Krista GmbH & Co KG");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89;
  const page = pdf.addPage([W,H]);

  const ink = rgb(.11,.25,.20);
  const navy = rgb(.02,.32,.45);
  const muted = rgb(.33,.43,.40);
  // Actual KRISTA logo from the project assets, never a substitute wordmark.
  // A missing logo is an error, not a reason to print a misleading blank cover.
  const logoBytes = fs.readFileSync(path.join(__dirname,"krista-logo.png"));
  const logo = await pdf.embedPng(logoBytes);
  const logoWidth = 238;
  page.drawImage(logo,{x:52,y:746,width:logoWidth,height:logoWidth*logo.height/logo.width});
  page.drawText("BAUSTELLENMAPPE",{x:339,y:799,size:12,font:bold,color:navy});
  page.drawText("BAUSTELLENNUMMER",{x:339,y:778,size:8.5,font:bold,color:muted});
  const number = pdfText(info.jobId);
  let fontSize = 28;
  while(fontSize>14 && bold.widthOfTextAtSize(number,fontSize)>202)fontSize--;
  page.drawText(number,{x:339,y:742,size:fontSize,font:bold,color:ink});
  page.drawLine({start:{x:52,y:734},end:{x:543,y:734},
    color:navy,thickness:3.2});

  // The complete site identity sits in the upper area of the sheet.
  page.drawRectangle({x:52,y:658,width:491,height:63,color:rgb(.936,.959,.951)});
  page.drawText("PROJEKT / ANGEBOTSBESICHTIGUNG",
    {x:64,y:703,size:9,font:bold,color:muted});
  let title=pdfText(info.name);
  while(title && bold.widthOfTextAtSize(title,22)>462)title=title.slice(0,-1);
  page.drawText(title||"-",{x:64,y:671,size:22,font:bold,color:ink});

  const x=52, leftWidth=328;
  pdfField(page,regular,bold,x,628,"Baustellenadresse",info.address,leftWidth,{rgb});
  pdfField(page,regular,bold,x,567,"Bauherr / Auftraggeber",info.owner,leftWidth,{rgb});
  pdfField(page,regular,bold,x,506,"Architekt",info.architect,leftWidth,{rgb});
  pdfField(page,regular,bold,x,445,"Bauleiter",info.manager,leftWidth,{rgb});
  pdfField(page,regular,bold,x,384,"Besichtigungstermin",dateText(info.appointment),485,{rgb});

  // Token-free, stable QR to the exact site. Login stays required on KRISTINE.
  const qrPng = await QRCode.toBuffer(info.qrUrl,{
    type:"png",width:448,margin:2,errorCorrectionLevel:"Q",
    color:{dark:"#005679",light:"#FFFFFFFF"}
  });
  const qrImage=await pdf.embedPng(qrPng);
  page.drawRectangle({x:401,y:477,width:141,height:141,
    color:rgb(1,1,1),borderColor:rgb(.78,.84,.82),borderWidth:.7});
  page.drawImage(qrImage,{x:405,y:481,width:133,height:133});
  page.drawText("DIREKT ZUR BAUSTELLE",
    {x:402,y:462,size:7.9,font:bold,color:navy});
  page.drawText("KRISTINE-ANMELDUNG",{x:405,y:450,size:7,font:regular,color:muted});

  // Leave the rest of the A4 sheet clear for handwritten notes on the folder.
  page.drawText("NOTIZEN / ERGAENZUNGEN",{x:52,y:297,size:10,font:bold,color:muted});
  for(let y=265;y>=75;y-=36){
    page.drawLine({start:{x:52,y},end:{x:543,y},thickness:.55,
      color:rgb(.85,.88,.86)});
  }
  page.drawText("Daten werden beim erneuten Drucken aus der KRISTINE-Baustelle übernommen.",
    {x:52,y:38,size:8,font:regular,color:muted});
  return Buffer.from(await pdf.save());
}
module.exports = {coverInfo,dateText,createCoverPdf};
