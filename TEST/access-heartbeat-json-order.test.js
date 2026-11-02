"use strict";
// Regression for the Camper-first Express middleware order.
// Safe test: isolated temporary files and loopback HTTP only, no hardware or cloud calls.
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");

(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"krista-access-heartbeat-"));
  const previousDataDir=process.env.DATA_DIR, previousToken=process.env.ADMIN_TOKEN;
  process.env.DATA_DIR=temp;
  process.env.ADMIN_TOKEN="test-only-access-heartbeat-json-order";
  const cloud=require("../access-bridge-cloud.js");
  const express=require("express");
  const app=express();
  // Reproduce production: Camper adds its router before the JSON parser.
  app.use("/camper",express.Router());
  app.use(express.json({limit:"25mb"}));
  const server=await new Promise(resolve=>{
    const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));
  });
  try{
    const base="http://127.0.0.1:"+server.address().port;
    const token=process.env.ADMIN_TOKEN;
    const request=async (method,url,body,admin=true)=>{
      const response=await fetch(base+url,{
        method,
        headers:{...(admin?{"x-admin-token":token}:{}),...(body?{"content-type":"application/json"}:{})},
        body:body?JSON.stringify(body):undefined,
      });
      return {status:response.status,body:await response.json()};
    };
    const now=Date.now();
    const payload={
      host:"KRISTINE-PC",
      sentAt:new Date(now).toISOString(),
      gantner:{ok:true,doors:{
        1:{mode:"OPEN",reason:"Freigabe"},
        2:{mode:"NORMAL",reason:"Chip"},
        3:{mode:"NORMAL",reason:"Chip"},
      }},
      gatePosition:{ok:true,unreachable:false,checkedAt:now,position:"CLOSED"},
      services:{gantner:{label:"Gantner",state:"ok"},bridge:{label:"Access Bridge",state:"ok"}},
    };
    const posted=await request("POST","/kristine/api/access-heartbeat",payload);
    assert.equal(posted.status,200,JSON.stringify(posted.body));
    assert.equal(posted.body.ok,true);
    const status=await request("GET","/kristine/api/access-status");
    assert.equal(status.status,200,JSON.stringify(status.body));
    assert.equal(status.body.ok,true);
    assert.equal(status.body.online,true);
    assert.equal(status.body.stale,false);
    assert.equal(status.body.gantner?.ok,true,
      "Heartbeat JSON lost before global express.json parser: yellow door indicators");
    assert.equal(status.body.gantner.doors["1"].mode,"OPEN");
    assert.equal(status.body.gantner.doors["2"].mode,"NORMAL");
    assert.equal(status.body.gantner.doors["3"].mode,"NORMAL");
    assert.equal(status.body.gatePosition?.position,"CLOSED");
    assert.equal(status.body.services?.gantner?.state,"ok");
    assert.equal(status.body.services?.cloud?.state,"ok");

    const stored=JSON.parse(await fs.readFile(
      path.join(temp,"_kristine","access-local-status.json"),"utf8"));
    assert.equal(stored.gantner.doors["1"].mode,"OPEN");
    assert.equal(stored.gatePosition.position,"CLOSED");
    assert(stored.receivedAt && Date.parse(stored.receivedAt)>=now);
    const denied=await request("GET","/kristine/api/access-status",undefined,false);
    assert.equal(denied.status,403,"Protected status route must remain authenticated");
    console.log("Access heartbeat -> JSON parser -> cloud status regression OK");
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await fs.rm(temp,{recursive:true,force:true});
    if(previousDataDir===undefined)delete process.env.DATA_DIR;
    else process.env.DATA_DIR=previousDataDir;
    if(previousToken===undefined)delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN=previousToken;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
