"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {visitWorkflowData}=require("../visit-workflow-data");
test("Leere Übergabefelder verlieren die zuvor erfassten Stammdaten und WW-Verknüpfung nicht",()=>{
  const task={contactName:"Testkunde",customerMaster:{name:"Testkunde",street:"Testweg",houseNumber:"12",postalCode:"6820",city:"Frastanz",wwAddressId:"1234",wwCustomerNumber:"4711",phone:"+430000",email:"test@example.test"}};
  const row=visitWorkflowData({customer:"",address:"",customerMaster:{name:"",wwAddressId:""}},task,{customer:"",address:""});
  assert.equal(row.customer,"Testkunde");assert.equal(row.address,"Testweg 12, 6820 Frastanz");assert.equal(row.customerMaster.wwAddressId,"1234");assert.equal(row.contactEmail,"test@example.test");
});
test("In der Freigabe gewählter WW-Kunde wird übernommen, bearbeitete Baustellenadresse bleibt erhalten",()=>{
  const row=visitWorkflowData({customer:"Alter Kontakt",address:"Altweg 1, 6800 Feldkirch"},{},{customer:"Gewählter Kunde",address:"Baustellenweg 2, 6833 Klaus",customerMaster:{name:"Gewählter Kunde",address:"Wohnweg 4, 6820 Frastanz",wwAddressId:"987",wwCustomerNumber:"543",email:"kunde@example.test"}});
  assert.equal(row.customerMaster.wwAddressId,"987");assert.equal(row.customerMaster.street,"Baustellenweg");assert.equal(row.customerMaster.city,"Klaus");assert.equal(row.contactEmail,"kunde@example.test");
});
