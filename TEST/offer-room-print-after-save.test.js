"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{JSDOM}=require("jsdom");
const source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
const last=name=>source.split("\n").filter(line=>line.startsWith(`  function ${name}(`)).at(-1);
test("room description edits and print preference use the new draft after save",()=>{
 const dom=new JSDOM('<div id="koffer"><div id="kofferRooms"><div class="koffer-room" data-room="0"><div class="koffer-room-title"></div></div></div></div>',{runScripts:"outside-only"});
 dom.window.eval(`let draft={rooms:[{id:'r1',name:'Kino',description:''}]};const esc=s=>String(s).replace(/</g,'&lt;');function refreshScopeFromRooms(){}function renderLivePreview(){};${["enhanceRoomDescriptions","syncOfferRoomDescriptions","offerRoomDescriptionRow"].map(last).join("\n")};window.h={enhanceRoomDescriptions,replace(){draft=JSON.parse(JSON.stringify(draft))},get(){return draft},row(){return offerRoomDescriptionRow({groupId:'r1',groupName:'Kino'},true)},sync(){syncOfferRoomDescriptions(draft,document.getElementById('koffer'))}};`);
 const h=dom.window.h;h.enhanceRoomDescriptions();h.replace();const text=dom.window.document.querySelector('[data-room-description]'),checkbox=dom.window.document.querySelector('[data-room-description-print]');text.value='Alle Wände streichen, Decke bleibt';text.dispatchEvent(new dom.window.Event('input'));assert(h.row().includes(text.value));checkbox.checked=false;checkbox.dispatchEvent(new dom.window.Event('change'));assert.equal(h.row(),'');h.replace();text.value='Sichtbare Beschreibung nach erneutem Speichern';checkbox.checked=true;h.sync();assert(h.row().includes(text.value));dom.window.close();
});
test("printed summary places ruled sum before discount and ruled net sum after it",()=>{
 const dom=new JSDOM('<div id="kofferLiveBody"><div class="koffer-paper"><table><tfoot></tfoot></table></div></div>',{runScripts:"outside-only"});
 dom.window.eval(`let draft={showQuantities:true,financials:{discountPercent:3,vatRate:20},positions:[]};const esc=s=>s,groupSummary=()=>({total:0});function offerSums(){return {base:22876.45,groupDiscount:0,discount:686.29,net:22190.16,vat:4438.03,gross:26628.19}};${last('enhanceFinancialPreview')};enhanceFinancialPreview();`);
 const rows=[...dom.window.document.querySelectorAll('tfoot tr')];assert.match(rows[0].textContent,/Summe.*22\.876,45/);assert(rows[0].classList.contains('koffer-paper-net'));assert.match(rows[1].textContent,/Gesamtrabatt 3 %.*686,29/);assert.match(rows[2].textContent,/Summe netto.*22\.190,16/);assert(rows[2].classList.contains('koffer-paper-net'));dom.window.close();
});
