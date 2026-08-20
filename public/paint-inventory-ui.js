"use strict";
(function(){
  const qs=new URLSearchParams(location.search),token=qs.get("token")||"";
  const papi=async(url,opt={})=>{const join=url.includes("?")?"&":"?";const r=await fetch(url+(token?join+"token="+encodeURIComponent(token):""),{...opt,headers:{"Content-Type":"application/json",...(opt.headers||{})}});const ct=String(r.headers.get("content-type")||"");if(!ct.includes("application/json")){if(!r.ok)throw new Error("HTTP "+r.status);return r}const j=await r.json().catch(()=>({ok:false,error:"Keine JSON-Antwort"}));if(!r.ok||j.ok===false)throw new Error(j.error||("HTTP "+r.status));return j};
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const money=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR"}).format(Number(v||0));
  const b64=file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(",")[1]||"");r.onerror=reject;r.readAsDataURL(file)});
  let inventoryItems=[];

  const style=document.createElement("style");
  style.textContent=`
    .inventory-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.inventory-tools .field{max-width:420px}
    .inventory-wrap{display:grid;gap:18px}.inv-product{border:1px solid var(--line);border-radius:14px;background:#fff;overflow:hidden}.inv-product-head{padding:13px 15px;background:#eef3ef;border-bottom:1px solid var(--line);font-size:18px;font-weight:900}
    .inv-size{padding:12px 15px;border-top:1px solid var(--line)}.inv-size:first-of-type{border-top:0}.inv-size-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.inv-size-title{font-size:16px;font-weight:900}.inv-size-count{font-size:11px;color:var(--muted)}
    .inv-row{display:grid;grid-template-columns:minmax(150px,1.6fr) 82px 96px 92px 82px 96px;gap:8px;align-items:center;padding:7px 0;border-top:1px solid #eceee8}.inv-row:first-of-type{border-top:0}.inv-base{font-weight:800}.inv-code{font-size:10px;color:var(--muted);margin-top:2px}.inv-label{display:none}.inv-num{text-align:right;font-weight:800}.inventory-ist{width:78px;padding:7px 8px;border:1px solid #aeb5ad;border-radius:8px;font-weight:900;text-align:center}.inventory-diff{font-weight:900}.inventory-diff.need{color:#b45c08}.inventory-diff.ok{color:#2f7f4f}.inv-headrow{display:grid;grid-template-columns:minmax(150px,1.6fr) 82px 96px 92px 82px 96px;gap:8px;padding:5px 0 3px;color:var(--muted);font-size:11px;font-weight:800}.inv-headrow span:not(:first-child){text-align:right}
    .wallpaper-actions{display:flex;gap:7px;flex-wrap:wrap}.wallpaper-admin{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wallpaper-admin .filebox{height:100%}
    @media(max-width:760px){.wallpaper-admin{grid-template-columns:1fr}.inv-headrow{display:none}.inv-row{grid-template-columns:1fr 1fr;gap:5px 12px;padding:10px 0}.inv-base{grid-column:1/-1}.inv-label{display:inline;color:var(--muted);font-size:11px;margin-right:5px}.inv-num{text-align:left}.inventory-ist{width:72px}.inv-size{padding:11px 13px}}
  `;
  document.head.appendChild(style);

  const tabs=document.querySelector(".tabs");
  if(tabs&&!document.querySelector('[data-tab="inventory"]')){
    const b=document.createElement("button");b.className="btn";b.dataset.tab="inventory";b.textContent="Inventur";b.onclick=()=>{if(typeof showTab==="function")showTab("inventory");loadInventory()};tabs.insertBefore(b,tabs.querySelector('[data-tab="admin"]')||null);
  }

  if(!document.getElementById("tab-inventory")){
    const section=document.createElement("section");section.id="tab-inventory";section.className="hidden";section.innerHTML=`
      <div class="card"><div class="inventory-tools"><div><h2 style="margin:0">Lager neu aufnehmen</h2><div class="muted">Regalfolge: Produkt → Gebinde → Basen. Soll und Mindest sind vorgegeben; nur <b>Ist</b> zählen und eingeben.</div></div><input id="inventoryFilter" class="field" placeholder="Produkt, Basis, Gebinde oder EAN filtern …"><button id="inventoryReload" class="btn">Neu laden</button><button id="inventorySave" class="btn primary">Ist-Stände speichern</button></div><div id="inventoryStatus" class="status"></div><div id="inventoryWrap" class="inventory-wrap"></div></div>`;
    const admin=document.getElementById("tab-admin");admin?.parentNode.insertBefore(section,admin);
  }

  const commercialActions=document.querySelector(".commercialActions");
  if(commercialActions&&!document.getElementById("wallpaperRetailBtn")){
    const r=document.createElement("button");r.className="btn";r.id="wallpaperRetailBtn";r.textContent="Tapeten VK";r.onclick=()=>window.open(`/admin/api/paint/wallpaper-pricelist/retail${token?`?token=${encodeURIComponent(token)}`:""}`,"_blank","noopener");
    const t=document.createElement("button");t.className="btn";t.id="wallpaperTradeBtn";t.textContent="Tapeten EK";t.onclick=()=>window.open(`/admin/api/paint/wallpaper-pricelist/trade${token?`?token=${encodeURIComponent(token)}`:""}`,"_blank","noopener");
    commercialActions.insertBefore(r,commercialActions.firstChild);commercialActions.insertBefore(t,commercialActions.firstChild);
  }

  const admin=document.getElementById("tab-admin");
  if(admin&&!document.getElementById("wallpaperPriceAdmin")){
    const box=document.createElement("div");box.id="wallpaperPriceAdmin";box.className="card";box.innerHTML=`<h2>LG Tapeten-Preislisten</h2><p class="muted">Nicht ins öffentliche Repo: die PDFs werden nur in KRISTINE auf dem Datenlaufwerk gespeichert.</p><div class="wallpaper-admin"><div class="filebox"><b>Tapeten Verkauf / RRP</b><br><input id="wallRetailFile" type="file" accept=".pdf"><button id="wallRetailImport" class="btn primary">VK-PDF importieren</button><div id="wallRetailStatus" class="status"></div></div><div class="filebox"><b>Tapeten Einkauf / Trade</b><br><input id="wallTradeFile" type="file" accept=".pdf"><button id="wallTradeImport" class="btn primary">EK-PDF importieren</button><div id="wallTradeStatus" class="status"></div></div></div>`;
    const statusCard=admin.querySelector(".card:last-child");admin.insertBefore(box,statusCard||null);
  }

  function sizeNumber(value){const m=String(value||"").replace(",",".").match(/([0-9.]+)/);return m?Number(m[1]):999}
  function displaySize(value){return String(value||"").replace("0.25 L","0,25 L").replace("0.5 L","0,5 L").replace("0.75 L","0,75 L").replace("2.5 L","2,5 L")}
  function grouped(items){
    const products=[];const productMap=new Map();
    for(const item of items){const pn=String(item.product||"Ohne Produkt");let p=productMap.get(pn);if(!p){p={name:pn,sizes:[],sizeMap:new Map()};productMap.set(pn,p);products.push(p)}const sk=String(item.size||"");let s=p.sizeMap.get(sk);if(!s){s={size:sk,rows:[]};p.sizeMap.set(sk,s);p.sizes.push(s)}s.rows.push(item)}
    for(const p of products)p.sizes.sort((a,b)=>sizeNumber(a.size)-sizeNumber(b.size));
    return products;
  }
  function itemRow(x){const search=[x.product,x.baseName,x.baseCode,x.size,x.ean,x.stockCode].join(" ").toLowerCase();return `<div class="inv-row" data-inv-row data-search="${esc(search)}" data-id="${esc(x.id)}" data-target="${Number(x.targetStock||0)}"><div class="inv-base">${esc(x.baseName||x.baseCode)}<div class="inv-code">${esc(x.stockCode||x.ean||"")}</div></div><div class="inv-num"><span class="inv-label">Soll</span>${Number(x.targetStock||0)}</div><div class="inv-num"><span class="inv-label">Ist</span><input class="inventory-ist" type="number" min="0" step="1" inputmode="numeric" placeholder="${Number(x.stock||0)}"></div><div class="inv-num inventory-diff"><span class="inv-label">Diff</span>—</div><div class="inv-num"><span class="inv-label">Min</span>${Number(x.minimumStock||0)}</div><div class="inv-num"><span class="inv-label">EK</span>${x.purchasePrice?money(x.purchasePrice):""}</div></div>`}
  function productHtml(p){return `<section class="inv-product" data-inv-product><div class="inv-product-head">${esc(p.name)}</div>${p.sizes.map(s=>`<div class="inv-size" data-inv-size><div class="inv-size-head"><div class="inv-size-title">${esc(displaySize(s.size))}</div><div class="inv-size-count">${s.rows.length} Basen</div></div><div class="inv-headrow"><span>Basis</span><span>Soll</span><span>Ist</span><span>Diff</span><span>Mindest</span><span>EK</span></div>${s.rows.map(itemRow).join("")}</div>`).join("")}</section>`}
  function bindDiffs(){document.querySelectorAll(".inventory-ist").forEach(inp=>inp.oninput=()=>{const row=inp.closest("[data-inv-row]"),target=Number(row.dataset.target||0),v=inp.value===""?null:Number(inp.value),cell=row.querySelector(".inventory-diff");if(v===null||!Number.isFinite(v)){cell.innerHTML='<span class="inv-label">Diff</span>—';cell.className="inv-num inventory-diff";return}const diff=target-v;cell.innerHTML=`<span class="inv-label">Diff</span>${diff>0?"+":""}${diff}`;cell.className="inv-num inventory-diff "+(diff>0?"need":"ok")})}
  function applyFilter(){const q=String(document.getElementById("inventoryFilter")?.value||"").trim().toLowerCase();document.querySelectorAll("[data-inv-row]").forEach(row=>row.hidden=!!q&&!row.dataset.search.includes(q));document.querySelectorAll("[data-inv-size]").forEach(size=>size.hidden=![...size.querySelectorAll("[data-inv-row]")].some(r=>!r.hidden));document.querySelectorAll("[data-inv-product]").forEach(p=>p.hidden=![...p.querySelectorAll("[data-inv-size]")].some(s=>!s.hidden))}
  async function loadInventory(){const wrap=document.getElementById("inventoryWrap"),status=document.getElementById("inventoryStatus");if(!wrap)return;status.textContent="Lagerstamm wird geladen …";try{const d=await papi("/admin/api/paint/inventory");inventoryItems=d.items||[];wrap.innerHTML=inventoryItems.length?grouped(inventoryItems).map(productHtml).join(""):`<div style="padding:16px">Noch keine Lagerartikel. Einmal den LG-Artikelstamm unter „Import & Lernen“ importieren.</div>`;status.textContent=`${inventoryItems.length} Lagerartikel`;bindDiffs();applyFilter()}catch(e){status.textContent=e.message}}
  document.getElementById("inventoryFilter")?.addEventListener("input",applyFilter);document.getElementById("inventoryReload")?.addEventListener("click",loadInventory);
  document.getElementById("inventorySave")?.addEventListener("click",async()=>{const status=document.getElementById("inventoryStatus");const rows=[...document.querySelectorAll("[data-inv-row]")].map(row=>({articleId:row.dataset.id,stock:row.querySelector(".inventory-ist")?.value})).filter(x=>x.stock!=="");if(!rows.length)return alert("Bitte mindestens einen Ist-Stand eingeben.");if(!confirm(`${rows.length} Ist-Stände als neue Lagerwerte speichern?`))return;try{const d=await papi("/admin/api/paint/inventory/count",{method:"POST",body:JSON.stringify({rows})});status.textContent=`Gespeichert: ${d.changed} Ist-Stände`;await loadInventory()}catch(e){status.textContent=e.message}});

  async function importWallpaper(kind,inputId,statusId){const input=document.getElementById(inputId),status=document.getElementById(statusId),file=input?.files?.[0];if(!file)return;status.textContent="PDF wird gespeichert …";try{const d=await papi("/admin/api/paint/wallpaper-pricelist/import",{method:"POST",body:JSON.stringify({kind,name:file.name,base64:await b64(file)})});status.textContent=`Gespeichert: ${d.name}`}catch(e){status.textContent=e.message}}
  document.getElementById("wallRetailImport")?.addEventListener("click",()=>importWallpaper("retail","wallRetailFile","wallRetailStatus"));document.getElementById("wallTradeImport")?.addEventListener("click",()=>importWallpaper("trade","wallTradeFile","wallTradeStatus"));
})();
