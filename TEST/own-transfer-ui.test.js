'use strict';
const {JSDOM}=require('jsdom'),fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
 const html=fs.readFileSync('public/konfipay.html','utf8'),dom=new JSDOM(html,{runScripts:'outside-only',url:'https://example.test'}),w=dom.window,calls=[];
 w.$=id=>w.document.getElementById(id);w.money=(n,c)=>n+' '+c;w.statusName=x=>x;w.loadHistory=async()=>{};w.loadExpected=async()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.api=async(path,body)=>{calls.push({path,body});if(path==='revolut-transfer-prepare')return {filename:'test.xml',xml:'<xml/>',source:{name:'Hypo',iban:'AT1'},target:{name:'Revolut Business',iban:'LT2',beneficiary:'Test'},amount:'1500.00',purpose:'Umbuchung'};if(path==='payment-prepare')return {draft:'reviewed'};return {results:[{name:'Umbuchung',state:'submitted'}]};};
 w.eval('let revolutTransferDraft=null,revolutTransferSending=false;'+html.slice(html.indexOf('function revolutTransferInputs()'),html.indexOf('\nloadRevolutTransferContext();')));
 w.$('revolutTransferAmount').value='1500';w.$('revolutTransferPrepare').click();await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(calls.map(x=>x.path),['revolut-transfer-prepare','payment-prepare']);
 assert.equal(w.$('revolutTransferReview').open,true);assert.match(w.$('revolutTransferReviewText').textContent,/1500.00 EUR/);
 w.$('revolutTransferSubmit').click();w.$('revolutTransferSubmit').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(calls.filter(x=>x.path==='payment-submit').length,1);assert.equal(calls.at(-1).body.confirmed,true);
 w.$('revolutTransferReview').close();w.$('revolutTransferPrepare').click();await new Promise(r=>setTimeout(r,10));w.$('revolutTransferAmount').value='1600';w.$('revolutTransferSubmit').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(calls.filter(x=>x.path==='payment-submit').length,1,'changed amount requires a new review');
 w.close();console.log('Own transfer: direct review, explicit submit, double-click and stale amount checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
