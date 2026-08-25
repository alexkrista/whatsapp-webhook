"use strict";
(function(){
  if(window.__KRISTINE_LG_CONSUMPTION_DOCS__) return;
  window.__KRISTINE_LG_CONSUMPTION_DOCS__=true;

  const norm=value=>String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"").trim();
  const fmt=value=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:2}).format(Number(value||0));
  let knowledge=null;
  let products=[];
  let aliasMap=new Map();

  async function loadKnowledge(){
    if(knowledge) return knowledge;
    const response=await fetch("/public/lg-product-knowledge.json?v=20260825-1610",{headers:{Accept:"application/json"}});
    if(!response.ok) throw new Error("LG Produktwissen konnte nicht geladen werden");
    knowledge=await response.json();
    products=Array.isArray(knowledge.products)?knowledge.products:[];
    aliasMap=new Map();
    for(const product of products){
      for(const alias of [product.name,product.displayName,...(product.aliases||[])]){
        if(alias) aliasMap.set(norm(alias),product);
      }
    }
    return knowledge;
  }

  function findProduct(name){
    const key=norm(name);
    if(!key) return null;
    if(aliasMap.has(key)) return aliasMap.get(key);
    for(const [alias,product] of aliasMap){
      if(key===alias || key.startsWith(alias) || alias.startsWith(key)) return product;
    }
    return null;
  }

  function style(){
    if(document.getElementById("lgConsumptionDocsStyle")) return;
    const el=document.createElement("style");
    el.id="lgConsumptionDocsStyle";
    el.textContent=`
      .lgcalc-card{margin-top:14px}.lgcalc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.lgcalc-head h2{margin:0}.lgcalc-grid{display:grid;grid-template-columns:minmax(220px,2fr) 130px 110px 110px;gap:9px;margin-top:12px;align-items:end}.lgcalc-grid label{display:grid;gap:4px;font-size:11px;font-weight:800;color:var(--muted)}.lgcalc-grid select,.lgcalc-grid input{width:100%;padding:10px;border:1px solid #cfd1ca;border-radius:9px;background:white;font-size:15px}.lgcalc-result{margin-top:10px;padding:11px 12px;border:1px solid #d8dfd9;border-radius:11px;background:#f6f8f5;min-height:50px}.lgcalc-main{font-size:18px;font-weight:900}.lgcalc-sub{font-size:12px;color:var(--muted);margin-top:3px}.lgcalc-docs,.lg-product-docs{display:flex;gap:6px;flex-wrap:wrap}.lgcalc-docs a,.lg-product-docs a,.lg-product-docs button{border:1px solid var(--line);background:#f4f7f4;color:inherit;text-decoration:none;border-radius:8px;padding:6px 8px;font-size:11px;font-weight:800;cursor:pointer}.lgcalc-docs a:hover,.lg-product-docs a:hover,.lg-product-docs button:hover{background:#e9efea}.lg-product-docs{margin-left:auto;justify-content:flex-end}.lg-product-legacy{margin-top:5px;font-size:11px;color:#9b5e12}.lgcalc-warning{font-size:11px;color:#6e756f;margin-top:7px}.lgcalc-docline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px}.lgcalc-docline b{font-size:12px}
      @media(max-width:800px){.lgcalc-grid{grid-template-columns:1fr 1fr}.lg-product-docs{width:100%;justify-content:flex-start;margin-left:0}.prodhead{flex-wrap:wrap}}
      @media(max-width:520px){.lgcalc-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(el);
  }

  function optimalPacks(liters,packSizes){
    const sizes=(packSizes||[]).map(Number).filter(x=>x>0).sort((a,b)=>b-a);
    if(!sizes.length || !(liters>0)) return null;
    const step=0.25;
    const target=Math.ceil(liters/step);
    const coins=sizes.map(size=>({size,units:Math.round(size/step)})).filter(x=>x.units>0);
    const maxCoin=Math.max(...coins.map(x=>x.units));
    const limit=target+maxCoin;
    const dp=Array(limit+1).fill(null); dp[0]={cans:0,counts:Array(coins.length).fill(0)};
    for(let units=1;units<=limit;units++){
      let best=null;
      coins.forEach((coin,index)=>{
        if(units<coin.units || !dp[units-coin.units]) return;
        const prev=dp[units-coin.units];
        const candidate={cans:prev.cans+1,counts:[...prev.counts]};candidate.counts[index]++;
        if(!best || candidate.cans<best.cans) best=candidate;
      });
      dp[units]=best;
    }
    let chosen=null;
    for(let units=target;units<=limit;units++){
      if(!dp[units]) continue;
      const waste=units*step-liters;
      if(!chosen || waste<chosen.waste-0.0001 || (Math.abs(waste-chosen.waste)<0.0001 && dp[units].cans<chosen.cans)){
        chosen={units,waste,cans:dp[units].cans,counts:dp[units].counts};
      }
    }
    if(!chosen) return null;
    const parts=[];
    chosen.counts.forEach((count,index)=>{if(count) parts.push(`${count} × ${String(coins[index].size).replace(".",",")} L`);});
    return {text:parts.join(" + "),total:chosen.units*step,waste:chosen.waste};
  }

  function setProductDocs(product){
    const box=document.getElementById("lgCalcDocs");
    if(!box || !product || !knowledge) return;
    const subject=encodeURIComponent(`Safety Data Sheet / Sicherheitsdatenblatt – Little Greene ${product.name}`);
    const body=encodeURIComponent(`Please send the current Safety Data Sheet (SDS/MSDS) for Little Greene ${product.name}.`);
    box.innerHTML=`
      <b>Dokumente:</b>
      <a href="${product.productDataSheet}" target="_blank" rel="noopener">TM</a>
      <a href="${product.regulatoryAdviceSheet}" target="_blank" rel="noopener">Regulatorisch</a>
      <a href="mailto:${knowledge.sdsRequestEmail}?subject=${subject}&body=${body}">SDB anfordern</a>
      <a href="${knowledge.technicalInfoUrl}" target="_blank" rel="noopener">LG Datenblätter</a>`;
  }

  function recalc(){
    const select=document.getElementById("lgCalcProduct");
    const area=Number(String(document.getElementById("lgCalcArea")?.value||"").replace(",","."));
    const coats=Math.max(0,Number(document.getElementById("lgCalcCoats")?.value||0));
    const reserve=Math.max(0,Number(document.getElementById("lgCalcReserve")?.value||0));
    const result=document.getElementById("lgCalcResult");
    const product=products.find(p=>p.name===select?.value)||products[0];
    if(!product||!result) return;
    setProductDocs(product);
    const info=document.getElementById("lgCalcProductInfo");
    if(info) info.textContent=`TM: ${product.coverageM2PerL} m²/L je Anstrich · empfohlen ${product.coatsMin}${product.coatsMax!==product.coatsMin?`–${product.coatsMax}`:""} Anstrich${product.coatsMax===1?"":"e"}`;
    if(!(area>0) || !(coats>0)){
      result.innerHTML='<div class="lgcalc-sub">Fläche eingeben – KRISTINE rechnet Literbedarf und passende Gebinde.</div>';
      return;
    }
    const theoretical=area*coats/Number(product.coverageM2PerL||1);
    const withReserve=theoretical*(1+reserve/100);
    const perM2=coats/Number(product.coverageM2PerL||1);
    const plan=optimalPacks(withReserve,product.packSizesL);
    const colour=document.querySelector("#detail .selected h2")?.textContent?.trim()||"";
    result.innerHTML=`
      <div class="lgcalc-main">${fmt(withReserve)} L${reserve?` inkl. ${fmt(reserve)} % Reserve`:""}</div>
      <div class="lgcalc-sub">${colour?`Farbton ${colour} · `:""}${fmt(area)} m² × ${fmt(coats)} Anstrich${coats===1?"":"e"} ÷ ${fmt(product.coverageM2PerL)} m²/L = ${fmt(theoretical)} L theoretisch · ${fmt(perM2)} L/m² gesamt</div>
      ${plan?`<div class="lgcalc-sub"><b>Gebinde:</b> ${plan.text} = ${fmt(plan.total)} L${plan.waste>0.001?` · Rest ca. ${fmt(plan.waste)} L`:""}</div>`:""}
      <div class="lgcalc-warning">Richtwert aus aktuellem Little-Greene-TM. Rauheit, Saugfähigkeit, Verdünnung und Applikationsart können den tatsächlichen Verbrauch verändern.</div>`;
  }

  function installCalculator(){
    if(document.getElementById("paintConsumptionCard")) return true;
    const searchSection=document.getElementById("tab-search");
    const detail=document.getElementById("detail");
    if(!searchSection||!detail||!products.length) return false;
    const card=document.createElement("div");
    card.id="paintConsumptionCard";card.className="card lgcalc-card";
    card.innerHTML=`
      <div class="lgcalc-head"><div><h2>Verbrauchsrechner</h2><div class="muted" id="lgCalcProductInfo"></div></div></div>
      <div class="lgcalc-grid">
        <label>Material<select id="lgCalcProduct"></select></label>
        <label>Fläche m²<input id="lgCalcArea" type="number" min="0" step="0.1" inputmode="decimal" placeholder="z. B. 85"></label>
        <label>Anstriche<input id="lgCalcCoats" type="number" min="1" max="6" step="1"></label>
        <label>Reserve %<input id="lgCalcReserve" type="number" min="0" max="50" step="1" value="10"></label>
      </div>
      <div id="lgCalcResult" class="lgcalc-result"></div>
      <div id="lgCalcDocs" class="lgcalc-docline lgcalc-docs"></div>`;
    searchSection.insertBefore(card,detail);
    const select=card.querySelector("#lgCalcProduct");
    for(const product of products){
      const option=document.createElement("option");option.value=product.name;option.textContent=product.displayName||product.name;select.appendChild(option);
    }
    const syncCoats=()=>{
      const p=products.find(x=>x.name===select.value);if(p) document.getElementById("lgCalcCoats").value=String(p.defaultCoats||p.coatsMin||2);recalc();
    };
    select.addEventListener("change",syncCoats);
    ["lgCalcArea","lgCalcCoats","lgCalcReserve"].forEach(id=>document.getElementById(id)?.addEventListener("input",recalc));
    syncCoats();
    return true;
  }

  function productButtons(product,rawName,legacy){
    const wrap=document.createElement("div");wrap.className="lg-product-docs";wrap.dataset.lgDocs="1";
    if(legacy){
      const overview=document.createElement("a");overview.href=knowledge.technicalInfoUrl;overview.target="_blank";overview.rel="noopener";overview.textContent="LG Datenblätter";wrap.appendChild(overview);
      return wrap;
    }
    if(product?.productDataSheet){const a=document.createElement("a");a.href=product.productDataSheet;a.target="_blank";a.rel="noopener";a.textContent="TM";wrap.appendChild(a);}
    if(product?.regulatoryAdviceSheet){const a=document.createElement("a");a.href=product.regulatoryAdviceSheet;a.target="_blank";a.rel="noopener";a.textContent="Reg.";wrap.appendChild(a);}
    if(product){
      const s=document.createElement("a");s.href=`mailto:${knowledge.sdsRequestEmail}?subject=${encodeURIComponent(`Safety Data Sheet / Sicherheitsdatenblatt – Little Greene ${product.name}`)}`;s.textContent="SDB anfordern";wrap.appendChild(s);
      const b=document.createElement("button");b.type="button";b.textContent="Verbrauch";b.addEventListener("click",()=>{
        const select=document.getElementById("lgCalcProduct");if(select){select.value=product.name;document.getElementById("lgCalcCoats").value=String(product.defaultCoats||2);recalc();document.getElementById("paintConsumptionCard")?.scrollIntoView({behavior:"smooth",block:"center"});}
      });wrap.appendChild(b);
    }
    return wrap;
  }

  function decorateProducts(){
    if(!knowledge) return;
    document.querySelectorAll("#detail .product").forEach(row=>{
      if(row.dataset.lgProductDocs==="1") return;
      row.dataset.lgProductDocs="1";
      const head=row.querySelector(".prodhead");const nameEl=row.querySelector(".prodname");if(!head||!nameEl)return;
      const rawName=nameEl.textContent.trim();const legacy=/\bold\b|archive|legacy/i.test(rawName);const product=legacy?null:findProduct(rawName);
      if(product) nameEl.textContent=product.displayName||product.name;
      head.appendChild(productButtons(product,rawName,legacy));
      if(legacy){const note=document.createElement("div");note.className="lg-product-legacy";note.textContent="Altprodukt: aktuelles TM/SDB nicht automatisch zuordnen – Charge und Etikett prüfen.";row.appendChild(note);}
    });
  }

  async function start(){
    style();
    try{await loadKnowledge();}catch(error){console.warn("KRISTINE LG Produktwissen:",error?.message||error);return;}
    installCalculator();decorateProducts();
    const detail=document.getElementById("detail");if(detail)new MutationObserver(()=>decorateProducts()).observe(detail,{childList:true,subtree:true});
    new MutationObserver(()=>{if(installCalculator())decorateProducts();}).observe(document.body,{childList:true,subtree:false});
  }
  start();
})();
