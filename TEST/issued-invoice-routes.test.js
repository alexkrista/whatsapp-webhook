"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const express=require("express");
const {registerInvoiceArchiveRoute}=require("../issued-invoice-project-routes");
const {listInvoiceDocuments}=require("../issued-invoice-project-archive");
const original=Buffer.from("%PDF-1.4\nOriginal from the issued invoice test\n%%EOF\n");
const digest=crypto.createHash("sha256").update(original).digest("hex");
async function harness(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"krista-invoice-http-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,"24138"));
  const app=express();
  app.use(express.json());
  registerInvoiceArchiveRoute(app,{dataDir:dir,requireAdmin:(req,res)=>{
    if(req.headers["x-test-auth"]==="yes")return true;
    res.status(403).json({ok:false});return false;
  }});
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s))});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base="http://127.0.0.1:"+server.address().port;
  const url=base+"/admin/api/job/24138/documentation/issued-invoice";
  const headers={"content-type":"application/pdf","x-test-auth":"yes","x-invoice-number":"202610003",
    "x-invoice-id":"95","x-invoice-source":"KRISTINE","x-invoice-kind":"SR",
    "x-invoice-date":"2026-10-07","x-invoice-sha256":digest};
  return {dir,url,headers};
}

test("private API deposits original PDF under correct project, with idempotent re-import",async t=>{
  const {dir,url,headers}=await harness(t);
  assert.equal((await fetch(url,{method:"POST",headers:{"content-type":"application/pdf"},body:original})).status,403);
  const first=await fetch(url,{method:"POST",headers,body:original});
  assert.equal(first.status,201);
  assert.equal((await first.json()).created,true);
  const again=await fetch(url,{method:"POST",headers,body:original});
  assert.equal(again.status,200);
  assert.equal((await again.json()).created,false);
  const docs=await listInvoiceDocuments(dir,"24138");
  assert.equal(docs.length,1);
  assert.equal(docs[0].documentType,"invoice");
  assert.equal(docs[0].name,"Schlussrechnung 202610003.pdf");
  assert.match(docs[0].url,/documentation\/file\?name=invoice-KRISTINE-202610003-95\.pdf/);
});

test("a mismatched PDF or a fake project cannot be archived",async t=>{
  const {url,headers}=await harness(t);
  const bad=await fetch(url,{method:"POST",headers,body:Buffer.from("%PDF-1.4\nReplaced")});
  assert.ok([400,409].includes(bad.status));
  const fake=await fetch(url.replace("/24138/","/24139/"),{method:"POST",headers,body:original});
  assert.equal(fake.status,404);
});

test("project reads merge independently archived invoice PDFs into document records",()=>{
  const source=require("node:fs").readFileSync(path.join(__dirname,"..","server.js"),"utf8");
  const ui=require("node:fs").readFileSync(path.join(__dirname,"..","public/ui/baustellen-knowledge-hub.js"),"utf8");
  assert.match(source,/registerInvoiceArchiveRoute\(app/);
  assert.match(source,/listInvoiceDocuments\(DATA_DIR,jobId\)/);
  assert.match(source,/type!=="issued_invoice"/);
  assert.match(ui,/Originalrechnungen in der Baustellenakte/);
  assert.match(ui,/Ausgestellte Rechnungen als Original-PDF/);
});
