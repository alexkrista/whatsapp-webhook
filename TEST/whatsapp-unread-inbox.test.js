"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {createWhatsAppInbox} = require("../whatsapp-unread-inbox");
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"krista-wa-inbox-"));
  try{
    const a=createWhatsAppInbox(dir);
    const one={id:"wamid-one",from:"436600001",type:"text",timestamp:"1791629000",text:{body:"Bitte Rückruf"}};
    await a.record(one);
    await a.record(one);
    await a.record({id:"wamid-two",from:"436600002",type:"image",image:{caption:"Baustellenfoto"}});
    assert.equal((await a.list()).count,2,"Webhook retry must not double-count");
    assert.equal((await a.list()).items[0].text,"Baustellenfoto");
    await a.markRead(["wamid-one"]);
    assert.equal((await a.list()).count,1);
    const reloaded=createWhatsAppInbox(dir);
    assert.equal((await reloaded.list()).count,1,"Unread status must persist across restart");
    console.log("WhatsApp unread inbox persistence, deduplication and read state passed");
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
