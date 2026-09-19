"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {installOutlookCalendar}=require("../kristine-outlook-calendar");

test("Outlook-Ampel prüft den Kalender, erkennt Widerruf und Refresh-Fehler ohne Token auszugeben",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"outlook-status-")),originalFetch=global.fetch;const secret="fixture-only";
  t.after(async()=>{global.fetch=originalFetch;await fs.rm(dir,{recursive:true,force:true})});
  const routes=new Map(),app={};for(const method of ["get","post","patch"])app[method]=(route,fn)=>routes.set(route,fn);
  installOutlookCalendar(app,{dataDir:dir,adminToken:secret,requireAdmin:(req,res)=>{if(req.allowed)return true;res.status(403).json({ok:false});return false},logger:{log(){},error(){}}});
  async function status(allowed=true){const res={code:200,status(code){this.code=code;return this},json(value){this.body=value},setHeader(){}};await routes.get("/kristine/api/outlook/status")({allowed,query:{refresh:"1"}},res);return res;}
  let calls=0;global.fetch=async()=>{calls++;return new Response('{"id":"calendar"}',{status:200})};
  assert.equal((await status()).body.status,"not_connected");assert.equal((await status(false)).code,403);assert.equal(calls,0);
  async function token(expired=false){
    await fs.mkdir(path.join(dir,"_kristine"),{recursive:true});const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",crypto.scryptSync(secret,"KRISTINE Outlook:5a41643d-fb28-4542-aed2-71672311a92c",32),iv);
    const value={account:"alexander.krista@krista.at",access_token:"test-access",refresh_token:"test-refresh",stored_at:expired?0:Date.now(),expires_in:3600,scope:"Calendars.ReadWrite Calendars.ReadWrite.Shared Mail.Read Mail.Read.Shared"};
    const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);await fs.writeFile(path.join(dir,"_kristine/outlook-token.enc.json"),JSON.stringify({iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),data:data.toString("base64")}));
  }
  await token();const ready=await status();assert.equal(ready.body.connected,true);assert.equal(ready.body.status,"connected");assert.doesNotMatch(JSON.stringify(ready.body),/test-access|test-refresh/);
  global.fetch=async()=>new Response('{}',{status:401});assert.equal((await status()).body.status,"expired");
  global.fetch=async()=>{throw new Error("offline")};assert.equal((await status()).body.status,"unavailable");
  await token(true);global.fetch=async()=>new Response('{"error":"invalid_grant"}',{status:400});assert.equal((await status()).body.status,"expired");
});
