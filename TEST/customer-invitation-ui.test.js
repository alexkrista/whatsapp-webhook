"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");

function page(responder){
  const nodes=new Map(),calls=[],popups=[];
  const node=()=>({value:"",disabled:false,innerHTML:"",textContent:"",validity:{valid:true},classList:{add(){},remove(){},toggle(){}},addEventListener(){},appendChild(){},querySelector(){return node()},querySelectorAll(){return []}});
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)};
  const modules=[{dataset:{cpModule:"projectFile"},checked:true},{dataset:{cpModule:"regie"},checked:true}];
  const modal=node();modal.querySelector=()=>({value:"collection",addEventListener(){}});modal.querySelectorAll=selector=>selector==="[data-cp-module]"?modules:selector==="[data-cp-job]:checked"?[{dataset:{cpJob:"26018"}}]:[];
  const document={readyState:"loading",head:node(),body:node(),createElement:tag=>tag==="div"?modal:node(),getElementById:get,querySelectorAll:()=>[],addEventListener(){}};
  const location={origin:"https://protokoll.krista.at",search:"?token=test-admin-only",hash:"#24177",href:""};
  const window={kristineCustomerPortalJobs:[{jobId:"24177"}],open(){const popup={closed:false,opener:{},close(){this.closed=true},location:{replace(url){popup.url=url}}};popups.push(popup);return popup}};
  const fetch=async(raw,init={})=>{const url=new URL(raw,location.origin);calls.push({url,init});const result=await responder(url,init);return {ok:result.ok!==false,json:async()=>result}};
  const source=fs.readFileSync(path.join(__dirname,"../public/ui/kristine-customer-portal.js"),"utf8").replace('  if (document.readyState === "loading")', '  window.test={invite,save,setJob(id,ready=true){currentJobId=id;readyJobId=ready?id:""}};\n  if (document.readyState === "loading")');
  vm.runInNewContext(source,{window,document,location,fetch,URL,URLSearchParams,console});
  get("cpName").value="Testkunde";get("cpStatus").value="prepared";get("cpPhone").value="0664 1234567";window.test.setJob("24177");
  return {api:window.test,get,calls,popups,location};
}
const nativeUrl="https://protokoll.krista.at/kundenportal#zugang="+"a".repeat(32)+"."+"b".repeat(43);
const success=(url,init)=>init.method==="PUT"?{portal:JSON.parse(init.body),portalUrl:"https://protokoll.krista.at/kundenportal"}:{portalUrl:nativeUrl};

test("WhatsApp saves the selected permissions before minting a personal link, without requiring email",async()=>{
  const p=page(success);await p.api.invite("whatsapp");
  assert.equal(p.calls.length,2);assert.equal(p.calls[0].init.method,"PUT");assert.equal(p.calls[1].url.pathname,"/admin/api/job/24177/customer-portal/invitation");
  const settings=JSON.parse(p.calls[0].init.body);assert.equal(settings.customerEmail,"");assert.equal(settings.mode,"collection");assert.deepEqual(settings.includedJobIds,["26018"]);
  assert.deepEqual(JSON.parse(p.calls[1].init.body),{preview:false});
  const whatsapp=new URL(p.popups[0].url);assert.equal(whatsapp.hostname,"wa.me");assert.equal(whatsapp.pathname,"/436641234567");assert(whatsapp.searchParams.get("text").includes(nativeUrl));assert(!whatsapp.href.includes("test-admin-only"));assert.equal(p.popups[0].opener,null);
});
test("a failed settings save closes the empty window and never creates or shares a link",async()=>{
  const p=page(()=>({ok:false,error:"Speichern fehlgeschlagen"}));await p.api.invite("whatsapp");assert.equal(p.calls.length,1);assert.equal(p.popups[0].closed,true);assert.equal(p.popups[0].url,undefined);assert.match(p.get("cpMessage").textContent,/fehlgeschlagen/);
});
test("switching projects during saving cannot send an invitation for the wrong project",async()=>{
  let release;const p=page(()=>new Promise(resolve=>release=resolve)),pending=p.api.invite("whatsapp");
  p.api.setJob("25018");release({portal:{status:"prepared"},portalUrl:"https://protokoll.krista.at/kundenportal"});await pending;
  assert.equal(p.calls.length,1);assert.equal(p.popups[0].closed,true);assert.equal(p.popups[0].url,undefined);
});
test("unloaded settings and invalid phones cannot issue an invitation; preview uses a restricted invitation",async()=>{
  const p=page(success);p.api.setJob("24177",false);await p.api.invite("whatsapp");assert.equal(p.calls.length,0);
  p.api.setJob("24177");p.get("cpPhone").value="";await p.api.invite("whatsapp");assert.equal(p.calls.length,0);
  await p.api.invite("preview");assert.equal(JSON.parse(p.calls[1].init.body).preview,true);assert.equal(p.popups[0].url,nativeUrl);
});
test("office meeting form clearly marks photos as internal and submits the protection flag",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../public/ui/kristine-customer-portal.js"),"utf8");
  for(const text of ["cpPointPhotosInternal","Fotos intern","nicht in Kundenakte, Kundenportal oder Export","photosInternal","internalPhotoCount"])
    assert(source.includes(text),`missing internal photo marker: ${text}`);
});
