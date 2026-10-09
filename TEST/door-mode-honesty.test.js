'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');

const SOURCE=fs.readFileSync(path.join(__dirname,'..','public','ui','access-status-ui.js'),'utf8');

async function preview(snapshot) {
  const dom=new JSDOM('<!doctype html><html><head></head><body><div class="krista-shell-main"></div></body></html>',{
    url:'https://protokoll.krista.at/kristine?token=not-real',
    runScripts:'outside-only'
  });
  const {window}=dom;
  const called=[];
  window.fetch=async(url,options)=>{
    called.push({url:String(url),method:options?.method||'GET'});
    if(String(url).startsWith('/kristine/api/access-status'))return{ok:true,json:async()=>snapshot};
    throw new Error('Unexpected request: '+url);
  };
  window.setInterval=()=>0;
  window.KristaOutlookServices=null;
  window.eval(SOURCE);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(done=>setTimeout(done,25));
  return {dom,called};
}

test('fresh GANTNER modes are not misleading physical door or lock states',async()=>{
  const snapshot={online:true,stale:false,gantner:{ok:true,doors:{
    1:{mode:'NORMAL',reason:'manueller Override Eingang'},
    2:{mode:'OPEN',reason:'Bettina'},
    3:{mode:'NORMAL',reason:'Alex'}
  }},services:{}};
  const {dom,called}=await preview(snapshot);
  try {
    const buttons=[1,2,3].map(n=>dom.window.document.querySelector('[data-door="'+n+'"]'));
    assert.ok(buttons.every(Boolean));
    assert.deepEqual(buttons.map(x=>x.querySelector('.krista-door-state').textContent),['CHIP?','FREI?','CHIP?']);
    assert.ok(buttons.every(x=>x.querySelector('.krista-dot').classList.contains('blue')));
    assert.doesNotMatch(buttons.map(x=>x.textContent).join(','),/\bZU\b|\bOFFEN\b|verschlossen/i);
    assert.match(buttons[0].title,/Keine bestätigte Verriegelung/);
    assert.match(buttons[1].title,/Ob die Tür tatsächlich entriegelt/);
    assert.match(buttons[0].title,/manueller Override Eingang/);
    assert.ok(buttons.every(x=>x.disabled===false));
    assert.ok(called.every(x=>x.method==='GET'),'No physical door actions on render');
  } finally {dom.window.close()}
});

test('stale or missing GANTNER feedback displays unknown and disables unsafe toggles',async()=>{
  const states=[
    {online:false,gantner:{doors:{1:{mode:'NORMAL'},2:{mode:'OPEN'},3:{mode:'NORMAL'}}},services:{}},
    {online:true,stale:true,gantner:{doors:{1:{mode:'OPEN'},2:{mode:'OPEN'},3:{mode:'NORMAL'}}},services:{}},
    {online:true,stale:false,gantner:{ok:false,doors:{1:{mode:'NORMAL'},2:{mode:'NORMAL'},3:{mode:'OPEN'}}},services:{}}
  ];
  for(const snapshot of states){
    const {dom}=await preview(snapshot);
    try {
      for(const n of [1,2,3]){
        const button=dom.window.document.querySelector('[data-door="'+n+'"]');
        assert.equal(button.querySelector('.krista-door-state').textContent,'?');
        assert.ok(button.querySelector('.krista-dot').classList.contains('yellow'));
        assert.ok(button.disabled,'Stale access state must not allow physical toggles');
      }
    }finally{dom.window.close()}
  }
});

test('source never labels NORMAL as closed or OPEN as physical door opening',()=>{
  assert.doesNotMatch(SOURCE,/x\?\.mode==="NORMAL"\)\s*return\{color:"red",state:"ZU"/);
  assert.doesNotMatch(SOURCE,/x\?\.mode==="OPEN"\)\s*return\{color:"green",state:"OFFEN"/);
  assert.match(SOURCE,/Sollmodus: Chip-\/Normalbetrieb/);
  assert.match(SOURCE,/Sollmodus: generelle Freigabe/);
  assert.match(SOURCE,/Keine bestätigte Verriegelung/);
});
