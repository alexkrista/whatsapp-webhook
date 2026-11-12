"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const src=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
const start=src.indexOf("function offerDispatchContact()"),end=src.indexOf("function offerDispatchText(",start);
assert.ok(start>0&&end>start);
function contact(owner){return vm.runInNewContext("("+src.slice(start,end).trim()+")",{job:{projectContacts:{owner},customerMaster:{name:"Kunde"}},offerRecipientNames:(owner,c)=>[owner.customer||c.name]})();}
test("Fehlt Bauherrinnen-Mail, waehle Bauherr mit seiner E-Mail",()=>{const c=contact({womanFirstName:"Karin",womanLastName:"Fritz",womanEmail:"",manFirstName:"Harry",manLastName:"Fritz",manEmail:"harry@example.test"});assert.equal(c.name,"Herr Harry Fritz");assert.equal(c.email,"harry@example.test")});
test("Bauherrin mit Mail bleibt Empfaengerin",()=>{const c=contact({womanFirstName:"Karin",womanLastName:"Fritz",womanEmail:"karin@example.test",manFirstName:"Harry",manLastName:"Fritz",manEmail:"harry@example.test"});assert.equal(c.name,"Frau Karin Fritz");assert.equal(c.email,"karin@example.test")});
test("Ohne Einzel-Mails nutze generische Adresse",()=>{const c=contact({customer:"Familie Fritz",email:"familie@example.test"});assert.equal(c.email,"familie@example.test")});