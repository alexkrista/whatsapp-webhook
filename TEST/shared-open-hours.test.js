"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const D=require("../public/ui/baustellen-data");

test("Tower und Baustellen verwenden denselben Sammelmappen-Rest ohne Doppelzählung",()=>{
  const head={jobId:"1",status:"Auftrag",calculation:{calculatedHours:10,actualHours:8},collectionMemberJobIds:["2"]};
  const child={jobId:"2",status:"Laufend",calculation:{calculatedHours:20,actualHours:18},collectionParentJobIds:["1"]};
  const payload={jobs:[head,child]};
  assert.equal(D.openHours(head,payload.jobs),4);
  assert.equal(D.openHoursTotal(payload),4);
});

test("geschlossene Sammelmappe zählt null",()=>{
  const head={jobId:"1",status:"Geschlossen",calculation:{calculatedHours:10},collectionMemberJobIds:["2"]};
  const child={jobId:"2",status:"Geschlossen",calculation:{calculatedHours:20},collectionParentJobIds:["1"]};
  assert.equal(D.openHoursTotal({jobs:[head,child]}),0);
});
