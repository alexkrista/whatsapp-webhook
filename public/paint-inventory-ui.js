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
    .inventory-note{padding:10px 12px;border-radius:10px;background:#f5f7f3;border:1px solid var(--line);font-size:12px;margin:8px 0 12px}
    .inventory-wrap{display:grid;gap:18px}.inv-product{border:1px solid var(--line);border-radius:14px;background:#fff;overflow:hidden}.inv-product-head{padding:13px 15px;background:#eef3ef;border-bottom:1px solid var(--line);font-size:18px;font-weight:900}
    .inv-size{padding:12px 15px;border-top:1px solid var(--line)}.inv-size:first-of-type{border-top:0}.inv-size-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.inv-size-title{font-size:16px;font-weight:900}.inv-size-count{font-size:11px;color:var(--muted)}
    .inv-row{display:grid;grid-template-columns:minmax(190px,1.7fr) 96px 105px 92px 105px;gap:10px;align-items:center;padding:8px 0;border-top:1px solid #eceee8}.inv-row:first-of-type{border-top:0}.inv-base{font-weight:850}.inv-code{font-size:10px;color:var(--muted);margin-top:2px}.inv-label{display:none}.inv-num{text-align:right;font-weight:800}.inventory-ist,.inventory-min{width:82px;padding:7px 8px;border:1px solid #aeb5ad;border-radius:8px;font-weight:900;text-align:center}.inventory-min{background:#fffdf6}.inventory-order{font-weight:900}.inventory-order.need{color:#b45c08}.inventory-order.ok{color:#2f7f4f}.inv-headrow{display:grid;grid-template-columns:minmax(190px,1.7fr) 96px 105px 92px 105px;gap:10px;padding:5px 0 3px;color:var(--muted);font-size:11px;font-weight:800}.inv-headrow span:not(:first-child){text-align:right}
    .wallpaper-actions{display:flex;gap:7px;flex-wrap:wrap}.wallpaper-admin{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wallpaper-admin .filebox{height:100%}
    @media(max-width:760px){.wallpaper-admin{grid-template-columns:1fr}.inv-headrow{display:none}.inv-row{grid-template-columns:1fr 1fr;gap:6px 12px;padding:11px 0}.inv-base{grid-column:1/-1}.inv-label{display:inline;color:var(--muted);font-size:11px;margin-right:5px}.inv-num{text-align:left}.inventory-ist,.inventory-min{width:74px}.inv-size{padding:11px 13px}}
  `;
  document.head.appendChild(style);

  const tabs=document.querySelector(".tabs");
  if(tabs&&!document.querySelector('[data-tab="inventory"]')){
    const b=document.createElement("button");b.className="btn";b.dataset.tab="inventory";b.textContent="Inventur";b.onclick=()=>{if(typeof showTab==="function")showTab("inventory");loadInventory()};tabs.insertBefore(b,tabs.querySelector('[data-tab="admin"]')||null);
  }

  if(!document.getElementById("tab-inventory")){
    const section=document.createElement("section");section.id="tab-inventory";section.className="hidden";section.innerHTML=`
      <div class="card"><div class="inventory-tools"><div><h2 style="margin:0">Lager neu aufnehmen</h2><div class="muted">Regalfolge: Produkt → Gebinde → Basis. <b>Ist</b> zählen; <b>Mindest</b> kannst du hier gleich richtig setzen.</div></div><input id="inventoryFilter" class="field" placeholder="Produkt, Basis, Gebinde oder EAN filtern …"><button id="inventoryReload" class="btn">Neu laden</button><button id="inventorySave" class="btn primary">Inventur speichern</button></div><div class="inventory-note">Basisnamen sind zusammengeführt: <b>HI · Hi White</b>, <b>M · Medium</b>, <b>D · Deep</b>, <b>XD · Extra Deep</b>, <b>T · Transparent</b>, <b>Y · Yellow</b>. Bestellung rechnet direkt mit dem Mindestbestand.</div><div id="inventoryStatus" class="status"></div><div id="inventoryWrap" class="inventory-wrap"></div></div>`;
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
  function labelFor(x){if(x.baseLabel)return x.baseLabel;const code=String(x.baseCode||"").trim(),name=String(x.baseName||code).trim();return code&&name&&code.toLowerCase()!==name.toLowerCase()?`${code} · ${name}`:(name||code)}
  function itemRow(x){const search=[x.product,x.baseName,x.baseCode,x.baseLabel,x.size,x.ean,x.stockCode].join(" ").toLowerCase();const min=Math.max(0,Number(x.minimumStock||0)),stock=Math.max(0,Number(x.stock||0)),order=Math.max(0,Math.ceil(min-stock));return `<div class="inv-row" data-inv-row data-search="${esc(search)}" data-id="${esc(x.id)}" data-stock="${stock}"><div class="inv-base">${esc(labelFor(x))}<div class="inv-code">${esc(x.stockCode||x.ean||"")}</div></div><div class="inv-num"><span class="inv-label">Ist</span><input class="inventory-ist" type="number" min="0" step="1" inputmode="numeric" placeholder="${stock}"></div><div class="inv-num"><span class="inv-label">Mindest</span><input class="inventory-min" type="number" min="0" step="1" inputmode="numeric" value="${min}"></div><div class="inv-num inventory-order ${order>0?"need":"ok"}"><span class="inv-label">Bestell</span>${order}</div><div class="inv-num"><span class="inv-label">EK</span>${x.purchasePrice?money(x.purchasePrice):""}</div></div>`}
  function productHtml(p){return `<section class="inv-product" data-inv-product><div class="inv-product-head">${esc(p.name)}</div>${p.sizes.map(s=>`<div class="inv-size" data-inv-size><div class="inv-size-head"><div class="inv-size-title">${esc(displaySize(s.size))}</div><div class="inv-size-count">${s.rows.length} Positionen</div></div><div class="inv-headrow"><span>Basis / Colourant</span><span>Ist</span><span>Mindest</span><span>Bestell</span><span>EK</span></div>${s.rows.map(itemRow).join("")}</div>`).join("")}</section>`}
  function recalcRow(row){const inp=row.querySelector(".inventory-ist"),minInp=row.querySelector(".inventory-min"),stock=inp.value===""?Number(row.dataset.stock||0):Number(inp.value),min=Number(minInp.value||0),cell=row.querySelector(".inventory-order");const order=Math.max(0,Math.ceil(min-(Number.isFinite(stock)?stock:0)));cell.innerHTML=`<span class="inv-label">Bestell</span>${order}`;cell.className="inv-num inventory-order "+(order>0?"need":"ok")}
  function bindInputs(){document.querySelectorAll("[data-inv-row]").forEach(row=>{row.querySelector(".inventory-ist")?.addEventListener("input",()=>recalcRow(row));row.querySelector(".inventory-min")?.addEventListener("input",()=>recalcRow(row))})}
  function applyFilter(){const q=String(document.getElementById("inventoryFilter")?.value||"").trim().toLowerCase();document.querySelectorAll("[data-inv-row]").forEach(row=>row.hidden=!!q&&!row.dataset.search.includes(q));document.querySelectorAll("[data-inv-size]").forEach(size=>size.hidden=![...size.querySelectorAll("[data-inv-row]")].some(r=>!r.hidden));document.querySelectorAll("[data-inv-product]").forEach(p=>p.hidden=![...p.querySelectorAll("[data-inv-size]")].some(s=>!s.hidden))}
  async function loadInventory(){const wrap=document.getElementById("inventoryWrap"),status=document.getElementById("inventoryStatus");if(!wrap)return;status.textContent="Lagerstamm wird geladen …";try{const d=await papi("/admin/api/paint/inventory");inventoryItems=d.items||[];wrap.innerHTML=inventoryItems.length?grouped(inventoryItems).map(productHtml).join(""):`<div style="padding:16px">Noch keine Lagerartikel. Bitte die aktuelle offizielle LG-Bestellliste unter „Import & Lernen“ einlesen.</div>`;status.textContent=`${inventoryItems.length} Positionen · ${d.scope||"LG BASES + COLOURANTS"}`;bindInputs();applyFilter()}catch(e){status.textContent=e.message}}
  document.getElementById("inventoryFilter")?.addEventListener("input",applyFilter);document.getElementById("inventoryReload")?.addEventListener("click",loadInventory);
  document.getElementById("inventorySave")?.addEventListener("click",async()=>{const status=document.getElementById("inventoryStatus"),els=[...document.querySelectorAll("[data-inv-row]")];const counts=els.map(row=>({articleId:row.dataset.id,stock:row.querySelector(".inventory-ist")?.value})).filter(x=>x.stock!=="");const levels=els.map(row=>({articleId:row.dataset.id,minimumStock:row.querySelector(".inventory-min")?.value}));if(!counts.length&&!levels.length)return alert("Keine Werte zum Speichern.");if(!confirm(`${counts.length} gezählte Ist-Stände und die Mindestbestände speichern?`))return;try{let changedCount=0,changedLevels=0;if(counts.length){const d=await papi("/admin/api/paint/inventory/count",{method:"POST",body:JSON.stringify({rows:counts})});changedCount=Number(d.changed||0)}if(levels.length){const d=await papi("/admin/api/paint/inventory/levels",{method:"POST",body:JSON.stringify({rows:levels})});changedLevels=Number(d.changed||0)}status.textContent=`Gespeichert: ${changedCount} Ist-Stände · ${changedLevels} Mindeststände`;await loadInventory()}catch(e){status.textContent=e.message}});

  async function importWallpaper(kind,inputId,statusId){const input=document.getElementById(inputId),status=document.getElementById(statusId),file=input?.files?.[0];if(!file)return;status.textContent="PDF wird gespeichert …";try{const d=await papi("/admin/api/paint/wallpaper-pricelist/import",{method:"POST",body:JSON.stringify({kind,name:file.name,base64:await b64(file)})});status.textContent=`Gespeichert: ${d.name}`}catch(e){status.textContent=e.message}}
  document.getElementById("wallRetailImport")?.addEventListener("click",()=>importWallpaper("retail","wallRetailFile","wallRetailStatus"));document.getElementById("wallTradeImport")?.addEventListener("click",()=>importWallpaper("trade","wallTradeFile","wallTradeStatus"));
})();
