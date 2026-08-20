"use strict";
(function(){
  const qs=new URLSearchParams(location.search),token=qs.get("token")||"";
  const papi=async(url,opt={})=>{const join=url.includes("?")?"&":"?";const r=await fetch(url+(token?join+"token="+encodeURIComponent(token):""),{...opt,headers:{"Content-Type":"application/json",...(opt.headers||{})}});const ct=String(r.headers.get("content-type")||"");if(!ct.includes("application/json")){if(!r.ok)throw new Error("HTTP "+r.status);return r}const j=await r.json().catch(()=>({ok:false,error:"Keine JSON-Antwort"}));if(!r.ok||j.ok===false)throw new Error(j.error||("HTTP "+r.status));return j};
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const money=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR"}).format(Number(v||0));
  const b64=file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(",")[1]||"");r.onerror=reject;r.readAsDataURL(file)});

  const style=document.createElement("style");
  style.textContent=`
    .inventory-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.inventory-tools .field{max-width:420px}
    .inventory-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}.inventory-table{width:100%;border-collapse:collapse;min-width:850px;background:#fff}
    .inventory-table th,.inventory-table td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}.inventory-table th{position:sticky;top:0;background:#f2f4ef;z-index:1;font-size:12px}
    .inventory-table .num{text-align:right}.inventory-ist{width:88px;padding:8px;border:1px solid #aeb5ad;border-radius:8px;font-weight:800}.inventory-diff{font-weight:850}.inventory-diff.need{color:#b45c08}.inventory-diff.ok{color:#2f7f4f}
    .wallpaper-actions{display:flex;gap:7px;flex-wrap:wrap}.wallpaper-admin{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wallpaper-admin .filebox{height:100%}@media(max-width:750px){.wallpaper-admin{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);

  const tabs=document.querySelector(".tabs");
  if(tabs&&!document.querySelector('[data-tab="inventory"]')){
    const b=document.createElement("button");b.className="btn";b.dataset.tab="inventory";b.textContent="Inventur";b.onclick=()=>{if(typeof showTab==="function")showTab("inventory");loadInventory()};tabs.insertBefore(b,tabs.querySelector('[data-tab="admin"]')||null);
  }

  if(!document.getElementById("tab-inventory")){
    const section=document.createElement("section");section.id="tab-inventory";section.className="hidden";section.innerHTML=`
      <div class="card"><div class="inventory-tools"><div><h2 style="margin:0">Lager neu aufnehmen</h2><div class="muted">Soll und Mindest sind vorgegeben. Nur <b>Ist</b> eingeben. Speichern ersetzt den aktuellen Ist-Stand – es wird nicht addiert.</div></div><input id="inventoryFilter" class="field" placeholder="Produkt, Basis, Gebinde oder EAN filtern …"><button id="inventoryReload" class="btn">Neu laden</button><button id="inventorySave" class="btn primary">Ist-Stände speichern</button></div><div id="inventoryStatus" class="status"></div><div id="inventoryWrap" class="inventory-wrap"></div></div>`;
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

  let inventoryItems=[];
  function rowHtml(x){return `<tr data-search="${esc([x.product,x.baseName,x.size,x.ean,x.stockCode].join(" ").toLowerCase())}" data-id="${esc(x.id)}" data-target="${Number(x.targetStock||0)}"><td><b>${esc(x.product)}</b><small style="display:block;color:#777">${esc(x.stockCode||"")}</small></td><td>${esc(x.baseName)}</td><td>${esc(x.size)}</td><td class="num"><b>${Number(x.targetStock||0)}</b></td><td class="num"><input class="inventory-ist" type="number" min="0" step="1" inputmode="numeric" placeholder="${Number(x.stock||0)}"></td><td class="num inventory-diff">—</td><td class="num">${Number(x.minimumStock||0)}</td><td class="num">${x.purchasePrice?money(x.purchasePrice):""}</td></tr>`}
  function bindDiffs(){document.querySelectorAll(".inventory-ist").forEach(inp=>inp.oninput=()=>{const tr=inp.closest("tr"),target=Number(tr.dataset.target||0),v=inp.value===""?null:Number(inp.value),cell=tr.querySelector(".inventory-diff");if(v===null||!Number.isFinite(v)){cell.textContent="—";cell.className="num inventory-diff";return}const diff=target-v;cell.textContent=(diff>0?"+":"")+diff;cell.className="num inventory-diff "+(diff>0?"need":"ok")})}
  function applyFilter(){const q=String(document.getElementById("inventoryFilter")?.value||"").trim().toLowerCase();document.querySelectorAll("#inventoryWrap tbody tr").forEach(tr=>tr.hidden=!!q&&!tr.dataset.search.includes(q))}
  async function loadInventory(){const wrap=document.getElementById("inventoryWrap"),status=document.getElementById("inventoryStatus");if(!wrap)return;status.textContent="Lagerstamm wird geladen …";try{const d=await papi("/admin/api/paint/inventory");inventoryItems=d.items||[];wrap.innerHTML=inventoryItems.length?`<table class="inventory-table"><thead><tr><th>Produkt</th><th>Basis</th><th>Gebinde</th><th class="num">Soll</th><th class="num">Ist</th><th class="num">Diff Soll−Ist</th><th class="num">Mindest</th><th class="num">EK</th></tr></thead><tbody>${inventoryItems.map(rowHtml).join("")}</tbody></table>`:`<div style="padding:16px">Noch keine Lagerartikel. Einmal den LG-Artikelstamm unter „Import & Lernen“ importieren.</div>`;status.textContent=`${inventoryItems.length} Lagerartikel`;bindDiffs();applyFilter()}catch(e){status.textContent=e.message}}
  document.getElementById("inventoryFilter")?.addEventListener("input",applyFilter);document.getElementById("inventoryReload")?.addEventListener("click",loadInventory);
  document.getElementById("inventorySave")?.addEventListener("click",async()=>{const status=document.getElementById("inventoryStatus");const rows=[...document.querySelectorAll("#inventoryWrap tbody tr")].map(tr=>({articleId:tr.dataset.id,stock:tr.querySelector(".inventory-ist")?.value})).filter(x=>x.stock!=="");if(!rows.length)return alert("Bitte mindestens einen Ist-Stand eingeben.");if(!confirm(`${rows.length} Ist-Stände als neue Lagerwerte speichern?`))return;try{const d=await papi("/admin/api/paint/inventory/count",{method:"POST",body:JSON.stringify({rows})});status.textContent=`Gespeichert: ${d.changed} Ist-Stände`;await loadInventory()}catch(e){status.textContent=e.message}});

  async function importWallpaper(kind,inputId,statusId){const input=document.getElementById(inputId),status=document.getElementById(statusId),file=input?.files?.[0];if(!file)return;status.textContent="PDF wird gespeichert …";try{const d=await papi("/admin/api/paint/wallpaper-pricelist/import",{method:"POST",body:JSON.stringify({kind,name:file.name,base64:await b64(file)})});status.textContent=`Gespeichert: ${d.name}`}catch(e){status.textContent=e.message}}
  document.getElementById("wallRetailImport")?.addEventListener("click",()=>importWallpaper("retail","wallRetailFile","wallRetailStatus"));document.getElementById("wallTradeImport")?.addEventListener("click",()=>importWallpaper("trade","wallTradeFile","wallTradeStatus"));
})();
