'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');

const SOURCE=fs.readFileSync(path.join(__dirname,'../public/ui/access-status-ui.js'),'utf8');
const MODELS={normal:{1:'NORMAL',2:'NORMAL',3:'NORMAL'},open:{1:'OPEN',2:'OPEN',3:'OPEN'}};
async function run(modes,consent){
  const dom=new JSDOM('<!doctype html><html><head></head><body><div class="krista-shell-main"></div></body></html>',{
    url:'https://protokoll.krista.at/kristine?token=TEST_NOT_REAL',runScripts:'outside-only'
  });
  const {window}=dom;
  const calls=[],prompts=[];
  let state={online:true,stale:false,services:{},gantner:{ok:true,doors:{
    1:{mode:modes[1]},2:{mode:modes[2]},3:{mode:modes[3]}
  }}};
  window.confirm=text=>{prompts.push(text);return consent};
  window.alert=text=>{throw Error('Unexpected alert '+text)};
  window.fetch=async(url,options={})=>{
    const address=String(url),method=options?.method||'GET';
    calls.push({url:address,method});
    if(address.startsWith('/kristine/api/access-status')){
      return {ok:true,json:async()=>state};
    }
    if(address.includes('/access-control/toggle/')){
      const door=Number(address.split('/').pop());
      state.gantner.doors[String(door)]={mode:state.gantner.doors[String(door)].mode==='OPEN'?'NORMAL':'OPEN'};
      return {ok:true,json:async()=>({ok:true,status:state.gantner})};
    }
    if(address.endsWith('/access-control/gate')){
      return {ok:true,json:async()=>({ok:true})};
    }
    throw new Error('Unexpected URL '+address);
  };
  window.setInterval=()=>0;
  window.eval(SOURCE);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(resolve=>setTimeout(resolve,40));
  return {window,dom,calls,prompts};
}
const postCount=ctx=>ctx.calls.filter(x=>x.method==='POST').length;
async function click(ctx,selector){
  const button=ctx.window.document.querySelector(selector);
  assert.ok(button,'Button missing: '+selector);
  button.click();
  await new Promise(resolve=>setTimeout(resolve,30));
}

test('normal door refuses to open without a positive confirmation',async()=>{
  const ctx=await run(MODELS.normal,false);
  try{
    await click(ctx,'[data-door="3"]');
    assert.equal(postCount(ctx),0);
    assert.equal(ctx.prompts.length,1);
    assert.match(ctx.prompts[0],/Büro für alle freigeben/);
    assert.match(ctx.prompts[0],/FREI-Befehl/);
  }finally{ctx.dom.window.close()}
});
test('confirmed single manual door release uses unchanged toggle endpoint once',async()=>{
  const ctx=await run(MODELS.normal,true);
  try{
    await click(ctx,'[data-door="2"]');
    assert.equal(ctx.prompts.length,1);
    const posts=ctx.calls.filter(x=>x.method==='POST');
    assert.equal(posts.length,1);
    assert.match(posts[0].url,/\/access-control\/toggle\/2$/);
    assert.equal(ctx.window.document.querySelector('[data-door="2"] .krista-door-state').textContent,'FREI?');
  }finally{ctx.dom.window.close()}
});
test('return to CHIP closes immediately with no confirmation',async()=>{
  const ctx=await run(MODELS.open,false);
  try{
    await click(ctx,'[data-door="1"]');
    assert.equal(ctx.prompts.length,0);
    assert.equal(postCount(ctx),1);
    assert.match(ctx.calls.find(x=>x.method==='POST').url,/\/access-control\/toggle\/1$/);
  }finally{ctx.dom.window.close()}
});
test('header garage impulse also requires explicit consent',async()=>{
  const denied=await run(MODELS.normal,false);
  try{
    await click(denied,'[data-gate]');
    assert.equal(postCount(denied),0);
    assert.match(denied.prompts[0],/Garagentor betätigen/);
  }finally{denied.dom.window.close()}
  const allowed=await run(MODELS.normal,true);
  try{
    await click(allowed,'[data-gate]');
    assert.equal(postCount(allowed),1);
    assert.match(allowed.calls.find(x=>x.method==='POST').url,/\/access-control\/gate$/);
  }finally{allowed.dom.window.close()}
});
test('no change to existing server endpoints or automatic closures',()=>{
  const topbar=fs.readFileSync(path.join(__dirname,'../public/ui/topbar.js'),'utf8');
  assert.match(topbar,/20261010-manual-confirm-1/);
  assert.match(SOURCE,/\/access-control\/toggle\/\$\{door\}/);
  assert.doesNotMatch(SOURCE,/\/alex\/away|\/failsafe\/normal/);
});
