"use strict";
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
(async()=>{
const html=fs.readFileSync(path.join(__dirname,'../public/paint-lab.html'),'utf8');
const dom=new JSDOM('<div id="detail"></div><div id="results"></div><input id="q"><div id="recipeTitle"></div><div id="recipeBody"></div><div id="recipeModal"></div>',{runScripts:'outside-only',url:'https://example.test'});
const w=dom.window, calls=[];
try{
 w.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));w.stockClass=()=>'';w.money=String;
 w.selected={name:"Adventurer 7"};w.system="LG";
 const p={productId:11,productName:'Absolute Matt Emulsion',baseName:'Transparent',recipeAvailable:true,sizes:[{canSizeId:1,size:'1 L',stock:2}],oldRecipe:{baseName:'Extra Deep'}};
 w.api=async url=>{calls.push(url);if(url.includes('/color/'))return {products:[{...p,baseName:'Extra Deep'}]};return {formulaId:1,baseName:'Extra Deep',canSize:'1 L',recipeUnitMl:1,legacy:true,recipe:[]};};
 for(const line of html.split('\n'))if(line.startsWith('function renderDetail(')||line.startsWith('window.openRecipe='))w.eval(line);
 w.eval(fs.readFileSync(path.join(__dirname,'../public/paint-catalog-history-ui.js'),'utf8'));
 w.renderDetail({color:{id:1,name:'Adventurer 7'},products:[p,{...p,productId:16,productName:'ASP',oldRecipe:null}]});
 assert.equal(w.document.querySelectorAll('[data-old-colour]').length,1);
 const errors=[];w.alert=message=>errors.push(message);
 w.prompt=()=> '1';w.document.querySelector('[data-old-colour]').click();await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(errors,[]);
 assert(calls.some(x=>x.includes('/recipe?')&&x.includes('catalogVersion=before-2026-09')));
 assert.match(w.document.querySelector('#recipeTitle').textContent,/Extra Deep.*ALT/);
 w.renderDetail({color:{id:'old:2',name:'Old colour',legacy:true},products:[]});assert.match(w.document.querySelector('#detail').textContent,/Alt · vor 09\/2026/);
 console.log('Archive button visibility, old-basis request and red legacy label tests passed');
}finally{w.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
