"use strict";

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const A4 = [595.28, 841.89];
const ink = rgb(0.05, 0.05, 0.05);
const grey = rgb(0.35, 0.35, 0.35);
const clean = value => String(value ?? "").replace(/[–—]/g, "-").replace(/[^ -~ -ÿ]/g, "?");
const pad2 = value => String(value).padStart(2, "0");
const deDate = value => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.` : String(value || "");
};
const monthLabel = value => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("de-AT", { month: "long", year: "numeric" }).format(date);
};
const hm = minutes => {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  return `${pad2(Math.floor(value / 60))}:${pad2(value % 60)}`;
};
const decimal = minutes => (Number(minutes || 0) / 60).toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedDecimal = minutes => {
  const value = Number(minutes || 0);
  return `${value > 0 ? "" : value < 0 ? "-" : ""}${decimal(Math.abs(value))}`;
};

async function createKriszeitMonthlyPdf(payload = {}) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const people = Array.isArray(payload.people) ? payload.people.slice(0, 250) : [];
  const generated = new Date().toLocaleString("de-AT");

  for (const person of people) {
    const page = pdf.addPage(A4);
    const width = page.getWidth();
    const left = 44;
    const right = width - 44;
    let y = 803;
    const text = (value, x, yy, size = 7, font = regular, color = ink) => page.drawText(clean(value), { x, y: yy, size, font, color });
    const rule = (yy, thickness = 0.45) => page.drawLine({ start: { x: left, y: yy }, end: { x: right, y: yy }, thickness, color: ink });

    text("PZE Monatsübersicht UNKONTROLLIERT", left, y, 9, bold);
    text(clean(payload.company || "Farben Krista GmbH & Co KG, 6820 Frastanz"), 365, y, 7.5, regular);
    rule(y - 4, 0.55);
    y -= 27;
    text(`${person.name || person.employeeId || "Mitarbeiter"} (${person.personnelNumber || "-"})`, left, y, 11, bold);
    text(monthLabel(payload.from), 264, y, 10.5, bold);
    text(person.modelLabel || "Arbeitszeitmodell", 445, y, 9, bold);
    y -= 24;

    const columns = [
      ["Datum", 44], ["TP", 95], ["Von", 118], ["Bis", 151], ["Dauer", 183], ["", 220],
      ["IstStd", 277], ["Soll", 313], ["Glz", 341], ["JahresU", 365], ["FT", 405],
      ["Urlaub", 427], ["Arzt", 455], ["Krank", 478], ["Schule", 506], ["SonUrl", 540]
    ];
    columns.forEach(([label, x]) => text(label, x, y, 6.4, bold));
    rule(y - 3, 0.55);
    y -= 14;

    const days = Array.isArray(person.days) ? person.days : [];
    let weekly = { actual: 0, target: 0, balance: 0, vacation: 0 };
    const drawWeek = label => {
      rule(y + 6, 0.45);
      text(label, left, y, 6.7, bold);
      if (weekly.actual) text(hm(weekly.actual), 277, y, 6.7, bold);
      if (weekly.target) text(hm(weekly.target), 313, y, 6.7, bold);
      if (weekly.balance) text(signedDecimal(weekly.balance), 341, y, 6.7, bold);
      if (weekly.vacation) text(decimal(weekly.vacation * 60), 427, y, 6.7, bold);
      rule(y - 3, 0.45);
      y -= 14;
      weekly = { actual: 0, target: 0, balance: 0, vacation: 0 };
    };

    for (const day of days) {
      const blocks = Array.isArray(day.printBlocks) ? day.printBlocks : (Array.isArray(day.blocks) ? day.blocks : []);
      const rowCount = Math.max(1, blocks.length);
      const firstBlock = blocks[0] || {};
      text(`${day.weekday || ""}   ${deDate(day.date)}`, left, y, 6.8);
      text(day.tp || "", 97, y, 6.6);
      if (firstBlock.from) text(firstBlock.from, 118, y, 6.7);
      if (firstBlock.to) text(firstBlock.to, 151, y, 6.7);
      if (firstBlock.durationMinutes) text(hm(firstBlock.durationMinutes), 183, y, 6.7);
      if (day.label) text(day.label, 220, y, 6.7);
      if (day.payrollMinutes) text(hm(day.payrollMinutes), 277, y, 6.7);
      if (day.targetMinutes) text(hm(day.targetMinutes), 313, y, 6.7);
      if (day.targetMinutes || day.payrollMinutes) text(signedDecimal(Number(day.payrollMinutes||0)-Number(day.targetMinutes||0)), 341, y, 6.7);
      if (day.yearLeave) text(String(day.yearLeave).replace(".", ","), 369, y, 6.7);
      if (day.holiday) text(String(day.holiday).replace(".", ","), 408, y, 6.7);
      if (day.vacation) text(String(day.vacation).replace(".", ","), 430, y, 6.7);
      if (day.doctor) text(String(day.doctor).replace(".", ","), 458, y, 6.7);
      if (day.sick) text(String(day.sick).replace(".", ","), 481, y, 6.7);
      if (day.school) text(String(day.school).replace(".", ","), 509, y, 6.7);
      if (day.specialLeave) text(String(day.specialLeave).replace(".", ","), 543, y, 6.7);
      y -= 10;
      for (let index = 1; index < rowCount; index += 1) {
        const block = blocks[index];
        text(block.from || "", 118, y, 6.7);
        text(block.to || "", 151, y, 6.7);
        if (block.durationMinutes) text(hm(block.durationMinutes), 183, y, 6.7);
        y -= 10;
      }
      weekly.actual += Number(day.payrollMinutes || 0);
      weekly.target += Number(day.targetMinutes || 0);
      weekly.balance += Number(day.payrollMinutes || 0) - Number(day.targetMinutes || 0);
      weekly.vacation += Number(day.vacation || 0);
      if (day.weekday === "So" || day === days[days.length - 1]) drawWeek(`KW ${day.week || ""}`);
    }

    const totals = person.totals || {};
    y -= 3;
    rule(y + 6, 0.55);
    text(monthLabel(payload.from), left, y, 7, bold);
    text(hm(totals.payrollMinutes), 277, y, 7, bold);
    text(hm(totals.targetMinutes), 313, y, 7, bold);
    text(signedDecimal(totals.balanceMinutes), 341, y, 7, bold);
    if (totals.vacation) text(decimal(Number(totals.vacation) * 60), 427, y, 7, bold);
    if (totals.sick) text(decimal(Number(totals.sick) * 60), 478, y, 7, bold);
    y -= 14;
    text("Neuer Saldo", left, y, 7.2, bold);
    text(hm(totals.payrollMinutes), 277, y, 7.2, bold);
    text(hm(totals.targetMinutes), 313, y, 7.2, bold);
    text(signedDecimal(totals.balanceMinutes), 341, y, 7.2, bold);
    rule(y - 3, 0.7);

    y -= 27;
    text("Weitere Salden", left, y, 6.7);
    [["B intern",277],["B extern",313],["Anw",349],["AnsprU",382],["M Z10%",422],["M Z50%",461],["V Z50%",500]].forEach(([label,x])=>text(label,x,y,6.3));
    rule(y - 3, 0.4);

    text("Unkontrollierte / nicht freigegebene Stunden", 205, 105, 8.5, bold);
    rule(32, 0.45);
    text(`${generated} / kriszeit-monatsuebersicht`, left, 20, 6.5, regular, grey);
    text(`- ${pdf.getPageCount()} -`, 289, 20, 6.5, regular, grey);
    text("KRISZEIT", right - 43, 20, 6.5, regular, grey);

    if (Number(totals.zaOldMinutes || 0) > 0) {
      const zaPage = pdf.addPage(A4);
      const zText = (value, x, yy, size = 8, font = regular, color = ink) => zaPage.drawText(clean(value), { x, y: yy, size, font, color });
      const zRule = (yy, thickness = 0.45) => zaPage.drawLine({ start:{x:left,y:yy}, end:{x:right,y:yy}, thickness, color:ink });
      let zy=803;
      zText("PZE Monatsübersicht - ZA alt",left,zy,10,bold);zText(clean(payload.company||"Farben Krista GmbH & Co KG, 6820 Frastanz"),365,zy,7.5);zRule(zy-4,.55);zy-=27;
      zText(`${person.name || person.employeeId || "Mitarbeiter"} (${person.personnelNumber || "-"})`,left,zy,11,bold);zText(monthLabel(payload.from),264,zy,10.5,bold);zy-=25;
      [["Datum",44],["Tag",112],["Echte Zeit",155],["Hauptblatt",235],["ZA alt",320],["Regel",395]].forEach(([label,x])=>zText(label,x,zy,7,bold));zRule(zy-3,.55);zy-=16;
      for(const day of days.filter(item=>Number(item.zaOldMinutes||0)>0)){
        zText(deDate(day.date),44,zy);zText(day.weekday||"",112,zy);zText(hm(day.actualMinutes),155,zy);zText(hm(day.payrollMinutes),235,zy);zText(hm(day.zaOldMinutes),320,zy,8,bold);zText(day.weekday==="So"?"Sonntag bis 0":day.weekday==="Sa"?"Samstag min. 1:00":person.isBuak?(day.weekday==="Fr"?"BUAK min. 3:02":"BUAK min. 9:02"):"Standard min. 6:02",395,zy);zRule(zy-4,.25);zy-=16;
      }
      zy-=5;zRule(zy+8,.55);zText("Summe",44,zy,8.5,bold);zText(hm(totals.actualMinutes),155,zy,8.5,bold);zText(hm(totals.payrollMinutes),235,zy,8.5,bold);zText(hm(totals.zaOldMinutes),320,zy,8.5,bold);zRule(zy-4,.7);
      zText("Hauptblatt + ZA alt = echte Gesamtzeit",190,105,9,bold);zRule(32,.45);zText(`${generated} / kriszeit-za-alt`,left,20,6.5,regular,grey);zText(`- ${pdf.getPageCount()} -`,289,20,6.5,regular,grey);zText("KRISZEIT",right-43,20,6.5,regular,grey);
    }
  }

  return Buffer.from(await pdf.save());
}

module.exports = { createKriszeitMonthlyPdf };
