"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const crypto=require("node:crypto");
const {parseCommand,parseConfirmation,verifyMetaSignature,isOwner,createAlexSceneQueue}=require("../alex-whatsapp-scene-cloud");
test("Alex-Szenen: nur exakte Cheftexte, ohne Start/Ende und ohne Fremdnummern",()=>{
  assert.equal(parseCommand(" Alex kommt! "),"arrive");
  assert.equal(parseCommand("Alex   geht."),"away");
  assert.equal(parseCommand("Alex fährt"),"away");
  assert.equal(parseCommand("START"),null);
  assert.equal(parseCommand("ENDE"),null);
  assert.equal(parseCommand("Bitte: Alex kommt"),null);
  assert.equal(parseCommand("Alex kommt morgen"),null);
  assert.equal(isOwner("+43 664 1234567","00436641234567"),true);
  assert.equal(isOwner("4366412345679","436641234567"),false);
  assert.equal(isOwner("1234567","436641234567"),false);
  const raw=Buffer.from(JSON.stringify({entry:[{changes:[]}]}));
  const sig="sha256="+crypto.createHmac("sha256","test-only-appsecret").update(raw).digest("hex");
  assert.equal(verifyMetaSignature(raw,sig,"test-only-appsecret"),true);
  assert.equal(verifyMetaSignature(raw,sig,"wrong"),false);
  assert.equal(verifyMetaSignature(raw,"","test-only-appsecret"),false);
  assert.equal(parseConfirmation("Alex freigeben abcdef012345abcdef012345"),"abcdef012345abcdef012345");
});
test("WhatsApp-Warteschlange: einmalige, frische Jobs, keine Hardware/Aufgabenzeit",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"alexscene-"));
  try{
    let now=Date.parse("2026-11-11T11:00:00Z");
    const status=path.join(dir,"_kristine","access-local-status.json");
    await fs.mkdir(path.dirname(status),{recursive:true});
    await fs.writeFile(status,JSON.stringify({receivedAt:new Date(now).toISOString(),
      services:{gantner:{state:"ok"},homematic:{state:"ok"}},
      alexSceneWorker:{version:"alex-wa-v1",lastPollAt:new Date(now).toISOString()}}),"utf8");
    const replies=[];
    const queue=createAlexSceneQueue({dataDir:dir,now:()=>now,
      sendReply:async x=>replies.push(x)});
    const req={sender:"436641234567",chefPhone:"+436641234567",
      command:"Alex kommt",messageId:"wamid.alex-fresh-123456789",
      timestamp:now/1000,phoneNumberId:"12345"};
    assert.equal((await queue.enqueue({...req,sender:"436641234568"})).status,"unauthorized");
    assert.equal((await queue.enqueue({...req,timestamp:now/1000-400})).status,"stale");
    const first=await queue.enqueue(req);
    assert.equal(first.status,"queued");
    assert.equal((await queue.enqueue(req)).status,"duplicate");
    assert.equal((await queue.enqueue({...req,messageId:"wamid.other-job-123456789"})).status,"busy");
    const claimed=await queue.claim();
    assert.equal(claimed.id,first.id);
    assert.equal(claimed.action,"arrive");
    assert.equal(await queue.claim(),null,"no delivery retry after claim");
    const done=await queue.ack({id:claimed.id,ok:true,doors:{"1":"OPEN","2":"OPEN","3":"OPEN"},alex:true,bettina:false,dunja:false,light:"switched_on"});
    assert.equal(done.state,"done");
    assert.equal(replies.length,1);
    assert.match(replies[0].reply,/Türen freigegeben/);
    assert.equal((await queue.enqueue(req)).status,"duplicate");
    const leave=await queue.enqueue({...req,command:"Alex geht",messageId:"wamid.leaving-123456789"});
    assert.equal(leave.status,"queued");
    const claimedLeave=await queue.claim();
    await queue.ack({id:claimedLeave.id,ok:true,doors:{"1":"OPEN","2":"OPEN","3":"OPEN"},alex:false,bettina:true,dunja:false});
    assert.match(replies[1].reply,/Bettina/);
    const challenge=await queue.challenge({...req,command:"Alex kommt",
      messageId:"wamid.challenge-123456789"});
    assert.equal(challenge.status,"challenge");
    assert.match(challenge.code,/^[a-f0-9]{24}$/);
    assert.equal(await queue.claim(),null,"challenge must not open doors");
    assert.equal((await queue.confirm({...req,command:"Alex freigeben "+"f".repeat(24),
      messageId:"wamid.wrongcode-123456789"})).status,"invalid_code");
    const confirmed=await queue.confirm({...req,command:"Alex freigeben "+challenge.code,
      messageId:"wamid.confirmed-123456789"});
    assert.equal(confirmed.status,"queued");
    assert.equal((await queue.confirm({...req,command:"Alex freigeben "+challenge.code,
      messageId:"wamid.confirmed-123456789"})).status,"duplicate");
    const claimedVerified=await queue.claim();
    assert.equal(claimedVerified.action,"arrive");
    await queue.ack({id:claimedVerified.id,ok:true,doors:{"1":"OPEN","2":"OPEN","3":"OPEN"},
      alex:true,bettina:false,dunja:false,light:"already_on"});
    await fs.access(path.join(dir,"_kristine","time-events.json")).then(
      ()=>assert.fail("must not write work-time events"),()=>{});
    const store=JSON.parse(await fs.readFile(path.join(dir,"_kristine","alex-whatsapp-scenes.json"),"utf8"));
    assert.equal(store.jobs.length,3);
    assert(store.jobs.every(x=>x.state==="done"));
    now+=200000;
    assert.equal((await queue.enqueue({...req,timestamp:now/1000,
      messageId:"wamid.bridge-stale-123456789"})).status,"offline");
  } finally{await fs.rm(dir,{recursive:true,force:true});}
});
