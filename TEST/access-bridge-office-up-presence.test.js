"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {personPresence}=require("../access-bridge-cloud");
const {normalizeOfficeTimeData}=require("../office-time");

const date="2026-10-14";
const bettina=(type,at,more={})=>({
  id:"evt-"+type+"-"+at,employeeId:"bettina-eberle-nigsch-msrhy4d9-tz8d",
  employeeName:"Bettina Eberle-Nigsch",date,type,at,
  createdAt:"2026-10-14T"+at+":00+02:00",...more
});

test("Bettina bleibt nach einer alten Tagesfreigabe anwesend: 022 Start wird zu up",()=>{
  const original=[bettina("start","07:45",{jobId:"022",source:"kgo-office-core"}),
                  {employeeId:"other",employeeName:"Other",date:"2026-10-09",type:"ende",at:"17:00"}];
  assert.equal(personPresence(original,"Bettina",date).present,true);
  // Exact production writeJson(TIME_EVENTS) conversion used for day-release.
  const normalized=normalizeOfficeTimeData(original);
  assert.equal(normalized[0].type,"up");
  assert.equal(normalized[0].unproductiveCode,"022");
  const found=personPresence(normalized,"Bettina",date);
  assert.equal(found.present,true);
  assert.equal(found.lastAt,"07:45");
  assert.equal(found.lastType,"up");
  assert.equal(personPresence(normalized,"Dunja",date).present,false);
});

test("Unproductive vacation or illness (up) cannot unlock office doors",()=>{
  const rows=[bettina("up","08:00",{jobId:"900",unproductiveCode:"900",reason:"Urlaub"})];
  assert.equal(personPresence(rows,"Bettina",date).present,false);
});

test("Documented Feierabend ends presence even after normalized office start",()=>{
  const rows=[
    bettina("up","07:45",{jobId:"022",unproductiveCode:"022"}),
    bettina("ende","12:00",{jobId:"022",createdAt:"2026-10-14T10:00:00Z"})
  ];
  assert.equal(personPresence(rows,"Bettina",date).present,false);
  assert.equal(personPresence(rows,"Bettina",date).lastType,"ende");
});

test("An old event appended by a backfill does not overwrite later chronological punches",()=>{
  const rows=[
    bettina("ende","12:00",{createdAt:"2026-10-14T10:00:00Z"}),
    bettina("up","07:45",{jobId:"022",unproductiveCode:"022",createdAt:"2026-10-14T05:45:00Z"})
  ];
  assert.equal(personPresence(rows,"Bettina",date).present,false);
});

test("Pause and Mittag do not mark a physically present office employee as absent",()=>{
  for(const type of ["pause","mittag","weiter"]){
    const rows=[bettina("up","07:45",{jobId:"022",unproductiveCode:"022"}),bettina(type,"09:00",{createdAt:"2026-10-14T07:00:00Z"})];
    assert.equal(personPresence(rows,"Bettina",date).present,true,type);
  }
});
