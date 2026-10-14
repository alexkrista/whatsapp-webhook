"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {JSDOM,VirtualConsole}=require("jsdom");
const ROOT=path.join(__dirname,"..");
const page=fs.readFileSync(path.join(ROOT,"public","baustellen.html"),"utf8");
const hub=fs.readFileSync(path.join(ROOT,"public","ui","baustellen-knowledge-hub.js"),"utf8");
const server=fs.readFileSync(path.join(ROOT,"server.js"),"utf8");

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test("Baustellen button opens unsaved full Stammdaten as Angebot, never the quick modal", async ()=>{
  assert.match(page,/id="newOffer"[^>]*>\+ Neues Angebot</);
  assert.match(page,/getElementById\('newOffer'\).*BaustellenKnowledgeHub\.newOffer/);
  assert.match(server,/body\.creationMode === "offer" && body\.status === "Angebot" \? "Angebot"/);
  assert.match(server,/:\s*\/\^\\d\{5\}\$\/\.test\(jobId\) \? "Auftrag"/);
  assert.match(hub,/location\.href=tokenUrl\("\/kristine\/baustellen\?editMaster="/);

  const errors=[];
  const consoleSink=new VirtualConsole();
  consoleSink.on("jsdomError",e=>errors.push(String(e.message||e)));
  const dom=new JSDOM(page,{
    url:"https://example.test/kristine/baustellen?token=test",runScripts:"outside-only",
    pretendToBeVisual:true,virtualConsole:consoleSink
  });
  const w=dom.window;
  const requests=[];
  w.fetch=async(url,options={})=>{
    const u=new URL(url,w.location.origin);
    const data=u.pathname==="/admin/api/jobs/next-number" ? {ok:true,nextNumber:"26111"} :
      u.pathname==="/admin/api/jobs" ? (requests.push(JSON.parse(options.body)),{ok:true,jobId:"26111"}) :
      {ok:false,error:"Unexpected endpoint "+u.pathname};
    return {ok:data.ok,status:data.ok?200:404,text:async()=>JSON.stringify(data)};
  };
  w.KristaProjectAddress={parse:input=>({street:input?.street||"",houseNumber:input?.houseNumber||"",postalCode:input?.postalCode||"",city:input?.city||""})};
  try{
    w.eval(hub);
    w.document.dispatchEvent(new w.Event("DOMContentLoaded",{bubbles:true}));
    assert.equal(typeof w.BaustellenKnowledgeHub.newOffer,"function");
    await w.BaustellenKnowledgeHub.newOffer();
    const doc=w.document;
    assert.ok(doc.getElementById("detail").classList.contains("open"));
    assert.ok(doc.getElementById("detail").classList.contains("bk-new-offer"));
    assert.ok(doc.querySelector('[data-bk-tab="master"]').classList.contains("active"));
    for(const field of ["bkDraftJobId","bkJobName","bkOwnerLookupQuery","bkSiteStreet",
      "bkOwnerCustomer","bkSiteManagerCompany","bkArchitectCompany","bkSaveMaster"]){
      assert.ok(doc.getElementById(field),field+" missing from full Stammdaten form");
    }
    assert.equal(doc.getElementById("bkDraftJobId").value,"26111");
    assert.equal(doc.getElementById("bkSaveMaster").textContent,"Angebot anlegen");
    assert.equal(requests.length,0,"opening offer must not persist any job");

    // An empty name must not silently create a job.
    doc.getElementById("bkSaveMaster").click();
    await wait(20);
    assert.equal(requests.length,0);
    assert.match(doc.getElementById("bkMasterSaveStatus").textContent,/Bezeichnung/);

    // Cancel also leaves the system without a new record.
    doc.getElementById("detailBack").addEventListener("click",()=>{
      doc.getElementById("detail").classList.remove("open");
      doc.dispatchEvent(new w.CustomEvent("krista:baustelle-closed"));
    },{once:true});
    doc.getElementById("bkCancelMaster").click();
    assert.equal(requests.length,0);
    assert.equal(doc.getElementById("detail").classList.contains("bk-new-offer"),false);

    // Open the full form again and fill both project and rich contact data.
    await w.BaustellenKnowledgeHub.newOffer();
    doc.getElementById("bkJobName").value="Müller · Badsanierung";
    doc.getElementById("bkSiteStreet").value="Hauptstraße";
    doc.getElementById("bkSiteHouse").value="12";
    doc.getElementById("bkSitePostal").value="6820";
    doc.getElementById("bkSiteCity").value="Frastanz";
    doc.getElementById("bkOwnerRole").value="Firma";
    doc.getElementById("bkOwnerRole").dispatchEvent(new w.Event("change",{bubbles:true}));
    doc.getElementById("bkOwnerCustomer").value="Müller GmbH";
    doc.getElementById("bkOwnerWomanEmail").value="office@example.test";
    doc.getElementById("bkSiteManagerCompany").value="Bauleitung Muster";
    doc.getElementById("bkSaveMaster").click();
    await wait(40);
    assert.equal(requests.length,1,"only saving creates the offer");
    const data=requests[0];
    assert.equal(data.jobId,"26111");
    assert.equal(data.status,"Angebot");
    assert.equal(data.creationMode,"offer");
    assert.equal(data.name,"Müller · Badsanierung");
    assert.equal(data.postalCode,"6820");
    assert.equal(data.street,"Hauptstraße");
    assert.equal(data.projectContacts.owner.customer,"Müller GmbH");
    assert.equal(data.projectContacts.siteManager.company,"Bauleitung Muster");
    assert.equal(data.customerMaster.name,"Müller GmbH");
    // JSDOM intentionally does not follow browser navigation; a real browser
    // navigates to the persisted job's full Stammdaten using ?editMaster=...#...
    assert.ok(errors.every(x=>x.includes("navigation")),errors.join("\n"));
  } finally {
    dom.window.close();
  }
});
