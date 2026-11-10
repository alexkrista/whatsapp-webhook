"use strict";
// Guard against literal \\n text in the Swiss/foreign payment preview and clipboard.
const assert=require("node:assert/strict");
const vm=require("node:vm");
const {execFileSync}=require("node:child_process");

const html=execFileSync("python",["-c","from brain_finance_ui import payments_page;print(payments_page())"],{
 encoding:"utf8",maxBuffer:5*1024*1024,
});
const begin=html.indexOf(" function showForeignPayment(item){");
const end=html.indexOf("\n async function directRequest",begin);
assert.ok(begin>=0 && end>begin,"Swiss payment preview function missing");

const targets={};
const dp=id=>(targets[id]??={textContent:""});
const foreignDialog={showModal(){targets.opened=true}};
const money=(n,c)=>c+" "+Number(n).toFixed(2);
const sample={
 recipient:"Zentrale Inkassostelle Schweiz",
 iban:"CH9300762011623852957",
 bic:"BLKBCH22",
 amount:164.75,
 currency:"CHF",
 invoiceNumber:"26.1034",
 purpose:"26.1034",
 bankReferenceNotice:"QR-Referenz anhand des Originals prüfen.",
};
const fn=html.slice(begin,end);
const result=vm.runInNewContext(
 "let foreignTransferText=''; let foreignSelected=null; function resetForeignXml(){} function loadForeignSources(){}\n"+fn+
 "\nshowForeignPayment(item);\n({text:foreignTransferText,shown:dp('foreignPayData').textContent});",
 {dp,foreignDialog,money,item:sample},
);
assert.equal(result.text,result.shown,"Text copied and text displayed must match");
assert.ok(result.text.includes("\n"),"Expected true LF between rows");
assert.ok(!result.text.includes(String.raw`\\n`),"Literal slash-n must not be shown or copied");
assert.match(result.text,/Empfänger: Zentrale Inkassostelle Schweiz\nIBAN:/);
assert.match(result.text,/BIC\/SWIFT: BLKBCH22\nBetrag: CHF 164.75/);
assert.equal(targets.opened,true);
console.log("CHF transfer preview and copied data use actual newlines; no bank interaction");
