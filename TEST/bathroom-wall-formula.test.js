"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,"..");
const ui=fs.readFileSync(path.join(root,"public/ui/baustellen-offer-builder.js"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
function context(calc){const ctx={draft:{bathroomCalc:calc},esc:v=>String(v??"")};vm.createContext(ctx);for(const name of ["bathAreas","bathCalculator"]){const line=ui.split("\n").find(l=>l.trimStart().startsWith("function "+name+"("));assert(line);vm.runInContext(line,ctx);}return ctx;}
test("bathroom wall selection calculates height and deductions, leaving floor and ceiling unchanged",()=>{
 for(const [wallFormula,expected] of [["2l_2b",22.27],["l_2b",16.702],["2l_b",15.238],[undefined,22.27],["invalid",22.27]]){
  const c=context({length:2.32,width:2.93,height:2.4,wallDeduction:2.93,wallFormula});
  const a=c.bathAreas();assert(Math.abs(a.wall-expected)<1e-8);assert(Math.abs(a.floor-6.7976)<1e-8);assert.equal(a.floor,a.ceiling);
 }
 assert.equal(context({length:2,width:3,height:2,wallFormula:"l_2b",wallDeduction:100}).bathAreas().wall,0);
});
test("bathroom wall selection is rendered and remains selected on reopening",()=>{
 const html=context({wallFormula:"2l_b"}).bathCalculator();
 assert.match(html,/data-bath-calc="wallFormula"/);
 assert.match(html,/value="2l_b" selected/);
 assert.match(html,/2 × L \+ 2 × B/);assert.match(html,/L \+ 2 × B/);assert.match(html,/2 × L \+ B/);
});
test("offer saving preserves allowed bathroom formulas and defaults older drafts",()=>{
 const expression=server.match(/const bathroomCalc=(\{wallFormula:[^;]+);for\(const key of/)[1];
 for(const value of ["2l_2b","l_2b","2l_b",undefined,"invalid"]){
  const ctx={body:{bathroomCalc:{wallFormula:value}}};vm.createContext(ctx);
  assert.equal(vm.runInContext("("+expression+").wallFormula",ctx),["2l_2b","l_2b","2l_b"].includes(value)?value:"2l_2b");
 }
});

test("bathroom deduction fields accept arithmetic and preserve numeric result on invalid input",()=>{
 const inputs=["wallDeduction","floorDeduction","ceilingDeduction"].map(key=>({dataset:{bathCalc:key},value:"",setCustomValidity(v){this.error=v}}));
 const outputs={};const ctx=context({wallDeduction:2});
 const calcLine=ui.split("\n").find(l=>l.trimStart().startsWith("function calculateNoteExpression("));vm.runInContext(calcLine,ctx);
 ctx.box={querySelectorAll:()=>inputs,querySelector:selector=>outputs[selector]??(outputs[selector]={})};ctx.syncPositions=()=>{};
 const start=ui.indexOf('box.querySelectorAll("[data-bath-calc]")'),end=ui.indexOf(';box.querySelectorAll("[data-measure]")',start);
 assert(start>=0&&end>start);vm.runInContext(ui.slice(start,end),ctx);
 for(const input of inputs){input.value="2,93 × 1,20 + (1,2/2)";input.oninput();assert(Math.abs(ctx.draft.bathroomCalc[input.dataset.bathCalc]-4.116)<1e-8);assert.equal(input.error,"");assert.equal(ctx.draft.bathroomCalc[input.dataset.bathCalc+"Formula"],input.value);}
 inputs[0].value="2*";inputs[0].oninput();assert(inputs[0].error);assert(Math.abs(ctx.draft.bathroomCalc.wallDeduction-4.116)<1e-8);
 inputs[0].value="1/0";inputs[0].oninput();assert(inputs[0].error);
 inputs[0].value="";inputs[0].oninput();assert.equal(ctx.draft.bathroomCalc.wallDeduction,0);
});
