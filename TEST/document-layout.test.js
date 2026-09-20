"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),express=require("express");
const {JSDOM}=require("jsdom"),apply=require("../public/ui/document-template");
const {cleanLayout,readLayout,registerDocumentLayout,previewHtml}=require("../document-layout");

test("PDF hält den Rechnungskopf auch bei Druckregeln eines älteren AB-Fensters frei",async()=>{
  const {renderOfferHtmlPdf}=require("../offer-html-pdf"),{getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
  // An already open browser can still submit the former AB-specific print rules.
  const legacy="@media print{.koffer-paper[data-order-confirmation] .koffer-paper-page{display:block!important;position:static!important;padding:0!important;margin:0!important}.koffer-paper[data-order-confirmation] .koffer-paper-address{grid-template-columns:1fr 1fr!important}}";
  const html=previewHtml("Auftragsbestätigung").replace('class="koffer-paper koffer-paper-two-page"','class="koffer-paper koffer-paper-two-page" data-order-confirmation="legacy"').replace("</head>",`<style>${legacy}</style></head>`);
  const pdf=await renderOfferHtmlPdf(html,{layout:cleanLayout()}),document=await getDocument({data:new Uint8Array(pdf),useSystemFonts:true}).promise;
  try{
    assert.equal(document.numPages,2);
    const page=await document.getPage(1),{items}=await page.getTextContent(),height=page.getViewport({scale:1}).height;
    const top=text=>height-items.find(item=>item.str.includes(text)).transform[5],mm=72/25.4;
    assert(top("Auftragsbestätigung")>95*mm,"Der Dokumenttitel steht unter dem Anschriftenfeld, nicht im Logo");
    assert(top("Auftragsbestätigung")>top("6820 Frastanz"),"Anschrift und Titel überlagern sich nicht");
    assert(top("Fachgerechte")>top("Auftragsbestätigung"),"Positionen folgen unter dem Dokumentkopf");
    const next=await document.getPage(2),text=(await next.getTextContent()).items.map(item=>item.str).join(" ");
    assert.match(text,/Folgeseite/);assert.match(text,/Seite 2\/2/);
  }finally{await document.destroy()}
});

test("PDF ersetzt nur den Browser-Empfänger durch serverseitige Stammdaten",async()=>{
  const {renderOfferHtmlPdf}=require("../offer-html-pdf"),{getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
  const html=previewHtml("Angebot").replace("Projekt: Muster","Projekt: 26101"),recipient={nameLines:["Firma <b>Server</b> GmbH","z. H. Frau Eva Muster"],addressLines:["Serverweg 7","6800 Feldkirch"]},resolved=[];
  const pdf=await renderOfferHtmlPdf(html,{layout:cleanLayout(),inferRecipientJobId:true,resolveRecipient:async jobId=>{resolved.push(jobId);return recipient}}),document=await getDocument({data:new Uint8Array(pdf),useSystemFonts:true}).promise;
  try{
    assert.deepEqual(resolved,["26101"]);
    const first=await document.getPage(1),text=(await first.getTextContent()).items.map(item=>item.str).join(" ");
    assert.match(text,/Firma <b>Server<\/b> GmbH/);
    assert.match(text,/z\. H\. Frau Eva Muster/);
    assert.match(text,/Serverweg 7/);assert.match(text,/6800 Feldkirch/);
    assert.doesNotMatch(text,/Frau Erika Muster|Musterweg 12/);
    assert.match(text,/Fachgerechte Malerarbeiten/);assert.match(text,/1\.440,00/);
  }finally{await document.destroy()}
});

test("Gemeinsame Vorlage ordnet Positionswerte wie die Rechnung und verändert keine Beträge",()=>{
  const dom=new JSDOM(previewHtml("Auftragsbestätigung")),paper=dom.window.document.querySelector(".koffer-paper");
  apply(paper);
  assert.deepEqual([...paper.querySelectorAll("thead th")].map(c=>c.textContent),["Pos","Menge","Einh.","Leistung","EP [EUR]","GP [EUR]"]);
  const row=paper.querySelector("tbody tr");assert.equal(row.cells[1].textContent,"20");assert.equal(row.cells[2].textContent,"m²");assert.match(row.cells[3].textContent,/Fachgerechte/);assert.equal(row.cells[4].textContent,"15,00");assert.equal(row.cells[5].textContent,"300,00");
  assert.equal(paper.querySelector("tfoot tr:last-child td:last-child").textContent,"1.440,00");
  const before=paper.outerHTML;apply(paper);assert.equal(paper.outerHTML,before);
  dom.window.close();
});

test("Vorlagen bleiben nach Neustart erhalten; nur Admin darf sie ändern oder PDFs erzeugen",async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"krista-layout-")),app=express(),renders=[];app.use(express.json());
  registerDocumentLayout(app,{dataDir,publicDir:path.resolve("public"),requireAdmin:(req,res)=>{if(req.headers["x-admin-token"]==="test")return true;res.sendStatus(403);return false},renderPdf:async(html,options)=>{renders.push({html,options});return Buffer.from("%PDF-Test")}});
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${server.address().port}`,body=JSON.stringify({layout:{firstPage:{leftMm:20},followingPages:{leftMm:15,topMm:38},fontSizePt:10.5}}),options={method:"PUT",headers:{"Content-Type":"application/json"},body};
  assert.equal((await fetch(base+"/admin/api/document-layout",options)).status,403);
  assert.equal((await fetch(base+"/admin/api/document-layout",{...options,headers:{...options.headers,"X-Admin-Token":"test"}})).status,200);
  const saved=await readLayout(dataDir);assert.equal(saved.firstPage.leftMm,20);assert.equal(saved.followingPages.leftMm,20);assert.equal(saved.followingPages.topMm,38);assert.equal(saved.fontSizePt,10.5);
  assert.equal((await fetch(base+"/admin/api/document-layout/render",{method:"POST",headers:{"Content-Type":"text/html"},body:"<html></html>"})).status,403);
  assert.equal((await fetch(base+"/admin/api/document-layout/render",{method:"POST",headers:{"Content-Type":"text/html","X-Admin-Token":"test"},body:"<html><div class=\"koffer-paper\"></div></html>"})).status,200);
  assert.equal(renders.at(-1).options.inferRecipientJobId,true);
  const published=await(await fetch(base+"/api/document-layout")).json();assert.equal(published.layout.revision,saved.revision);
});

test("Seitenvorlage verhindert Überschneidungen und ungültige Maßangaben",()=>{
  assert.throws(()=>cleanLayout({fontSizePt:NaN}),/Ungültiger/);
  assert.throws(()=>cleanLayout({firstPage:{bodyTopMm:70}}),/Anschrift/);
  assert.throws(()=>cleanLayout({followingPages:{bottomMm:1}}),/Ungültiger/);
});
