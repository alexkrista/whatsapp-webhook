"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {JSDOM}=require("jsdom");

(async()=>{
  const dom=new JSDOM('<div class="tabs"></div><div class="wrap"></div>',{
    url:"https://example.test/admin/paint",
    runScripts:"outside-only",
  });
  const w=dom.window;
  const requests=[];
  const response=data=>({
    ok:true,status:200,json:async()=>data,clone:()=>response(data),
  });
  w.fetch=async(url,options={})=>{
    const u=new URL(url,w.location.href);
    requests.push({path:u.pathname,method:options.method||"GET",body:options.body?JSON.parse(options.body):null});
    if(u.pathname==="/health")
      return response({ok:true,version:"1.6.0",scale:{available:true},printer:{available:true}});
    if(u.pathname==="/print")return response({ok:true});
    if(u.pathname.endsWith("/jobs"))return response({jobs:[]});
    if(u.pathname.endsWith("/materials"))return response({materials:[]});
    return response({items:[],manufacturers:[]});
  };
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,60));
  try{
    for(const f of ["paint-return-stock-ui.js","paint-return-local-hardware-ui.js"]){
      w.eval(fs.readFileSync(path.join(__dirname,"../public",f),"utf8"));
    }
    await tick();
    const el=id=>w.document.getElementById(id);
    assert(el("returnFreeLabelOpen"),"Freietikett-Button fehlt");
    el("returnFreeLabelOpen").click();
    assert.equal(el("returnFreeSmall").tagName,"TEXTAREA");
    assert.equal(el("returnFreeBig").tagName,"TEXTAREA");
    el("returnFreeSmall").value="Erdgelb\n20 kg";
    el("returnFreeBig").value="60 g / 20 kg\nPutz\n2026";
    el("returnFreeBig").dispatchEvent(new w.Event("input",{bubbles:true}));
    assert.match(el("returnFreeBigPreview").textContent,/60 g \/ 20 kg\nPutz\n2026/);
    el("returnFreePrint").click();
    await tick();
    const print=requests.filter(r=>r.path==="/print");
    assert.equal(print.length,1);
    assert.equal(print[0].body.freeText,true);
    assert.deepEqual(print[0].body.smallLines,["Erdgelb","20 kg"]);
    assert.deepEqual(print[0].body.bigLines,["60 g / 20 kg","Putz","2026"]);
    assert.equal(print[0].body.returnId,undefined);
    assert.match(el("returnFreeMessage").textContent,/gedruckt/);
    el("returnFreeBig").value="1\n2\n3\n4";
    el("returnFreeBig").dispatchEvent(new w.Event("input",{bubbles:true}));
    assert.equal(el("returnFreePrint").disabled,true);
    console.log("paint free multiline UI regression test ok");
  }finally{w.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
