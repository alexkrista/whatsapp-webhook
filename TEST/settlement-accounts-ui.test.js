'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const TEMPLATE=fs.readFileSync(path.join(__dirname,'../public/settlement-accounts.html'),'utf8');

async function setup(account,existing=[],consent=true){
  let count=0;
  let balances={private:'0.00',wage:'0.00',clearing:'0.00'};
  const html=TEMPLATE.replace('__SETTLEMENT_ACCOUNT__',account).replace('__SETTLEMENT_CSRF__','FAKE_TEST_CSRF');
  const dom=new JSDOM(html,{url:'https://pc-alex02.tail610122.ts.net/incoming/'+(account==='alex'?'alex-privat':'dlz'),runScripts:'outside-only'});
  const {window}=dom,calls=[];
  Object.defineProperty(window.crypto,'randomUUID',{value:()=>'synthetic-uuid-'+(++count).toString().padStart(12,'0')});
  window.HTMLElement.prototype.scrollIntoView=function(){};
  window.prompt=()=>consent?'Falsche Zuordnung':null;
  window.confirm=()=>consent;
  const rows=existing.slice();
  const json=(x)=>({ok:true,json:async()=>x});
  window.fetch=async(url,options={})=>{
    const address=String(url),method=options.method||'GET';
    calls.push({url:address,method,body:options.body,headers:options.headers||{}});
    if(method==='POST'&&address.includes('action=add')){
      const item=JSON.parse(options.body);
      const sign=['withdrawal','wage_paid','liability_settlement'].includes(item.kind)?-1:1;
      const signed=Number(item.amount)*sign;
      const row={id:rows.length+1,account,kind:item.kind,amount:signed.toFixed(2),date:item.date,counterparty:item.counterparty,purpose:item.purpose,reference:item.reference,documents:0,createdAt:'',balanceType:item.kind.startsWith('wage_')?'wage':account==='alex'?'private':'clearing',runningBalance:signed.toFixed(2)};
      rows.push(row);
      balances[row.balanceType]=(Number(balances[row.balanceType])+signed).toFixed(2);
      return json({ok:true,item:row});
    }
    if(method==='GET'&&address.includes('action=list')){
      return json({ok:true,rows:rows.slice().reverse(),balances,count:rows.length,note:'Test'});
    }
    if(method==='GET'&&address.includes('action=debtors')){
      return json({ok:true,items:[{invoiceId:95,invoiceNumber:'202610003',customer:'Testkunde',open:'120.00'}]});
    }
    if(method==='GET'&&address.includes('action=files'))return json({ok:true,items:[]});
    if(method==='POST'&&address.includes('action=reverse'))return json({ok:true,item:{}});
    throw Error('Unexpected fetch '+address+' method='+method);
  };
  const script=window.document.querySelector('script');
  window.eval(script.textContent);
  await new Promise(resolve=>setTimeout(resolve,45));
  return{window,dom,calls,rows};
}
async function submit(ctx,kind='contribution'){
  const {window}=ctx,doc=window.document;
  doc.querySelector('#kind').value=kind;
  doc.querySelector('#kind').dispatchEvent(new window.Event('change',{bubbles:true}));
  doc.querySelector('#amount').value='100.00';
  doc.querySelector('#counterparty').value='Muster';
  doc.querySelector('#purpose').value='Buchungstest';
  doc.querySelector('#reference').value='Beleg Muster';
  if(kind==='customer_receipt'){
    doc.querySelector('#externalRef').value='EXTERNAL-ID';
    doc.querySelector('#invoiceId').value='95';
  }
  doc.querySelector('#booking').dispatchEvent(new window.Event('submit',{cancelable:true,bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,90));
}

test('Alex Privat displays two separate balances, and uses anti-CSRF POST',async()=>{
  const ctx=await setup('alex');
  try{
    assert.match(ctx.window.document.querySelector('h1').textContent,/Alex Privat/);
    assert.match(ctx.window.document.querySelector('#balances').textContent,/Lohnforderung/);
    await submit(ctx);
    const posts=ctx.calls.filter(x=>x.method==='POST');
    assert.equal(posts.length,1);
    assert.equal(posts[0].headers['X-Settlement-Token'],'FAKE_TEST_CSRF');
    assert.equal(JSON.parse(posts[0].body).kind,'contribution');
    assert.match(ctx.window.document.querySelector('#balances').textContent,/100,00/);
  }finally{ctx.dom.window.close()}
});

test('DLZ customer receipt requires an invoice and external reference',async()=>{
  const ctx=await setup('dlz');
  try{
    assert.match(ctx.window.document.querySelector('h1').textContent,/DLZ/);
    ctx.window.document.querySelector('#kind').value='customer_receipt';
    ctx.window.document.querySelector('#kind').dispatchEvent(new ctx.window.Event('change'));
    assert.equal(ctx.window.document.querySelector('#invoiceId').required,true);
    assert.equal(ctx.window.document.querySelector('#externalRef').required,true);
    await submit(ctx,'customer_receipt');
    const payload=JSON.parse(ctx.calls.find(x=>x.method==='POST').body);
    assert.equal(payload.invoiceId,'95');
    assert.equal(payload.externalRef,'EXTERNAL-ID');
    assert.match(ctx.window.document.querySelector('#balances').textContent,/100,00/);
  }finally{ctx.dom.window.close()}
});

test('Untrusted historic notes cannot inject HTML into the journal',async()=>{
  const ctx=await setup('alex',[{
    id:'bank-1',kind:'contribution',amount:'250.00',date:'2026-10-01',
    balanceType:'private',runningBalance:'250.00',origin:'KONFIPAY',
    counterparty:'<img src=x onerror=alert(1)>',purpose:'<script>alert(1)</script>',reference:'bank-ref',documents:0,
  }]);
  try{
    assert.equal(ctx.window.document.querySelectorAll('#rows img,#rows script').length,0);
    assert.match(ctx.window.document.querySelector('#rows').textContent,/<img/);
  }finally{ctx.dom.window.close()}
});
