"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const {createPreviewServer}=require("../tools/kristine-v2-preview-server");

const password="isolated-offer-v2-strong-password";
async function serve(fn){
  const server=createPreviewServer({password});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port;
  const request=(route,method="GET",auth=true)=>new Promise((resolve,reject)=>{
    const headers=auth?{authorization:"Basic "+Buffer.from("v2:"+password).toString("base64")}:{};
    const req=http.request({hostname:"127.0.0.1",port,path:route,method,headers},res=>{
      const chunks=[];res.on("data",chunk=>chunks.push(chunk));
      res.on("end",()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString("utf8"),headers:res.headers}));
    });
    req.on("error",reject);req.end();
  });
  try{await fn(request)}finally{await new Promise(resolve=>server.close(resolve));}
}

test("Neuer Angebotseditor ist Passwort-geschützt, GET-only, exakt von Produktion isoliert",async()=>{
  await serve(async request=>{
    assert.equal((await request("/angebot-v2","GET",false)).status,401);
    for(const method of ["POST","PUT","PATCH","DELETE"]){
      assert.equal((await request("/angebot-v2",method)).status,405);
      assert.equal((await request("/admin/api/job/26111/offer-draft",method)).status,405);
    }
    assert.equal((await request("/admin/api/job/26111/offer-draft")).status,404);
    const page=await request("/angebot-v2");
    assert.equal(page.status,200);
    assert.match(page.body,/ISOLIERTE TESTUMGEBUNG/);
    assert.match(page.body,/offer-v2-core.js/);
    assert.match(page.body,/offer-v2-app.js/);
    assert.match(page.body,/TEST-Entwurf/);
    assert.match(page.headers["content-security-policy"],/connect-src 'none'/);
    const home=await request("/preview?world=kristine");
    assert.match(home.body,/Angebotsstudio V2 öffnen/);
    for(const asset of ["offer-v2-core.js","offer-v2-app.js","offer-v2.css"]){
      const file=await request("/public/ui/"+asset);
      assert.equal(file.status,200,asset);
      assert.ok(file.body.length>2000,asset);
    }
  });
});

test("Browser-App kann keine Produktion, Bank, WhatsApp oder Tür-API kontaktieren",()=>{
  const app=fs.readFileSync(path.join(__dirname,"../public/ui/offer-v2-app.js"),"utf8");
  const page=fs.readFileSync(path.join(__dirname,"../public/angebot-v2.html"),"utf8");
  assert.doesNotMatch(app,/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
  assert.doesNotMatch(page,/https:\/\/protokoll\.krista\.at|api\/door|api\/payments/i);
  assert.match(app,/localStorage\.setItem/);
  assert.match(app,/window\.print\(\)/);
  assert.match(app,/C\.printMarkup\(offer\)/);
  assert.match(app,/case "remove-pos":/);
});
