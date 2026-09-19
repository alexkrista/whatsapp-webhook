"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{JSDOM}=require("jsdom");
test("Dienste zeigt Outlook auch ohne lokalen Manager und verbindet über den bestehenden Microsoft-Ablauf",async t=>{
  const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{url:"https://example.test/kristine/baustellen?token=fixture",runScripts:"outside-only"});t.after(()=>dom.window.close());
  const w=dom.window,calls=[];let connected=false;const popup={opener:{},location:{href:"about:blank"},close(){}};w.open=()=>popup;
  w.AbortSignal=AbortSignal;
  w.fetch=async(raw,options={})=>{
    calls.push({raw,options});if(String(raw).startsWith("http://127.0.0.1"))throw new Error("Büro offline");
    const url=new URL(raw,w.location.origin);assert.equal(url.searchParams.get("token"),"fixture");let result;
    if(url.pathname.endsWith("/status"))result={ok:true,status:connected?"connected":"expired",connected,expectedAccount:"alexander.krista@krista.at"};
    else if(url.pathname.endsWith("/login/start"))result={ok:true,sessionId:"session",userCode:"DEMO-1234",verificationUri:"https://microsoft.com/devicelogin",expiresIn:900,interval:5};
    else if(url.pathname.endsWith("/login/poll")){assert.equal(JSON.parse(options.body).sessionId,"session");connected=true;result={ok:true,status:"connected"};}
    else throw new Error("Unexpected URL");
    return {ok:true,json:async()=>result,text:async()=>JSON.stringify(result)};
  };
  for(const name of ["outlook-services.js","krisadmin-services-core.js"])w.eval(fs.readFileSync(path.join(__dirname,"../public/ui",name),"utf8"));
  w.KrisadminServices.open();await w.KrisadminServices.load();
  assert.match(w.document.querySelector("#kristaServicesContent").textContent,/Dienstemanager.*Nicht erreichbar/);
  assert.match(w.document.querySelector("#kristaServicesContent").textContent,/Outlook-Anmeldung.*Anmeldung abgelaufen/);
  assert.equal(w.document.querySelector("[data-outlook-connect]").textContent,"Neu verbinden");
  w.setTimeout=fn=>{queueMicrotask(fn);return 1};
  const host=w.document.querySelector("#kristaServicesOutlookLogin");await w.KristaOutlookServices.connect(host);
  assert.equal(popup.location.href,"https://microsoft.com/devicelogin");assert.equal(popup.opener,null);
  assert.equal(w.KristaOutlookServices.row().level,"green");assert.match(host.textContent,/Outlook ist verbunden/);
  assert.equal(calls.filter(row=>String(row.raw).includes("login/start")).length,1);
  w.KrisadminServices.close();
});
