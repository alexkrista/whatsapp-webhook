"use strict";

function deNumber(value) {
  const normalized=String(value||"").replace(/\./g,"").replace(",",".").replace(/[^0-9.-]/g,"");
  const number=Number(normalized);return Number.isFinite(number)?number:0;
}
function isoDate(value) {
  const m=String(value||"").match(/(\d{2})\.(\d{2})\.(\d{4})/);return m?`${m[3]}-${m[2]}-${m[1]}`:"";
}
function parseRegieSummaryText(text) {
  const source=String(text||"").replace(/\r/g,""),batch=source.match(/Rapportaufstellung[^\n]*\nNr\.\s*:\s*([^\s]+)/i)?.[1]||source.match(/Rapportaufstellung\s+(\d{6,})/i)?.[1]||"",starts=[...source.matchAll(/(?:^|\n)Rapport:\s*(\d+)\s+vom\s+(\d{2}\.\d{2}\.\d{4})/g)];
  return starts.map((match,index)=>{const block=source.slice(match.index,starts[index+1]?.index??source.length).split(/(?:^|\n)Gesamtübersicht\s*$/m)[0],employeeMap=new Map(),hourRows=[...block.matchAll(/([\d.,]+)\s+Std\.\s+(.+?)\s+\([^\n)]*\)\s+[\d.,]+\s+([\d.,]+)(?:\s|$)/g)];let totalHours=0;for(const row of hourRows){const hours=deNumber(row[1]),name=String(row[2]||"").trim(),cost=deNumber(row[3]),person=employeeMap.get(name)||{name,hours:0,cost:0};person.hours+=hours;person.cost+=cost;employeeMap.set(name,person);totalHours+=hours}const materialBlock=(block.match(/(?:^|\n)Material\s*\n([\s\S]*?)(?=\nSumme Stunden:)/m)?.[1]||""),materials=[];for(const line of materialBlock.split("\n")){const row=line.trim().match(/^([\d.]+,\d{2})\s+(\S+)\s+(.+?)\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})$/);if(row)materials.push({quantity:deNumber(row[1]),unit:row[2],name:row[3].trim(),unitPrice:deNumber(row[4]),cost:deNumber(row[5])})}const labor=block.match(/Summe Stunden:\s*([\d.,]+)\s*/i)?.[1]||"",material=block.match(/Summe Material:\s*([\d.,]+)\s*/i)?.[1]||"",employeeDetails=[...employeeMap.values()].map(x=>({...x,hours:Math.round(x.hours*100)/100,cost:Math.round(x.cost*100)/100}));return {reportNumber:batch?`${batch}/${match[1]}`:match[1],rapportNumber:match[1],reportDate:isoDate(match[2]),employees:employeeDetails.map(x=>x.name).join(", "),employeeDetails,materials,totalHours:Math.round(totalHours*100)/100,laborTotal:labor?`${labor} EUR`:"",laborCost:deNumber(labor)||Math.round(employeeDetails.reduce((sum,x)=>sum+x.cost,0)*100)/100,materialTotal:material?`${material} EUR`:"",materialCost:deNumber(material),batchNumber:batch}}).filter(row=>row.totalHours||row.employees||row.materialTotal);
}
async function extractRegieReportsFromPdf(buffer) {
  const { PDFParse }=require("pdf-parse"),parser=new PDFParse({data:buffer});
  try { const result=await parser.getText();return parseRegieSummaryText(result.text||""); }
  finally { await parser.destroy(); }
}
module.exports={deNumber,parseRegieSummaryText,extractRegieReportsFromPdf};
