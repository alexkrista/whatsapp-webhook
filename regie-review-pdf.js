"use strict";
const {PDFDocument,StandardFonts,rgb}=require("pdf-lib");
const crypto=require("crypto");
function reviewKey(report){return report?.attachmentUploadToken?crypto.createHmac("sha256",report.attachmentUploadToken).update("regie-review-pdf:"+report.id).digest("hex"):""}
function reviewUrl(report){const key=reviewKey(report);return key?"/kristine/regie-report/"+encodeURIComponent(report.id)+"/review.pdf?key="+key:""}
function authorized(report,key){const expected=reviewKey(report),actual=String(key||"");return !!expected&&actual.length===expected.length&&crypto.timingSafeEqual(Buffer.from(actual),Buffer.from(expected))}
async function createReviewPdf(report){
 const pdf=await PDFDocument.create(),normal=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold),width=595.28,height=841.89,margin=42,pages=[];
 const clean=s=>String(s??"").replace(/[\u0000-\u001f]/g," ").replace(/[^\u0020-\u007e\u00a0-\u00ff\u20ac]/g,"-");
 const number=v=>Number(v||0).toLocaleString("de-AT",{maximumFractionDigits:2});
 let page,y;
 function newPage(){page=pdf.addPage([width,height]);pages.push(page);y=height-margin;page.drawText("FARBEN KRISTA",{x:margin,y,size:14,font:bold,color:rgb(.12,.34,.2)});y-=22}
 function text(value,{heading=false,size=10}={}){
  const font=heading?bold:normal,max=width-2*margin;
  for(const paragraph of String(value??"").split(/\r?\n/)){
   let line="";
   const flush=()=>{if(y<margin+25)newPage();page.drawText(line,{x:margin,y,size,font});y-=size+5;line=""};
   for(const char of clean(paragraph)){if(font.widthOfTextAtSize(line+char,size)>max)flush();line+=char}
   flush();
  }
 }
 newPage();text("Regiebericht "+(report.reportNumber||""),{heading:true,size:19});text("Kontrollausgabe ohne Preise",{heading:true});text("Baustelle: "+report.jobId+" - "+report.jobName);text("Datum: "+String(report.date||"").split("-").reverse().join("."));y-=8;
 text("Durchgeführte Arbeiten",{heading:true,size:12});text(report.description||"-");y-=8;
 text("Mitarbeiter und Arbeitsstunden",{heading:true,size:12});let hours=0;
 for(const employee of report.employees||[]){hours+=Number(employee.hours||0);text((employee.name||employee.employeeName||"Mitarbeiter")+" | "+number(employee.hours)+" Std.",{heading:true});const blocks=employee.bookedBlocks?.length?employee.bookedBlocks:employee.blocks?.length?employee.blocks:[{from:employee.from,to:employee.to}];const times=blocks.filter(b=>b.from).map(b=>b.from+" - "+(b.to||"offen")).join(" / ");if(times)text(times)}
 text("Stunden gesamt: "+number(hours)+" Std.",{heading:true});y-=8;
 text("Material und Mengen",{heading:true,size:12});
 if(!(report.materials||[]).length)text("Kein Material erfasst.");
 for(const material of report.materials||[]){text(material.product||material.name||"Material",{heading:true});text("Menge: "+number(material.quantity)+(Number(material.containerSize)>1?" x "+number(material.containerSize):"")+" "+(material.unit||""));if(material.color)text("Farbton: "+material.color);if(material.component)text("Bauteil: "+material.component)}
 if(report.materialDeliveryNumber)text("Material siehe Lieferschein "+report.materialDeliveryNumber);
 text("Diese Kontrollausgabe enthält Mitarbeiterstunden und Materialmengen ohne Preise.",{size:9});
 pages.forEach((p,i)=>p.drawText("Regiebericht | Seite "+(i+1)+" / "+pages.length,{x:margin,y:24,size:9,font:normal,color:rgb(.35,.4,.35)}));
 return Buffer.from(await pdf.save());
}
module.exports={reviewUrl,authorized,createReviewPdf};
