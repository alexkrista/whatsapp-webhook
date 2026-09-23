"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { registerPaintInventory } = require("../paint-inventory");

(async () => {
  process.env.ADMIN_TOKEN = "test-only";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "krista-lg-stock-"));
  const paintDir = path.join(dataDir, "_kristine", "paint");
  fs.mkdirSync(paintDir, { recursive: true });
  fs.writeFileSync(path.join(paintDir, "articles.json"), JSON.stringify([{
    id: "LG-00123456789",
    manufacturer: "Little Greene",
    product: "Absolute Matt",
    baseCode: "H",
    baseName: "Hi White",
    size: "2.5 L",
    stockCode: "00123456789",
    stock: 3,
    purchasePrice: 70,
    targetStock: 4,
    minimumStock: 2,
    active: true,
  }]), "utf8");

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerPaintInventory(app, { dataDir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = {
    invoiceRef: "LG-TEST-4711",
    invoiceDate: "2026-09-10",
    netAmount: 149.60,
    text: "10 00123456789 LG Absolute Matt Hi White 2,5L 2 74,80 149,60",
  };

  try {
    let response = await fetch(base + "/admin/api/paint/lg-incoming-sync", {
      method: "POST", headers: { "Content-Type": "application/json", "x-admin-token":"test-only" }, body: JSON.stringify(payload),
    });
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.paintLines, 1);
    const receipt=body.receipt;
    const stock=()=>JSON.parse(fs.readFileSync(path.join(paintDir,"articles.json"),"utf8"))[0].stock;
    const post=async(url,data)=>{const r=await fetch(base+url,{method:"POST",headers:{"Content-Type":"application/json","x-admin-token":"test-only"},body:JSON.stringify(data)});return {status:r.status,body:await r.json()};};
    const confirmUrl="/admin/api/paint/goods-receipts/"+receipt.id+"/confirm";
    assert.equal(body.awaitingGoods,true);
    assert.equal(stock(),3,"invoice must not book stock");
    await post("/admin/api/paint/lg-incoming-sync",payload);
    const tasks=()=>JSON.parse(fs.readFileSync(path.join(dataDir,"_kristine","tasks.json"),"utf8"));
    assert.equal(tasks().length,1,"repeated invoice creates one task");
    assert.equal(tasks()[0].status,"open");
    assert.equal((await post(confirmUrl,{revision:receipt.revision})).status,400);
    assert.equal((await post(confirmUrl,{goodsReceived:true,revision:"stale"})).status,400);
    assert.equal(stock(),3);
    const confirmations=await Promise.all([1,2].map(()=>post(confirmUrl,{goodsReceived:true,revision:receipt.revision})));
    assert(confirmations.every(r=>r.status===200));
    assert.equal(confirmations.filter(r=>r.body.duplicate).length,1);
    assert.equal(stock(),5,"concurrent confirms book only once");
    assert.equal(tasks()[0].status,"done");
    assert.equal(fs.readFileSync(path.join(paintDir,"movements.jsonl"),"utf8").trim().split("\n").length,1);
    assert.equal(fs.readFileSync(path.join(paintDir,"price-history.jsonl"),"utf8").trim().split("\n").length,1);
    const repeat=await post("/admin/api/paint/lg-incoming-sync",payload);
    assert.equal(repeat.body.duplicate,true);
    assert.equal(stock(),5);
    const unknown=await post("/admin/api/paint/lg-incoming-sync",{...payload,invoiceRef:"UNKNOWN",text:"not parsed"});
    assert(unknown.body.receipt.issue);
    assert.equal((await post("/admin/api/paint/goods-receipts/"+unknown.body.receipt.id+"/confirm",{goodsReceived:true,revision:unknown.body.receipt.revision})).status,400);
    assert.equal(stock(),5);
    fs.writeFileSync(path.join(paintDir,"lg-incoming-sync.json"),JSON.stringify({OLD:{at:"2026-01-01"}}));
    const legacy=await post("/admin/api/paint/lg-incoming-sync",{...payload,invoiceRef:"OLD"});
    assert.equal(legacy.body.alreadyBooked,true);
    assert.equal(stock(),5,"historical receipts never rebook");
    console.log("LG incoming stock sync checks passed");
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
