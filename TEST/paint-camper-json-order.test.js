"use strict";
// HTTP regression: Camper mounts a router BEFORE the global JSON parser.
// The paint preload must register POST routes AFTER JSON parsing.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "krista-paint-camper-json-"));
  const paintDir = path.join(tmp, "_kristine", "paint");
  await fs.mkdir(paintDir, { recursive: true });
  await fs.writeFile(path.join(paintDir, "articles.json"), JSON.stringify([{
    id:"LG-ABS-025", manufacturer:"Little Greene", product:"Absolute Matt",
    baseName:"Transparent", size:"0.25 L", ean:"5050173173884", stockCode:"020605TTTTT",
  }]), "utf8");

  process.env.DATA_DIR = tmp;
  process.env.ADMIN_TOKEN = "paint-camper-body-test";
  require("../paint-lab-preload.js");
  const express = require("express");
  const app = express();

  // This was the October regression: /camper's router is the FIRST app.use().
  app.use("/camper", express.Router());
  app.use(express.json({ limit:"25mb" }));

  const server = await new Promise(resolve => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const request = async (url, options = {}) => {
      const response = await fetch(base + url, {
        ...options,
        headers: { "x-admin-token":process.env.ADMIN_TOKEN,
          "content-type":"application/json", ...options.headers },
      });
      return { status:response.status, data:await response.json() };
    };

    const scan = await request("/admin/api/paint/returns/lookup?ean=5050173173884");
    assert.equal(scan.status, 200);
    assert.equal(scan.data.known, true);
    assert.equal(scan.data.material.material, "Absolute Matt");

    const fields = {
      ean:"5050173173884", weightKg:0.2914,
      jobId:"__lager__", jobName:"Lager / keine Baustelle",
    };
    // No write. The endpoint must have parsed the EAN from POST JSON;
    // the first missing value should therefore be the intentionally blank colour.
    const noColour = await request("/admin/api/paint/returns",{
      method:"POST", body:JSON.stringify(fields),
    });
    assert.equal(noColour.status,400);
    assert.match(noColour.data.error,/Farbnummer\/Farbton fehlt/);
    assert.doesNotMatch(noColour.data.error,/Barcode fehlt/);

    // Exactly one isolated booking and exactly one queued label.
    const booked = await request("/admin/api/paint/returns",{
      method:"POST", body:JSON.stringify({...fields,colour:"Bronze Red 15"}),
    });
    assert.equal(booked.status,200,JSON.stringify(booked.data));
    assert.equal(booked.data.item.ean,"5050173173884");
    assert.equal(booked.data.item.colour,"Bronze Red 15");
    assert.equal(booked.data.item.material,"Absolute Matt");
    assert.equal(booked.data.item.jobId,"__lager__");
    assert.equal(booked.data.item.returnLabel,"LG-1");
    assert.equal(booked.data.printJob.big,"LG-1");
    assert.equal(booked.data.printJob.status,"pending");

    const saved = JSON.parse(await fs.readFile(path.join(paintDir,"returns.json"),"utf8"));
    const queue = JSON.parse(await fs.readFile(path.join(paintDir,"return-print-queue.json"),"utf8"));
    assert.equal(saved.length,1,"No duplicate return stock records");
    assert.equal(queue.length,1,"Exactly one label queued; no physical Zebra printing");
    assert.equal(saved[0].ean,"5050173173884");
    console.log("Camper -> JSON parser -> Restfarben scan/book/label HTTP regression ok");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tmp,{recursive:true,force:true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
