"use strict";
(function(){
  const BRAIN="https://pc-alex02.tail610122.ts.net";
  const accessToken=new URLSearchParams(location.search).get("token")||"";
  const esc=v=>String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const el=id=>document.getElementById(id);
  function setMaster(row){
    el("tWwAddressId").value=String(row.customerIndex||row.addressId||"");el("tWwCustomerNumber").value=String(row.customerNumber||"");el("tWwCustomerKey").value=String(row.key||"");el("tCustomerMasterStatus").value="linked";
    if(!el("tContactName").value)el("tContactName").value=row.name||row.company||"";if(!el("tAddress").value)el("tAddress").value=row.address||"";
    el("tWwResults").innerHTML=`<strong>✓ WW-Kunde verknüpft</strong><br>${esc(row.name||row.company)} · Kundennr. ${esc(row.customerNumber||"–")} · StammIndex ${esc(row.customerIndex||row.addressId||"–")}`;
  }
  function provisional(){el("tWwAddressId").value="";el("tWwCustomerNumber").value="";el("tWwCustomerKey").value="";el("tCustomerMasterStatus").value="provisional";el("tWwResults").innerHTML="<strong>Neuer Kundenstamm vorgemerkt.</strong><br>Alle bekannten Daten werden bis Angebot/Auftrag mitgeführt; fehlende Pflichtfelder werden bei Auftragserstellung ergänzt."}
  async function search(){
    const host=el("tWwResults"),manual=el("tWwQuery")?.value.trim()||"",terms=(manual?[manual]:[el("tContactName").value,el("tAddress").value,el("tContactPhone").value]).map(x=>x.trim()).filter(Boolean);if(!terms.length){host.textContent="Bitte einen Namen, eine Kundennummer, Adresse oder Telefonnummer eingeben.";return}host.textContent="WW wird geprüft …";
    const found=new Map();let reached=false,lastError="";for(const q of terms){try{const u=new URL(`${BRAIN}/project/address-search`);u.searchParams.set("q",q);if(accessToken)u.searchParams.set("krista_token",accessToken);const r=await fetch(u.href,{cache:"no-store"});if(!r.ok){lastError=`Brain antwortet mit ${r.status}`;continue}reached=true;const d=await r.json();for(const x of d.addresses||[])found.set(String(x.key||x.customerIndex),x)}catch(e){lastError=String(e?.message||e)}}
    if(!reached){host.innerHTML=`<strong>Brain-Suche derzeit nicht erreichbar.</strong><br>${esc(lastError||"Verbindung fehlgeschlagen")}<br><button type="button" class="secondary" data-ww-brain style="margin-top:8px">🧠 Brain öffnen</button>`;host.querySelector("[data-ww-brain]")?.addEventListener("click",openBrain);return}
    const rows=[...found.values()];host.innerHTML=rows.length?`<strong>Bestehenden WW-Kunden auswählen:</strong><div style="display:grid;gap:6px;margin-top:8px">${rows.slice(0,8).map((x,i)=>`<button type="button" class="secondary" data-ww-row="${i}">${esc(x.name||x.company)} · ${esc(x.address||"")} · KdNr ${esc(x.customerNumber||"–")}</button>`).join("")}</div><button type="button" class="secondary" data-ww-new style="margin-top:8px">Keiner davon · neuen Stamm vormerken</button>`:`Kein WW-Kunde gefunden.<br><button type="button" class="secondary" data-ww-new style="margin-top:8px">Neuen Stamm vormerken</button>`;
    host.querySelectorAll("[data-ww-row]").forEach(b=>b.onclick=()=>setMaster(rows[Number(b.dataset.wwRow)]));host.querySelector("[data-ww-new]")?.addEventListener("click",provisional);
  }
  function openBrain(){const q=el("tWwQuery")?.value.trim()||el("tContactName")?.value.trim()||el("tAddress")?.value.trim()||"";const u=new URL(BRAIN+"/");if(q)u.searchParams.set("q",q);if(accessToken)u.searchParams.set("krista_token",accessToken);window.open(u.href,"_blank","noopener")}
  function reset(){const h=el("tWwResults");if(h)h.textContent="Noch keine WW-Prüfung durchgeführt."}
  function init(){if(!el("tWwSearch"))return;el("tWwSearch").onclick=search;el("tWwBrain")?.addEventListener("click",openBrain);el("tWwQuery")?.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();search()}});["tContactName","tAddress","tContactPhone"].forEach(id=>el(id)?.addEventListener("input",()=>{if(el("tCustomerMasterStatus").value==="linked")return;el("tCustomerMasterStatus").value=""}));window.resetWwCustomerSearch=reset}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
