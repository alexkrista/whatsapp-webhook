"use strict";

const fs = require("node:fs");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const A4 = [595.28, 841.89];
const clean = value => String(value ?? "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const number = (value, digits = 2) => Number(value || 0).toLocaleString("de-AT", { minimumFractionDigits:digits, maximumFractionDigits:digits });
const money = value => `EUR ${number(value)}`;
const safeDate = value => {
  const date = value && Number.isFinite(Date.parse(value)) ? new Date(value) : new Date();
  return date.toLocaleDateString("de-AT");
};

function offerTotals(draft) {
  const positions=(Array.isArray(draft?.positions)?draft.positions:[]).filter(row=>row?.isAlternative!==true&&Number(row?.quantity)>0);
  const base=positions.reduce((sum,row)=>sum+Number(row.quantity||0)*Number(row.unitPrice||0),0),discounts=draft?.groupDiscounts&&typeof draft.groupDiscounts==="object"?draft.groupDiscounts:{},groups=[...new Set(positions.map(row=>clean(row.groupName)).filter(Boolean))];
  const groupDiscount=groups.reduce((sum,group)=>{const subtotal=positions.filter(row=>clean(row.groupName)===group).reduce((value,row)=>value+Number(row.quantity||0)*Number(row.unitPrice||0),0);return sum+subtotal*Math.max(0,Math.min(100,Number(discounts[group])||0))/100},0),finance=draft?.financials||{},afterGroups=Math.max(0,base-groupDiscount),globalDiscount=afterGroups*Math.max(0,Math.min(100,Number(finance.discountPercent)||0))/100,after=Math.max(0,afterGroups-globalDiscount),vatRate=Math.max(0,Math.min(100,Number(finance.vatRate??20)||0)),net=finance.priceMode==="gross"?after/(1+vatRate/100):after,vat=finance.priceMode==="gross"?after-net:net*vatRate/100,gross=finance.priceMode==="gross"?after:net+vat;
  return {positions,base,groupDiscount,globalDiscount,net,vat,vatRate,gross};
}

async function createCustomerOfferPdf({draft={},meta={},logoPath=""}={}) {
  const pdf=await PDFDocument.create(),regular=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold),green=rgb(.22,.38,.25),muted=rgb(.38,.42,.39),line=rgb(.81,.83,.80),pale=rgb(.94,.96,.93),totals=offerTotals(draft),left=42,right=553,contentWidth=right-left;
  let logo=null;try{if(logoPath&&fs.existsSync(logoPath))logo=await pdf.embedPng(fs.readFileSync(logoPath))}catch{}
  let page,y;
  const textWidth=(text,font,size)=>font.widthOfTextAtSize(clean(text),size);
  const drawRight=(text,x,yPos,font=regular,size=9,color=rgb(.12,.15,.13))=>page.drawText(clean(text),{x:x-textWidth(text,font,size),y:yPos,font,size,color});
  const wrap=(text,font,size,maxWidth)=>{const words=clean(text).split(" ").filter(Boolean),rows=[];let row="";for(const word of words){const next=row?row+" "+word:word;if(textWidth(next,font,size)<=maxWidth)row=next;else{if(row)rows.push(row);row=word}}if(row)rows.push(row);return rows.length?rows:[""]};
  const footer=()=>{page.drawLine({start:{x:left,y:45},end:{x:right,y:45},thickness:.7,color:rgb(.25,.31,.26)});page.drawText("Farben Krista GmbH & Co KG | Feldkircherstraße 45 | 6820 Frastanz",{x:left,y:30,size:6.5,font:regular,color:muted});drawRight(`Seite ${pdf.getPageCount()}`,right,30,regular,6.5,muted)};
  const addPage=(continuation=false)=>{if(page)footer();page=pdf.addPage(A4);y=786;if(logo){const scale=logo.scale(.22);page.drawImage(logo,{x:right-scale.width,y:755,width:scale.width,height:scale.height})}else page.drawText("krista",{x:475,y:770,size:28,font:bold,color:rgb(.12,.32,.5)});if(continuation){page.drawText(`Angebot ${clean(draft.offerNumber)}`,{x:left,y:780,size:10,font:bold,color:green});y=742}};
  addPage(false);
  const portal=meta.customerPortal||{},master=draft.customerMaster||{},recipient=clean(master.name||portal.customerName||meta.customerName||meta.name||"Kundin / Kunde"),street=clean(master.street||meta.customerStreet||meta.street||""),house=clean(master.houseNumber||meta.customerHouseNumber||meta.houseNumber||""),postal=clean(master.postalCode||meta.customerPostalCode||meta.postalCode||""),city=clean(master.city||meta.customerCity||meta.city||""),projectAddress=[meta.street,meta.houseNumber,meta.postalCode,meta.city].map(clean).filter(Boolean).join(" ");
  page.drawText(recipient,{x:left,y:690,size:10,font:bold});if(street)page.drawText([street,house].filter(Boolean).join(" "),{x:left,y:674,size:9,font:regular});if(postal||city)page.drawText([postal,city].filter(Boolean).join(" "),{x:left,y:659,size:9,font:regular});
  page.drawText(`Projekt: ${clean(meta.jobId||draft.projectNumber||"")}`,{x:337,y:690,size:10,font:bold});for(const [index,row] of wrap(clean(meta.name||draft.projectName||""),regular,8.5,210).slice(0,2).entries())page.drawText(row,{x:337,y:674-index*13,size:8.5,font:regular});if(projectAddress)page.drawText(projectAddress.slice(0,55),{x:337,y:646,size:8,font:regular,color:muted});
  y=590;page.drawText("Angebot",{x:left,y,size:22,font:bold});drawRight(`Frastanz, ${safeDate(draft.offerCreatedAt||draft.updatedAt)}`,right,y+2,regular,9);page.drawLine({start:{x:left,y:y-5},end:{x:right,y:y-5},thickness:1.8,color:rgb(.12,.15,.13)});page.drawText(`Nr.: ${clean(draft.offerNumber||"")}`,{x:left,y:y-21,size:9,font:bold});y-=58;
  const intro=clean(draft.intro||"Wir haben die auszuführenden Arbeiten vor Ort besichtigt und besprochen.");for(const row of wrap(intro,regular,9,contentWidth)){page.drawText(row,{x:left,y,size:9,font:regular});y-=13}y-=12;
  const widths=[28,287,55,68,73],xs=[left,left+28,left+315,left+370,left+438,right];
  const tableHeader=()=>{page.drawText("Pos.",{x:xs[0]+3,y,size:8,font:bold});page.drawText("Leistung",{x:xs[1]+3,y,size:8,font:bold});drawRight("Menge",xs[3]-3,y,bold,8);drawRight("Einzelpreis",xs[4]-3,y,bold,8);drawRight("Gesamt",xs[5]-3,y,bold,8);y-=8;page.drawLine({start:{x:left,y},end:{x:right,y},thickness:.7,color:line});y-=17};
  tableHeader();let currentGroup="",groupNumber=0,positionNumber=0;
  for(const row of totals.positions){const group=clean(row.groupName||"Leistungen");if(group!==currentGroup){if(y<150){addPage(true);tableHeader()}currentGroup=group;groupNumber++;positionNumber=0;page.drawRectangle({x:left,y:y-6,width:contentWidth,height:23,color:pale});page.drawText(`${groupNumber}.0`,{x:xs[0]+3,y,size:8.5,font:bold});page.drawText(group,{x:xs[1]+3,y,size:9,font:bold});y-=29}positionNumber++;const description=wrap(row.text||"Leistung",regular,8.2,widths[1]-9),height=Math.max(25,description.length*11+9);if(y-height<92){addPage(true);tableHeader()}page.drawText(`${groupNumber}.${positionNumber}`,{x:xs[0]+3,y,size:8,font:regular});description.forEach((text,index)=>page.drawText(text,{x:xs[1]+3,y:y-index*11,size:8.2,font:regular}));drawRight(`${number(row.quantity)} ${clean(row.unit)}`,xs[3]-3,y,regular,8);drawRight(money(row.unitPrice),xs[4]-3,y,regular,8);drawRight(money(Number(row.quantity)*Number(row.unitPrice)),xs[5]-3,y,regular,8);y-=height;page.drawLine({start:{x:left,y:y+7},end:{x:right,y:y+7},thickness:.4,color:line})}
  if(y<210)addPage(true);y-=12;const totalRows=[["Rabatt",totals.groupDiscount+totals.globalDiscount],["Summe netto",totals.net],[`MwSt. ${number(totals.vatRate)} %`,totals.vat],["Angebotssumme brutto",totals.gross]];for(const [index,[label,value]] of totalRows.entries()){if(!value&&index===0)continue;const isGross=label==="Angebotssumme brutto";if(isGross)page.drawLine({start:{x:365,y:y+11},end:{x:right,y:y+11},thickness:1.5,color:green});drawRight(label,468,y,isGross?bold:regular,isGross?9.5:9);drawRight(`${index===0?"- ":""}${money(value)}`,right,y,isGross?bold:regular,isGross?9.5:9);y-=22}
  if(y<180)addPage(true);y-=16;for(const paragraph of ["Wir sichern Ihnen eine fachgerechte, sorgfältige und termingerechte Ausführung der beschriebenen Leistungen zu.","Wir freuen uns, dieses Projekt für Sie umsetzen zu dürfen, und stehen für Rückfragen oder ergänzende Abstimmungen jederzeit gerne zur Verfügung."]){for(const row of wrap(paragraph,regular,9,contentWidth)){page.drawText(row,{x:left,y,size:9,font:regular});y-=13}y-=11}page.drawText("Mit freundlichen Grüßen",{x:left,y:y-4,size:9,font:bold});page.drawText("Ihr KRISTA-Team",{x:left,y:y-20,size:9,font:bold});
  footer();const pages=pdf.getPages(),count=pages.length;pages.forEach((current,index)=>{const label=`Seite ${index+1} / ${count}`,width=regular.widthOfTextAtSize(label,6.5);current.drawRectangle({x:right-55,y:24,width:58,height:12,color:rgb(1,1,1)});current.drawText(label,{x:right-width,y:30,size:6.5,font:regular,color:muted})});
  return Buffer.from(await pdf.save());
}

module.exports={createCustomerOfferPdf,offerTotals};
