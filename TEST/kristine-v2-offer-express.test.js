"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const core=require("../public/ui/kristine-v2-offer-express-core");
const {createPreviewServer}=require("../tools/kristine-v2-preview-server");

const sample="Eingang und Stiegenhaus: Wände 48,20 m², Decke 16,40 m², Boden 16,40 m², Acrylfugen 22 m. Abdecken, spachteln, grundieren, streichen und Acrylfugen herstellen.";

test("German and native HTML quantities are parsed without multiplying by 100",()=>{
  assert.equal(core.parseNumber("48,20"),48.2);
  assert.equal(core.parseNumber("48.20"),48.2);
  assert.equal(core.parseNumber("1.000,50"),1000.5);
  assert.equal(core.parseNumber("0.75"),0.75);
  assert.equal(core.parseNumber(""),null);
  assert.equal(core.parseNumber("-3"),null);
});

test("Thirty-second Wallner example makes six independently editable real positions",()=>{
  const d=core.fromBrief("Familie Wallner","Eingang + Stiegenhaus",sample,"innen");
  const s=d.sections[0],r=s.rooms[0];
  assert.equal(r.name,"Eingang und Stiegenhaus");
  assert.deepEqual(r.measures,{walls:48.2,ceiling:16.4,floor:16.4,linear:22,pieces:null});
  assert.deepEqual(s.positions.map(p=>p.templateKey),["cover","filler","primer","paint","acryl","ceiling"]);
  assert.deepEqual(s.positions.map(p=>p.quantity),[16.4,48.2,48.2,48.2,22,16.4]);
  assert.equal(new Set(s.positions.map(p=>p.id)).size,6);
  assert.equal(core.sum(d).net,617.44);
  assert.equal(core.sum(d).missingRate,2);
  assert.equal(core.sum(d).ready,false);
});

test("Individual deletion is persistent and does not affect other package positions",()=>{
  const d=core.createDraft("Musterkunde","Malerarbeiten");
  const s=d.sections[0];
  core.addPackage(d,s.id,"einfach");
  assert.equal(s.positions.length,3);
  const saved=s.positions[1].id;
  assert.equal(core.removePosition(d,s.id,s.positions[0].id),true);
  assert.equal(s.positions.length,2);
  assert.equal(s.positions[0].id,saved);
  core.changeRoomMeasure(d,s.id,s.rooms[0].id,"walls","30");
  assert.equal(s.positions.length,2);
  assert.equal(s.positions[0].quantity,30);
});

test("Measurement-linked positions update; manual overrides remain unchanged",()=>{
  const d=core.createDraft("Muster","Malerarbeiten"),s=d.sections[0];
  core.changeRoomMeasure(d,s.id,s.rooms[0].id,"walls","26.5");
  const [a,b]=core.addPackage(d,s.id,"innen").filter(p=>p.basis==="walls");
  assert.equal(a.quantity,26.5);
  core.setQuantity(d,s.id,a.id,"12,5");
  core.changeRoomMeasure(d,s.id,s.rooms[0].id,"walls","30");
  assert.equal(a.quantity,12.5);
  assert.equal(a.basis,"manual");
  assert.equal(b.quantity,30);
});

test("New section can inherit all rooms and takeoff without inheriting positions",()=>{
  const d=core.createDraft("Muster","Haus"),s=d.sections[0];
  core.changeRoomMeasure(d,s.id,s.rooms[0].id,"walls","40");
  const second=core.addRoom(d,s.id,"Küche",false);
  core.changeRoomMeasure(d,s.id,second.id,"floor","12");
  core.addPackage(d,s.id,"einfach");
  const next=core.addSection(d,"Abschnitt 2 · Weitere Arbeiten","uebernehmen",s.id);
  assert.equal(next.rooms.length,2);
  assert.notEqual(next.rooms[0].id,s.rooms[0].id);
  assert.equal(next.rooms[0].measures.walls,40);
  assert.equal(next.rooms[1].measures.floor,12);
  assert.equal(next.positions.length,0);
  const empty=core.addSection(d,"Abschnitt 3","neu",s.id);
  assert.equal(empty.rooms[0].measures.walls,null);
  assert.equal(empty.rooms.length,1);
  assert.equal(core.validate(d),true);
});

test("Provisional prices never silently become final prices",()=>{
  const d=core.createDraft("Muster","Test"),s=d.sections[0],r=s.rooms[0];
  core.changeRoomMeasure(d,s.id,r.id,"walls","10");
  const [p]=core.addPackage(d,s.id,"fassade").filter(x=>x.templateKey==="facade-primer");
  assert.equal(p.unitPrice,2.63);
  assert.equal(p.priceConfirmed,false);
  assert.equal(core.sum(d).ready,false);
  const q=s.positions.filter(x=>x.quantity!==null&&x.unitPrice!==null);
  for(const row of q)core.setRate(d,s.id,row.id,String(row.unitPrice));
  assert.equal(core.sum(d).ready,true);
  core.addPosition(d,s.id,"bath-finish");
  assert.equal(core.sum(d).ready,false);
});

test("Authenticated preview exposes offer page/assets but rejects every mutation",async t=>{
  const password="an-isolated-preview-strong-passphrase";
  const server=createPreviewServer({password});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  const base="http://127.0.0.1:"+server.address().port;
  const auth="Basic "+Buffer.from("v2:"+password).toString("base64");
  assert.equal((await fetch(base+"/angebot/express")).status,401);
  assert.equal((await fetch(base+"/angebot/express",{method:"POST",headers:{authorization:auth}})).status,405);
  const html=await fetch(base+"/angebot/express",{headers:{authorization:auth}});
  assert.equal(html.status,200);
  const page=await html.text();
  assert.match(page,/id="ox-generate"/);
  assert.match(page,/kristine-v2-offer-express-ui.js/);
  assert.match(page,/nicht.*in KRISTINE gespeichert/i);
  const asset=await fetch(base+"/public/ui/kristine-v2-offer-express-core.js",{headers:{authorization:auth}});
  assert.equal(asset.status,200);
  assert.match(await asset.text(),/createDraft/);
  const overview=await fetch(base+"/preview?world=kristine",{headers:{authorization:auth}});
  assert.equal(overview.status,200);
  assert.match(await overview.text(),/href="\/angebot\/express"/);
});
