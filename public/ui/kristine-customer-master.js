"use strict";
(function(){
  const BRAIN="https://pc-alex02.tail610122.ts.net";
  const esc=v=>String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const el=id=>document.getElementById(id);
  function setMaster(row){
    el("tWwAddressId").value=String(row.customerIndex||row.addressId||"");el("tWwCustomerNumber").value=String(row.customerNumber||"");el("tWwCustomerKey").value=String(row.key||"");el("tCustomerMasterStatus").value="linked";
    if(!el("tContactName").value)el("tContactName").value=row.name||row.company||"";if(!el("tAddress").value)el("tAddress").value=row.address||"";
    el("tWwResults").innerHTML=`<strong>✓ WW-Kunde verknüpft</strong><br>${esc(row.name||row.company)} · Kundennr. ${esc(row.customerNumber||"–")} · StammIndex ${esc(row.customerIndex||row.addressId||"–")}`;
  }
  function provisional(){el("tWwAddressId").value="";el("tWwCustomerNumber").value="";el("tWwCustomerKey").value="";el("tCustomerMasterStatus").value="provisional";el("tWwResults").innerHTML="<strong>Neuer Kundenstamm vorgemerkt.</strong><br>Alle bekannten Daten werden bis Angebot/Auftrag mitgeführt; fehlende Pflichtfelder werden bei Auftragserstellung ergänzt."}
  async function search(){
    const host=el("tWwResults"),terms=[el("tContactName").value,el("tAddress").value,el("tContactPhone").value].map(x=>x.trim()).filter(Boolean);if(!terms.length){host.textContent="Bitte zuerst Name, Adresse oder Telefonnummer eingeben.";return}host.textContent="WW wird geprüft …";
    const found=new Map();try{for(const q of terms){const r=await fetch(`${BRAIN}/project/address-search?q=${encodeURIComponent(q)}`,{cache:"no-store"});if(!r.ok)continue;const d=await r.json();for(const x of d.addresses||[])found.set(String(x.key||x.customerIndex),x)}}catch(e){host.textContent="WW-Suche derzeit nicht erreichbar. Die Aufgabe kann trotzdem als neuer Stamm vorgemerkt werden."}
    const rows=[...found.values()];host.innerHTML=rows.length?`<strong>Bestehenden WW-Kunden auswählen:</strong><div style="display:grid;gap:6px;margin-top:8px">${rows.slice(0,8).map((x,i)=>`<button type="button" class="secondary" data-ww-row="${i}">${esc(x.name||x.company)} · ${esc(x.address||"")} · KdNr ${esc(x.customerNumber||"–")}</button>`).join("")}</div><button type="button" class="secondary" data-ww-new style="margin-top:8px">Keiner davon · neuen Stamm vormerken</button>`:`Kein WW-Kunde gefunden.<br><button type="button" class="secondary" data-ww-new style="margin-top:8px">Neuen Stamm vormerken</button>`;
    host.querySelectorAll("[data-ww-row]").forEach(b=>b.onclick=()=>setMaster(rows[Number(b.dataset.wwRow)]));host.querySelector("[data-ww-new]")?.addEventListener("click",provisional);
  }
  function reset(){const h=el("tWwResults");if(h)h.textContent="Noch keine WW-Prüfung durchgeführt."}
  function init(){if(!el("tWwSearch"))return;el("tWwSearch").onclick=search;["tContactName","tAddress","tContactPhone"].forEach(id=>el(id)?.addEventListener("input",()=>{if(el("tCustomerMasterStatus").value==="linked")return;el("tCustomerMasterStatus").value=""}));window.resetWwCustomerSearch=reset}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
