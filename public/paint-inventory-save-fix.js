"use strict";
(function(){
  if(window.__KRISTINE_INVENTORY_SAVE_FIX__) return;
  window.__KRISTINE_INVENTORY_SAVE_FIX__=true;

  const token=new URLSearchParams(location.search).get("token")||"";
  const nativeFetch=window.fetch.bind(window);
  let saving=false;

  function withToken(url){const join=url.includes("?")?"&":"?";return url+(token?join+"token="+encodeURIComponent(token):"");}
  async function api(url,opt={}){
    const response=await nativeFetch(withToken(url),{
      ...opt,
      headers:{"Content-Type":"application/json",...(opt.headers||{})},
    });
    const data=await response.json().catch(()=>({ok:false,error:"Keine JSON-Antwort"}));
    if(!response.ok||data.ok===false) throw new Error(data.error||("HTTP "+response.status));
    return data;
  }

  function dirtyRows(){return [...document.querySelectorAll("[data-inv-row]")].filter(row=>row.dataset.stockDirty==="1");}
  function updateSaveButton(){
    const button=document.getElementById("inventorySave");
    if(!button||saving)return;
    const count=dirtyRows().length;
    const label=count?`Änderungen speichern (${count})`:"Inventur + Bestellung speichern";
    if(button.textContent!==label) button.textContent=label;
  }

  function prepareInput(input){
    if(!input||input.dataset.kristaSaveFix==="1")return;
    const row=input.closest("[data-inv-row]");
    if(!row)return;
    input.dataset.kristaSaveFix="1";
    const stock=String(row.dataset.stock??input.placeholder??"0");
    input.value=stock;
    input.placeholder="";
    input.dataset.originalStock=stock;
    row.dataset.stockDirty="0";
    input.addEventListener("focus",()=>setTimeout(()=>{try{input.select()}catch{}},0));
    const mark=()=>{
      const current=String(input.value??"").trim();
      const original=String(input.dataset.originalStock??"").trim();
      row.dataset.stockDirty=current!==original?"1":"0";
      input.style.borderColor=row.dataset.stockDirty==="1"?"#b68433":"";
      input.style.background=row.dataset.stockDirty==="1"?"#fffaf0":"";
      updateSaveButton();
    };
    input.addEventListener("input",mark);
    input.addEventListener("change",mark);
  }

  function installInputs(){
    document.querySelectorAll(".inventory-ist").forEach(prepareInput);
    updateSaveButton();
  }

  async function saveAll(){
    if(saving)return;
    const status=document.getElementById("inventoryStatus");
    const rows=[...document.querySelectorAll("[data-inv-row]")];
    const counts=rows.filter(row=>row.dataset.stockDirty==="1").map(row=>({
      articleId:row.dataset.id,
      stock:row.querySelector(".inventory-ist")?.value,
    })).filter(row=>row.articleId&&row.stock!=="");
    const levels=rows.filter(row=>row.dataset.levelDirty==="1").map(row=>({
      articleId:row.dataset.id,
      minimumStock:row.querySelector(".inventory-min")?.value,
      targetStock:row.querySelector(".inventory-target")?.value,
    }));
    const orders=rows.filter(row=>row.dataset.orderDirty==="1").map(row=>({
      articleId:row.dataset.id,
      orderQuantityOverride:row.dataset.orderMode==="auto"?null:row.querySelector(".inventory-order-input")?.value,
    }));

    if(!counts.length&&!levels.length&&!orders.length){
      alert("Keine Änderungen zum Speichern.");
      return;
    }
    if(!confirm(`${counts.length} Ist-Änderungen, ${levels.length} Soll/Mindest-Änderungen und ${orders.length} Bestellmengen speichern?`))return;

    saving=true;
    const button=document.getElementById("inventorySave");
    if(button){button.disabled=true;if(button.textContent!=="Speichert …")button.textContent="Speichert …";}
    if(status)status.textContent="Änderungen werden gespeichert …";

    try{
      let changedCount=0,changedLevels=0,changedOrders=0;
      if(counts.length){
        const result=await api("/admin/api/paint/inventory/count",{method:"POST",body:JSON.stringify({rows:counts,user:"Inventur manuell PC"})});
        changedCount=Number(result.changed||0);
      }
      if(levels.length){
        const result=await api("/admin/api/paint/inventory/levels",{method:"POST",body:JSON.stringify({rows:levels})});
        changedLevels=Number(result.changed||0);
      }
      if(orders.length){
        const result=await api("/admin/api/paint/inventory/order",{method:"POST",body:JSON.stringify({rows:orders})});
        changedOrders=Number(result.changed||0);
      }

      if(counts.length){
        const verify=await api("/admin/api/paint/inventory");
        const byId=new Map((verify.items||[]).map(item=>[String(item.id),Number(item.stock)]));
        const failed=counts.filter(row=>Number(row.stock)!==Number(byId.get(String(row.articleId))));
        if(failed.length){
          throw new Error(`Speicherprüfung fehlgeschlagen (${failed.length} Ist-Werte stimmen danach nicht).`);
        }
      }

      if(status)status.textContent=`Gespeichert: ${changedCount} Ist · ${changedLevels} Soll/Mindest · ${changedOrders} Bestellmengen ✓`;
      document.dispatchEvent(new CustomEvent("kristine:paint-stock-changed",{detail:{source:"inventory-manual-save"}}));
      setTimeout(()=>document.getElementById("inventoryReload")?.click(),300);
    }catch(error){
      if(status)status.textContent=`NICHT gespeichert: ${String(error?.message||error)}`;
      alert(`Speichern fehlgeschlagen:\n${String(error?.message||error)}`);
    }finally{
      saving=false;
      if(button)button.disabled=false;
      setTimeout(updateSaveButton,400);
    }
  }

  document.addEventListener("click",event=>{
    const button=event.target?.closest?.("#inventorySave");
    if(!button)return;
    event.preventDefault();
    event.stopImmediatePropagation();
    saveAll();
  },true);

  function startObserver(){
    const wrap=document.getElementById("inventoryWrap");
    if(wrap){
      new MutationObserver(()=>installInputs()).observe(wrap,{childList:true,subtree:true});
      installInputs();
      return;
    }
    const boot=new MutationObserver(()=>{
      const found=document.getElementById("inventoryWrap");
      if(!found)return;
      boot.disconnect();
      new MutationObserver(()=>installInputs()).observe(found,{childList:true,subtree:true});
      installInputs();
    });
    boot.observe(document.body,{childList:true,subtree:true});
  }

  startObserver();
})();
