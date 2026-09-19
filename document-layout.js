"use strict";
const fs=require("node:fs/promises"),path=require("node:path"),crypto=require("node:crypto");
const DEFAULTS=require("./document-layout-defaults.json");
const clone=value=>JSON.parse(JSON.stringify(value));
function cleanLayout(value={}){
  const out=clone(DEFAULTS);
  const number=(object,key,fallback,min,max)=>{const value=Number(object?.[key]??fallback);if(!Number.isFinite(value)||value<min||value>max)throw Object.assign(new Error(`Ungültiger Wert für ${key} (${min}–${max}).`),{status:400});return Math.round(value*10000)/10000};
  for(const [key,min,max] of [["fontSizePt",8,13],["titleSizePt",12,24],["lineHeight",1.1,1.8],["paragraphGapMm",1,10],["sectionGapMm",1,20],["rowPaddingMm",0,4]])out[key]=number(value,key,out[key],min,max);
  for(const key of ["firstPage","followingPages"]){
    const page=out[key],source=value[key]||{};
    for(const [field,min,max] of [["topMm",10,40],["leftMm",10,28],["rightMm",10,28],["bottomMm",25,40],["logoWidthMm",20,80]])page[field]=number(source,field,page[field],min,max);
  }
  for(const [key,min,max] of [["addressTopMm",32,60],["addressHeightMm",20,35],["bodyTopMm",60,105]])out.firstPage[key]=number(value.firstPage,key,out.firstPage[key],min,max);
  if(out.firstPage.bodyTopMm<out.firstPage.addressTopMm+out.firstPage.addressHeightMm+3)throw Object.assign(new Error("Zwischen Anschrift und Dokumenttitel müssen mindestens 3 mm bleiben."),{status:400});
  // Identical text width keeps a flowing table aligned across all pages.
  out.followingPages.leftMm=out.firstPage.leftMm;out.followingPages.rightMm=out.firstPage.rightMm;
  out.revision=crypto.createHash("sha256").update(JSON.stringify(out)).digest("hex").slice(0,16);
  return out;
}
function layoutPath(dataDir){return path.join(dataDir,"_system","document-layout.json")}
async function readLayout(dataDir){return cleanLayout(await fs.readFile(layoutPath(dataDir),"utf8").then(JSON.parse).catch(error=>{if(error.code==="ENOENT")return DEFAULTS;throw error}))}
function layoutCss(value){
  const t=cleanLayout(value),p=t.firstPage,n=t.followingPages;
  return `
  .koffer-paper{font-family:Arial,Helvetica,sans-serif!important;font-size:${t.fontSizePt}pt!important;line-height:${t.lineHeight}!important;color:#000}
  .koffer-paper p{margin:0 0 ${t.paragraphGapMm}mm!important}
  .koffer-paper .koffer-paper-page-one{position:relative!important;padding-top:${p.bodyTopMm-p.topMm+1}mm!important}
  .koffer-paper .koffer-paper-brand{position:absolute!important;top:${40.216-(p.logoWidthMm/0.42)*(235/1260)-p.topMm}mm;right:-1.3mm;width:${p.logoWidthMm}mm!important;height:${(p.logoWidthMm/0.42)*(235/1260)}mm!important;margin:0!important;overflow:hidden}
  .koffer-paper .koffer-paper-brand img{position:absolute;max-width:none!important;width:238.095238%!important;left:-138.095238%;height:auto!important}
  .koffer-paper .koffer-paper-address{position:absolute;top:${p.addressTopMm-p.topMm-3}mm;left:2.97mm;right:0;display:grid!important;grid-template-columns:104.35mm 1fr!important;gap:0!important;min-height:${p.addressHeightMm}mm!important;margin:0!important;align-items:start!important}
  .koffer-paper .koffer-paper-recipient,.koffer-paper .koffer-paper-project{font-size:${t.fontSizePt}pt!important;line-height:${t.lineHeight}!important;align-self:start!important;padding-left:0!important}
  .koffer-paper .koffer-paper-recipient strong{font-weight:400}
  .koffer-paper .koffer-paper-project strong{font-size:${t.fontSizePt*10.8/9.92}pt!important}.koffer-paper .koffer-paper-project>span{font-size:${t.fontSizePt}pt!important}
  .koffer-paper .koffer-paper-project>span:last-child{white-space:nowrap}
  .koffer-paper .koffer-paper-offer-head{margin-top:0!important;position:relative!important}
  .koffer-paper .koffer-paper-offer-head h2{font-size:${t.titleSizePt}pt!important;line-height:${15.5/12.76}!important;margin:0!important;padding:0 0 1.23mm!important;border-bottom:.65pt solid #000!important}
  .koffer-paper .koffer-paper-offer-head time{font-size:${t.fontSizePt}pt!important;position:absolute!important;right:0;bottom:1.23mm;margin:0!important}
  .koffer-paper .koffer-paper-offer-head time:before{content:none!important}
  .koffer-paper .koffer-paper-document-meta{margin:0 0 ${t.paragraphGapMm}mm!important;font-size:${t.fontSizePt}pt!important}
  .koffer-paper .krista-invoice-positions{font-size:${t.fontSizePt}pt!important;line-height:${t.lineHeight}!important;border-collapse:collapse;table-layout:fixed!important;width:100%!important;margin-top:${t.sectionGapMm}mm!important}
  .koffer-paper .krista-invoice-positions th,.koffer-paper .krista-invoice-positions td{box-sizing:border-box;width:auto!important;padding:0 0 ${t.rowPaddingMm}mm!important;vertical-align:top;border:0;background:transparent!important;overflow-wrap:normal;white-space:normal!important;font-weight:400;text-align:left}
  .koffer-paper .krista-invoice-positions thead th{padding-bottom:7.0556mm!important;font-weight:400!important;text-align:left!important;white-space:nowrap!important}
  .koffer-paper .krista-invoice-positions [data-invoice-col="position"]{text-align:left!important}
  .koffer-paper .krista-invoice-positions td[data-invoice-col="quantity"]{text-align:right!important;padding-right:1.4111mm!important}
  .koffer-paper .krista-invoice-positions [data-invoice-col="unit"]{padding-left:1.0583mm!important;text-align:left!important}
  .koffer-paper .krista-invoice-positions [data-invoice-col="description"]{text-align:left!important;padding-right:2mm!important;overflow-wrap:anywhere}
  .koffer-paper .krista-invoice-positions td[data-invoice-col="unitPrice"]{text-align:right!important;padding-right:1.7639mm!important}
  .koffer-paper .krista-invoice-positions td[data-invoice-col="total"],.koffer-paper .krista-invoice-positions td:last-child:not(:only-child){text-align:right!important;padding-left:1.0583mm!important;white-space:nowrap!important}
  .koffer-paper .krista-invoice-positions .koffer-paper-group td{font-size:${t.fontSizePt}pt!important;padding-top:1.7639mm!important;padding-bottom:1.4111mm!important;font-weight:700;white-space:normal!important;text-align:left!important;padding-left:0!important}
  .koffer-paper .krista-invoice-positions .koffer-paper-group td:last-child{white-space:normal!important;text-align:left!important;padding-left:0!important}
  .koffer-paper .krista-invoice-positions .koffer-paper-subtotal td{border-top:.5pt solid #9aa397!important;padding-top:1.4111mm!important;padding-bottom:2.4694mm!important;font-weight:700}
  .koffer-paper .krista-invoice-positions tfoot td{padding-top:.3528mm!important;padding-bottom:.3528mm!important}
  .koffer-paper .krista-invoice-positions .koffer-paper-summary-title td{padding-top:6mm!important;padding-bottom:2mm!important;border:0!important;font-weight:700}
  .koffer-paper .krista-invoice-positions .koffer-paper-summary td{font-weight:700}
  .koffer-paper .krista-invoice-positions .koffer-paper-net td,.koffer-paper .krista-invoice-positions .koffer-paper-gross td{border-top:.75pt solid #000!important;font-weight:700}
  .koffer-paper .koffer-paper-gross td:before,.koffer-paper .koffer-paper-gross td:after{display:none!important}
  .koffer-paper .is-alternative td:nth-child(2):after{content:none!important}
  .koffer-paper .is-alternative [data-invoice-col="description"]:after{content:' (Alternative Position)'!important;font-style:italic}
  .koffer-paper .koffer-paper-finish{margin-top:${t.sectionGapMm}mm!important;padding:0!important;line-height:${t.lineHeight}!important;border:0!important;color:#000}
  .koffer-paper .koffer-paper-finish>p{margin:0 0 ${t.paragraphGapMm}mm!important}
  .koffer-paper .koffer-paper-page-two .koffer-paper-finish{margin-top:0!important}
  .koffer-paper .koffer-paper-page-logo{width:${n.logoWidthMm}mm!important;margin:0 0 ${t.sectionGapMm}mm auto!important}
  .koffer-paper .koffer-paper-continuation,.koffer-paper .koffer-paper-final-continuation,.koffer-paper .koffer-paper-carry{display:none!important}
  .koffer-paper .koffer-paper-company-footer{font:6.84pt Arial,sans-serif!important;line-height:1.2!important;border:0!important}
  .koffer-paper .krista-document-bank{font-size:7.92pt;margin-bottom:3mm;white-space:nowrap}
  .koffer-paper .krista-document-company{display:grid;grid-template-columns:46.6mm 28.4mm 30mm 1fr;white-space:nowrap}
  @media screen{
    html,body{margin:0!important;padding:0!important;background:#eee!important}
    .koffer-paper{width:210mm!important;min-width:210mm!important;max-width:210mm!important;padding:0!important;margin:0 auto!important;overflow:visible!important}
    .koffer-paper .koffer-paper-page{position:relative!important;display:block!important;box-sizing:border-box!important;width:210mm!important;min-width:210mm!important;max-width:210mm!important;height:auto!important;min-height:297mm!important;max-height:none!important;padding:${n.topMm}mm ${n.rightMm}mm ${n.bottomMm}mm ${n.leftMm}mm!important;background:white!important;overflow:visible!important}
    .koffer-paper .koffer-paper-page-one{padding:${p.bodyTopMm+1}mm ${p.rightMm}mm ${p.bottomMm}mm ${p.leftMm}mm!important}
    .koffer-paper .koffer-paper-brand{top:${40.216-(p.logoWidthMm/0.42)*(235/1260)}mm!important;right:${p.rightMm-1.3}mm!important}
    .koffer-paper .koffer-paper-address{top:${p.addressTopMm-3}mm!important;left:${p.leftMm+2.97}mm!important;right:${p.rightMm}mm!important}
    .koffer-paper .koffer-paper-company-footer{position:absolute!important;left:12.9mm!important;right:12.9mm!important;bottom:8mm!important;margin:0!important;padding:0!important}
    .koffer-paper .koffer-paper-page-logo{display:none!important}
  }
  @media print{
    @page{size:A4 portrait;margin:${n.topMm}mm ${n.rightMm}mm ${n.bottomMm}mm ${n.leftMm}mm!important}
    @page:first{margin:${p.topMm}mm ${p.rightMm}mm ${p.bottomMm}mm ${p.leftMm}mm!important}
    html,body{width:auto!important;min-width:0!important;max-width:none!important;margin:0!important;padding:0!important;overflow:visible!important;background:white!important}
    .koffer-paper{width:auto!important;min-width:0!important;max-width:none!important;min-height:0!important;padding:0!important;margin:0!important;overflow:visible!important;box-shadow:none!important}
    .koffer-paper .koffer-paper-page{display:block!important;width:auto!important;min-width:0!important;max-width:none!important;height:auto!important;min-height:0!important;max-height:none!important;padding:0!important;margin:0!important;overflow:visible!important;break-after:auto!important;page-break-after:auto!important}
    .koffer-paper .koffer-paper-page-one{position:relative!important;padding-top:${p.bodyTopMm-p.topMm+1}mm!important}
    .koffer-paper .koffer-paper-page-two{break-before:page!important;page-break-before:always!important}
    .koffer-paper .koffer-paper-page-logo{display:none!important}
    html.krista-pdf-render .koffer-paper-brand,html.krista-pdf-render .koffer-paper-company-footer{display:none!important}
    .koffer-paper thead{display:table-header-group}.koffer-paper tfoot{display:table-row-group;break-inside:avoid}
    .koffer-paper tr{break-inside:avoid}.koffer-paper .koffer-paper-group{break-after:avoid}
  }
`;
}
function registerDocumentLayout(app,{dataDir,requireAdmin,publicDir,renderPdf}){
  const read=()=>readLayout(dataDir);
  app.get("/api/document-layout",async(_req,res)=>{try{res.set("Cache-Control","no-store").json({ok:true,layout:await read()})}catch(error){res.status(500).json({ok:false,error:error.message})}});
  app.get("/public/document-layout.css",async(_req,res)=>{try{res.set("Cache-Control","no-store").type("text/css").send(layoutCss(await read()))}catch{res.sendStatus(500)}});
  app.get("/admin/formularvorlagen",(req,res)=>{if(requireAdmin(req,res))res.sendFile(path.join(publicDir,"formularvorlagen.html"))});
  app.put("/admin/api/document-layout",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{const layout=cleanLayout(req.body?.layout||req.body),file=layoutPath(dataDir);await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${crypto.randomUUID()}.tmp`;await fs.writeFile(tmp,JSON.stringify(layout,null,2),"utf8");await fs.rename(tmp,file);res.json({ok:true,layout})}catch(error){res.status(error.status||500).json({ok:false,error:error.message})}
  });
  app.post("/admin/api/document-layout/preview",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{const layout=cleanLayout(req.body?.layout||{}),kind=["Angebot","Auftragsbestätigung","Teilrechnung","Rechnung","Schlussrechnung","Gutschrift"].includes(req.body?.kind)?req.body.kind:"Angebot";const html=previewHtml(kind);res.type("application/pdf").send(await renderPdf(html,{layout}))}catch(error){res.status(error.status||500).json({ok:false,error:error.message})}
  });
  app.post("/admin/api/document-layout/render",require("express").text({type:"text/html",limit:"5mb"}),async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{res.type("application/pdf").send(await renderPdf(req.body))}catch(error){res.status(error.status||500).json({ok:false,error:error.message})}
  });
  return {read};
}
function previewHtml(kind="Angebot"){
  const rows=Array.from({length:4},(_,i)=>`<tr><td>${i+1}</td><td>Fachgerechte Malerarbeiten an Wänden und Decken gemäß vereinbartem Leistungsumfang.</td><td>20</td><td>m²</td><td>€ 15,00</td><td>€ 300,00</td></tr>`).join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;text-align:right}td:nth-child(2),th:nth-child(2){text-align:left}.koffer-paper-recipient,.koffer-paper-project{display:flex;flex-direction:column}.koffer-paper-document-meta{display:flex;justify-content:space-between}</style></head><body><div class="koffer-paper koffer-paper-two-page"><section class="koffer-paper-page koffer-paper-page-one"><div class="koffer-paper-brand"><img src="/public/document-logo.png"></div><div class="koffer-paper-address"><div class="koffer-paper-recipient"><strong>Frau Erika Muster</strong><span>Musterweg 12</span><span>6820 Frastanz</span></div><div class="koffer-paper-project"><strong>Projekt: Muster</strong><span>Malerarbeiten</span><span>Unser Bearbeiter: Ing. Alexander Krista</span></div></div><div class="koffer-paper-offer-head"><time>19.09.2026</time><h2>${kind}</h2></div><div class="koffer-paper-document-meta"><span>Nr.: MUSTER</span><span>Formularvorschau</span></div><p>Vielen Dank für Ihr Vertrauen. Nachstehend finden Sie die vereinbarten Leistungen.</p><table><colgroup>${[6,50,9,7,14,14].map(w=>`<col style="width:${w}%">`).join("")}</colgroup><thead><tr><th>Pos.</th><th>Leistung</th><th>Menge</th><th>Einheit</th><th>Einzelpreis</th><th>Gesamt</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="5">Netto</td><td>€ 1.200,00</td></tr><tr><td colspan="5">MwSt. 20 %</td><td>€ 240,00</td></tr><tr class="koffer-paper-gross"><td colspan="5">Brutto</td><td>€ 1.440,00</td></tr></tfoot></table></section><section class="koffer-paper-page koffer-paper-page-two"><div class="koffer-paper-finish"><p>Folgeseite</p><p>Diese Gestaltung gilt einheitlich für Angebot, Auftragsbestätigung, Teilrechnung, Rechnung, Schlussrechnung und Gutschrift.</p><p>Mit freundlichen Grüßen<br>Ihr KRISTA-Team</p></div></section><footer class="koffer-paper-company-footer"><div class="koffer-paper-footer-page"></div><div>Farben Krista · Feldkircherstraße 45 · 6820 Frastanz</div></footer></div></body></html>`;
}
module.exports={DEFAULTS,cleanLayout,readLayout,layoutCss,registerDocumentLayout,previewHtml};
