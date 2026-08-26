"use strict";
(function(){
  if(window.__KRISTINE_LG_MATERIAL_DOCS_DE__) return;
  window.__KRISTINE_LG_MATERIAL_DOCS_DE__=true;

  const SOURCE_URL="https://www.littlegreene.de/advice-hub/product-advice-sheets-paint";
  const norm=value=>String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"").trim();
  let rows=[];
  let byAlias=new Map();

  async function load(){
    const response=await fetch("/public/lg-product-doc-links-de.json?v=20260826-1310",{headers:{Accept:"application/json"},cache:"no-store"});
    if(!response.ok) throw new Error("Deutsche LG-Dokumentlinks konnten nicht geladen werden");
    const data=await response.json();
    rows=Array.isArray(data.products)?data.products:[];
    byAlias=new Map();
    for(const row of rows){
      for(const alias of [row.name,...(row.aliases||[])]){
        const key=norm(alias); if(key) byAlias.set(key,row);
      }
    }
  }

  function find(name){
    const key=norm(name); if(!key) return null;
    if(byAlias.has(key)) return byAlias.get(key);
    for(const [alias,row] of byAlias){
      if(key===alias || key.startsWith(alias) || alias.startsWith(key)) return row;
    }
    return null;
  }

  function link(label,url){
    const a=document.createElement("a");
    a.textContent=label;
    a.href=url;
    a.target="_blank";
    a.rel="noopener";
    a.title="Aktuelle Herstellerunterlage von Little Greene";
    return a;
  }

  function pendingOperatingInstruction(){
    const span=document.createElement("span");
    span.className="lg-doc-pending";
    span.textContent="Betriebsanweisung";
    span.title="Quelle wird nach Abstimmung mit Little Greene ergänzt";
    return span;
  }

  function fillBox(box,row){
    if(!box) return;
    box.innerHTML="";
    if(row?.productDataSheet) box.appendChild(link("TM",row.productDataSheet));
    else box.appendChild(link("TM",SOURCE_URL));
    if(row?.regulatoryAdviceSheet) box.appendChild(link("Behördliches Hinweisblatt",row.regulatoryAdviceSheet));
    else box.appendChild(link("Behördliches Hinweisblatt",SOURCE_URL));
    if(row?.operatingInstructionUrl) box.appendChild(link("Betriebsanweisung",row.operatingInstructionUrl));
    else box.appendChild(pendingOperatingInstruction());
  }

  function decorateProductRows(){
    document.querySelectorAll("#detail .product").forEach(productRow=>{
      const name=productRow.querySelector(".prodname")?.textContent?.trim();
      if(!name) return;
      const row=find(name);
      const box=productRow.querySelector(".lg-product-docs");
      if(!box) return;
      const key=norm(row?.name||name);
      if(box.dataset.materialDocsDe===key) return;
      fillBox(box,row);
      box.dataset.materialDocsDe=key;
    });
  }

  function decorateCalculator(){
    const select=document.getElementById("lgCalcProduct");
    const box=document.getElementById("lgCalcDocs");
    if(!select||!box) return;
    const option=select.selectedOptions?.[0];
    const name=option?.textContent||select.value||"";
    const row=find(name)||find(select.value);
    const key=norm(row?.name||name);
    if(box.dataset.materialDocsDe===key) return;
    box.innerHTML="";
    const title=document.createElement("b"); title.textContent="Unterlagen:"; box.appendChild(title);
    const controls=document.createElement("span"); controls.className="lgcalc-docs"; fillBox(controls,row); box.appendChild(controls);
    box.dataset.materialDocsDe=key;
  }

  function style(){
    const el=document.createElement("style");
    el.textContent=`
      .lg-doc-pending{border:1px dashed #b9beb8;background:#f5f6f4;color:#747b75;border-radius:8px;padding:6px 8px;font-size:11px;font-weight:800;cursor:help}
      .lg-product-docs a,.lg-product-docs .lg-doc-pending{white-space:nowrap}
      .lg-product-docs a:nth-child(2){min-width:164px;text-align:center}
      @media(max-width:800px){.lg-product-docs a:nth-child(2){min-width:0}}
    `;
    document.head.appendChild(el);
  }

  async function start(){
    style();
    try{await load();}catch(error){console.warn("KRISTINE LG Dokumentlinks:",error?.message||error);return;}
    decorateProductRows(); decorateCalculator();
    const detail=document.getElementById("detail");
    if(detail) new MutationObserver(()=>decorateProductRows()).observe(detail,{childList:true,subtree:true});
    const select=document.getElementById("lgCalcProduct");
    if(select) select.addEventListener("change",()=>setTimeout(decorateCalculator,0));
    document.addEventListener("change",event=>{if(event.target?.id==="lgCalcProduct") setTimeout(decorateCalculator,0);});
    const calc=document.getElementById("paintConsumptionCard");
    if(calc) new MutationObserver(()=>decorateCalculator()).observe(calc,{childList:true,subtree:true});
    new MutationObserver(()=>{decorateProductRows();decorateCalculator();}).observe(document.body,{childList:true,subtree:false});
  }

  start();
})();
