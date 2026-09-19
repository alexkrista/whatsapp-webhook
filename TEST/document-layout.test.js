"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),express=require("express");
const {JSDOM}=require("jsdom"),apply=require("../public/ui/document-template");
const {cleanLayout,readLayout,registerDocumentLayout,previewHtml}=require("../document-layout");

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
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"krista-layout-")),app=express();app.use(express.json());
  registerDocumentLayout(app,{dataDir,publicDir:path.resolve("public"),requireAdmin:(req,res)=>{if(req.headers["x-admin-token"]==="test")return true;res.sendStatus(403);return false},renderPdf:async()=>Buffer.from("%PDF-Test")});
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${server.address().port}`,body=JSON.stringify({layout:{firstPage:{leftMm:20},followingPages:{leftMm:15,topMm:38},fontSizePt:10.5}}),options={method:"PUT",headers:{"Content-Type":"application/json"},body};
  assert.equal((await fetch(base+"/admin/api/document-layout",options)).status,403);
  assert.equal((await fetch(base+"/admin/api/document-layout",{...options,headers:{...options.headers,"X-Admin-Token":"test"}})).status,200);
  const saved=await readLayout(dataDir);assert.equal(saved.firstPage.leftMm,20);assert.equal(saved.followingPages.leftMm,20);assert.equal(saved.followingPages.topMm,38);assert.equal(saved.fontSizePt,10.5);
  assert.equal((await fetch(base+"/admin/api/document-layout/render",{method:"POST",headers:{"Content-Type":"text/html"},body:"<html></html>"})).status,403);
  const published=await(await fetch(base+"/api/document-layout")).json();assert.equal(published.layout.revision,saved.revision);
});

test("Seitenvorlage verhindert Überschneidungen und ungültige Maßangaben",()=>{
  assert.throws(()=>cleanLayout({fontSizePt:NaN}),/Ungültiger/);
  assert.throws(()=>cleanLayout({firstPage:{bodyTopMm:70}}),/Anschrift/);
  assert.throws(()=>cleanLayout({followingPages:{bottomMm:1}}),/Ungültiger/);
});
