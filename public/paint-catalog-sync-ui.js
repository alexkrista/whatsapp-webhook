"use strict";
(function(){
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const dt = value => {
    if(!value) return "–";
    const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("de-AT",{dateStyle:"short",timeStyle:"short"}).format(d);
  };
  async function api(url,opt={}){
    const join=url.includes("?")?"&":"?";
    const r=await fetch(url+(token?join+"token="+encodeURIComponent(token):""),{...opt,headers:{"Content-Type":"application/json",...(opt.headers||{})}});
    const j=await r.json().catch(()=>({ok:false,error:"Keine JSON-Antwort"}));
    if(!r.ok||j.ok===false) throw new Error(j.error||("HTTP "+r.status));
    return j;
  }

  function sectionRow(label,row){
    if(!row) return "";
    return `<div class="catcmp-row"><b>${esc(label)}</b><span>${row.current} → ${row.candidate}</span><span class="cat-added">+${row.added}</span><span class="cat-changed">~${row.changed}</span><span class="cat-removed">−${row.removed}</span></div>`;
  }
  function examples(label,rows){
    const list=(rows||[]).map(x=>x.label||x.key).filter(Boolean);
    return list.length?`<div class="catcmp-ex"><b>${esc(label)}:</b> ${list.map(esc).join(" · ")}</div>`:"";
  }
  function render(status){
    const panel=document.getElementById("catalogComparePanel"); const apply=document.getElementById("catalogApplyBtn"),discard=document.getElementById("catalogDiscardBtn");
    if(!panel) return;
    if(!status?.candidateReady){
      panel.innerHTML=`<div class="muted">Aktiver KRISTINE-Stand: ${status?.current?`${status.current.colors} Farben · ${status.current.products} Produkte · ${status.current.formulas} Rezepte`:"noch kein Katalog"}.<br>Neue Datei auswählen und <b>Mischdaten prüfen</b> drücken. Es wird noch nichts übernommen.</div>`;
      if(apply) apply.disabled=true; if(discard) discard.disabled=true; return;
    }
    const c=status.comparison||{},s=c.sections||{},t=c.totals||{};
    const colorEx=s.colors?.examples||{}, productEx=s.products?.examples||{}, formulaEx=s.formulas?.examples||{};
    panel.innerHTML=`
      <div class="catcmp-head"><b>Geprüfter neuer Stand</b><span>${dt(status.stagedAt)}</span></div>
      <div class="catcmp-total">Gesamt: <b class="cat-added">+${Number(t.added||0)} neu</b> · <b class="cat-changed">${Number(t.changed||0)} geändert</b> · <b class="cat-removed">${Number(t.removed||0)} entfernt</b></div>
      ${sectionRow("Farben",s.colors)}${sectionRow("Produkte",s.products)}${sectionRow("Rezepte",s.formulas)}${sectionRow("Basen",s.basePaints)}${sectionRow("Gebinde",s.canSizes)}${sectionRow("Colourants",s.colorants)}
      ${examples("Neue Farben",colorEx.added)}${examples("Geänderte Farben",colorEx.changed)}${examples("Neue Produkte",productEx.added)}${examples("Geänderte Rezepte",formulaEx.changed)}
      <div class="catcmp-warning">Der aktive Katalog bleibt unverändert, bis du <b>Neuen Stand übernehmen</b> drückst. Vorher wird automatisch ein Backup angelegt.</div>`;
    if(apply) apply.disabled=false; if(discard) discard.disabled=false;
  }
  async function refresh(){
    try{ render(await api("/admin/api/paint/catalog-sync/status")); }
    catch(e){ const p=document.getElementById("catalogComparePanel"); if(p)p.textContent=String(e?.message||e); }
  }

  function install(){
    const file=document.getElementById("catalogFile"),importBtn=document.getElementById("catalogImport"),statusEl=document.getElementById("catalogStatus");
    if(!file||!importBtn||!statusEl) return false;
    if(document.getElementById("catalogComparePanel")) return true;
    const card=importBtn.closest(".card"); if(!card)return false;
    const h=card.querySelector("h2"); if(h) h.textContent="Mischdaten aktualisieren";
    const p=card.querySelector("p.muted"); if(p) p.innerHTML="Neuen Innovatint-Stand <b>zuerst vergleichen</b>. Farben, Produkte, Basen, Gebinde und Rezepte werden erst nach deiner Freigabe übernommen.";
    importBtn.textContent="Mischdaten prüfen";
    const panel=document.createElement("div"); panel.id="catalogComparePanel"; panel.className="catcmp-panel";
    const actions=document.createElement("div"); actions.className="catcmp-actions";
    actions.innerHTML='<button id="catalogApplyBtn" class="btn primary" type="button" disabled>Neuen Stand übernehmen</button><button id="catalogDiscardBtn" class="btn" type="button" disabled>Prüfstand verwerfen</button><button id="catalogRefreshBtn" class="btn" type="button">Vergleich neu laden</button>';
    statusEl.insertAdjacentElement("afterend",panel); panel.insertAdjacentElement("afterend",actions);
    document.getElementById("catalogApplyBtn").onclick=async()=>{
      if(!confirm("Geprüften Innovatint-Stand jetzt als aktuellen KRISTINE-Mischdatenstand übernehmen?\n\nDer bisherige Stand wird automatisch gesichert."))return;
      const b=document.getElementById("catalogApplyBtn");b.disabled=true;b.textContent="Wird übernommen …";
      try{const r=await api("/admin/api/paint/catalog-sync/activate",{method:"POST",body:JSON.stringify({confirm:"APPLY_INNOVATINT_CATALOG"})});statusEl.textContent=`Aktiv: ${r.colors} Farben · ${r.products} Produkte · ${r.formulas} Rezepte${r.backup?` · Backup ${r.backup}`:""}`;await refresh(); if(typeof loadStatus==="function")loadStatus();}
      catch(e){alert(String(e?.message||e));}
      finally{b.textContent="Neuen Stand übernehmen";}
    };
    document.getElementById("catalogDiscardBtn").onclick=async()=>{if(!confirm("Geprüften neuen Stand verwerfen? Der aktive Katalog bleibt unverändert."))return;try{await api("/admin/api/paint/catalog-sync/discard",{method:"POST",body:"{}"});statusEl.textContent="Prüfstand verworfen. Aktiver Katalog unverändert.";await refresh();}catch(e){alert(String(e?.message||e));}};
    document.getElementById("catalogRefreshBtn").onclick=refresh;
    let timer=null;
    new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(refresh,350);}).observe(statusEl,{childList:true,subtree:true,characterData:true});
    refresh(); return true;
  }

  const style=document.createElement("style");style.textContent=`
    .catcmp-panel{margin-top:12px;border:1px solid #dce2dc;background:#fbfcfa;border-radius:12px;padding:12px}.catcmp-head,.catcmp-row{display:grid;grid-template-columns:minmax(140px,1fr) 100px 56px 66px 70px;gap:7px;align-items:center}.catcmp-head{display:flex;justify-content:space-between;gap:12px}.catcmp-total{margin:9px 0;font-size:13px}.catcmp-row{padding:5px 0;border-top:1px solid #ecefec;font-size:12px}.cat-added{color:#267345}.cat-changed{color:#98600a}.cat-removed{color:#a23b32}.catcmp-ex{font-size:11px;margin-top:6px;color:#5d675f}.catcmp-warning{font-size:12px;margin-top:10px;padding:8px;border-radius:8px;background:#fff4d9}.catcmp-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}@media(max-width:750px){.catcmp-row{grid-template-columns:1fr 80px 42px 50px 52px}.catcmp-actions .btn{width:100%}}
  `;document.head.appendChild(style);
  if(!install()){const o=new MutationObserver(()=>{if(install())o.disconnect()});o.observe(document.body,{childList:true,subtree:true});}
})();
