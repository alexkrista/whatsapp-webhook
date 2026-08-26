"use strict";

(function(){
  const VERSION="2026-08-26-kalkulation-v1";
  const token=new URLSearchParams(location.search).get("token")||"";
  const KINDS={
    auftrag:"Auftrag",
    regie:"Regie",
    nachtrag_auftrag:"Nachtrag Auftrag",
    nachtrag_regie:"Nachtrag Regie",
    fremdleistung:"Fremdleistung",
    sonstiges:"Fahrt / Sonstiges"
  };
  let currentJobId="";
  let currentJob=null;
  let calculation=null;
  let pendingFile=null;
  let loadSerial=0;
  let economyObserver=null;

  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
  const num=v=>{const n=Number(v);return Number.isFinite(n)?Math.max(0,n):0};
  const money=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",minimumFractionDigits:2,maximumFractionDigits:2}).format(num(v));
  const hours=v=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:1}).format(num(v))+" h";
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token&&u.origin===location.origin)u.searchParams.set("token",token);return u.origin===location.origin?u.pathname+u.search+u.hash:u.href};
  async function api(p,o={}){const r=await fetch(tokenUrl(p),o);const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok||d?.ok===false)throw new Error(d?.error||t||r.statusText);return d||{}}

  function installCss(){
    if(document.getElementById("kcv2Css"))return;
    const s=document.createElement("style");s.id="kcv2Css";s.textContent=`
      .kcv2-shell{display:grid;gap:11px}.kcv2-top{display:grid;grid-template-columns:1.1fr .9fr;gap:11px}.kcv2-card{background:#fff;border:1px solid #ddd9cf;border-radius:15px;padding:15px;box-shadow:0 5px 18px rgba(23,33,27,.045)}.kcv2-card h3{margin:0 0 10px;font-size:15px}.kcv2-muted{color:#707670;font-size:11px;line-height:1.45}.kcv2-source{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.kcv2-source a{color:#2f7d4a;font-weight:850;text-decoration:none}.kcv2-source strong{font-size:12px}
      .kcv2-drop{min-height:154px;border:2px dashed #bfc8bd;border-radius:14px;background:#f8faf7;display:grid;place-items:center;text-align:center;padding:18px;cursor:pointer;transition:.15s}.kcv2-drop:hover,.kcv2-drop.drag{border-color:#2f7d4a;background:#eef6ef}.kcv2-drop strong{display:block;font-size:17px}.kcv2-drop span{display:block;margin-top:5px;color:#687068;font-size:11px}.kcv2-drop input{display:none}.kcv2-status{margin-top:9px;font-size:11px;font-weight:800;color:#2f7d4a}.kcv2-status.error{color:#a84540}
      .kcv2-settings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}.kcv2-field label{display:block;color:#707670;font-size:10px;font-weight:800;margin-bottom:4px}.kcv2-field input{width:100%;min-height:39px;border:1px solid #cbc8bf;border-radius:9px;padding:8px 9px;font:inherit}.kcv2-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.kcv2-kpi{border:1px solid #e2ded5;border-radius:12px;padding:11px;background:#faf9f5}.kcv2-kpi span{display:block;font-size:9.5px;color:#707670;font-weight:800;text-transform:uppercase}.kcv2-kpi strong{display:block;font-size:17px;margin-top:4px}.kcv2-kpi.emph{background:#eef6ef;border-color:#cee0d2}.kcv2-kpi.warn{background:#fff7e6;border-color:#ead4a9}
      .kcv2-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}.kcv2-section-head h3{margin:0}.kcv2-actions{display:flex;gap:7px;flex-wrap:wrap}.kcv2-actions button{min-height:36px;border:1px solid #cfcac0;border-radius:9px;background:#fff;padding:7px 10px;font:800 11px/1 system-ui;cursor:pointer}.kcv2-actions button.primary{background:#2f7d4a;border-color:#2f7d4a;color:#fff}.kcv2-actions button.regie{background:#fff2dd;border-color:#e4c899;color:#744d1d}
      .kcv2-table-wrap{overflow:auto}.kcv2-table{width:100%;border-collapse:collapse;font-size:11px;min-width:900px}.kcv2-table th,.kcv2-table td{padding:8px 6px;border-bottom:1px solid #ece9e2;vertical-align:middle}.kcv2-table th{text-align:left;color:#707670;font-size:9px;text-transform:uppercase;letter-spacing:.03em}.kcv2-table input,.kcv2-table select{width:100%;border:1px solid #d4d0c7;border-radius:8px;background:#fff;padding:7px 8px;font:inherit;font-size:11px}.kcv2-table input[type=number]{text-align:right}.kcv2-table input[type=checkbox]{width:auto}.kcv2-table .num{text-align:right}.kcv2-pos{font-weight:900;white-space:nowrap}.kcv2-review{display:inline-flex;margin-top:3px;padding:3px 6px;border-radius:999px;background:#fff0cf;color:#80591e;font-size:8px;font-weight:900}.kcv2-delete{border:0;background:transparent;color:#a84540;font-size:17px;cursor:pointer}.kcv2-empty{padding:19px;border:1px dashed #d5d0c6;background:#faf9f5;border-radius:12px;text-align:center;color:#707670;font-size:11px}
      .kcv2-team{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.kcv2-team-group{border:1px solid #e0dcd3;border-radius:12px;padding:10px;background:#fbfaf6}.kcv2-team-group h4{margin:0 0 7px;font-size:11px}.kcv2-team-group ul{margin:0;padding-left:16px}.kcv2-team-group li{font-size:10.5px;line-height:1.4;margin:4px 0}.kcv2-team-group.regie{background:#fff7e8}.kcv2-team-group.nachtrag{background:#eef3f8}.kcv2-team-group.nachtrag-regie{background:#f6eef7}.kcv2-team-empty{font-size:10px;color:#8a8e8a}
      .kcv2-savebar{position:sticky;bottom:8px;display:flex;align-items:center;gap:9px;justify-content:flex-end;padding:10px 12px;border:1px solid #d8d3c9;border-radius:13px;background:rgba(255,255,255,.95);box-shadow:0 10px 28px rgba(23,33,27,.12);backdrop-filter:blur(8px)}.kcv2-savebar .msg{margin-right:auto;font-size:11px;color:#2f7d4a}.kcv2-savebar button{min-height:40px;border:1px solid #2f7d4a;border-radius:10px;background:#2f7d4a;color:#fff;padding:9px 13px;font-weight:900;cursor:pointer}.kcv2-savebar button:disabled{opacity:.55;cursor:wait}
      .kcv2-economy-flow{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:7px}.kcv2-e-step{background:#f8f6f0;border:1px solid #e2ded5;border-radius:11px;padding:10px}.kcv2-e-step small{display:block;color:#707670;font-size:9px}.kcv2-e-step strong{display:block;font-size:14px;margin-top:3px}.kcv2-e-step.main{background:#eef6ef;border-color:#cde0d1}
      @media(max-width:1000px){.kcv2-top{grid-template-columns:1fr}.kcv2-summary{grid-template-columns:1fr 1fr}.kcv2-team{grid-template-columns:1fr 1fr}.kcv2-economy-flow{grid-template-columns:1fr 1fr 1fr}}
      @media(max-width:650px){.kcv2-settings{grid-template-columns:1fr}.kcv2-summary{grid-template-columns:1fr 1fr}.kcv2-team{grid-template-columns:1fr}.kcv2-economy-flow{grid-template-columns:1fr 1fr}.kcv2-savebar{bottom:4px}.kcv2-savebar .msg{display:none}}
    `;document.head.appendChild(s);
  }

  function blankCalculation(job){
    const c=job?.calculation||{};
    return {version:1,parseVersion:1,sourceType:"pdf",sourceDocument:null,orderNo:"",projectNo:"",documentDate:"",customer:"",subject:job?.name||"",netTotal:num(job?.contractAmount??c.contractAmount),vatAmount:0,grossTotal:0,materialPercent:num(job?.materialPercent??c.materialPercent),billingRate:num(job?.billingRate??c.billingRate),rawText:"",positions:[],updatedAt:null};
  }
  function derive(calc){
    const rows=Array.isArray(calc?.positions)?calc.positions:[];
    const sum=fn=>rows.reduce((s,r)=>s+(fn(r)?num(r.amount):0),0);
    const baseNet=num(calc?.netTotal),added=sum(r=>r.addToContract),contract=baseNet+added;
    const regie=sum(r=>r.kind==="regie"||r.kind==="nachtrag_regie");
    const external=sum(r=>r.kind==="fremdleistung");
    const other=sum(r=>r.kind==="sonstiges");
    const fixed=Math.max(0,contract-regie-external-other);
    const pct=Math.min(100,num(calc?.materialPercent));
    const material=fixed*pct/100,labor=Math.max(0,fixed-material),rate=num(calc?.billingRate),target=rate?labor/rate:0;
    const plannedRegie=rows.reduce((s,r)=>s+((["regie","nachtrag_regie"].includes(r.kind))?num(r.plannedHours):0),0);
    return {baseNet,added,contract,regie,external,other,fixed,pct,material,labor,rate,target,plannedRegie};
  }

  function installTab(){
    const tabs=document.querySelector(".bk-tabs"),hub=document.getElementById("bkHub");if(!tabs||!hub)return false;
    if(!tabs.querySelector('[data-bk-tab="calculation"]')){
      const btn=document.createElement("button");btn.type="button";btn.dataset.bkTab="calculation";btn.textContent="Kalkulation";
      const economy=tabs.querySelector('[data-bk-tab="economy"]');economy?tabs.insertBefore(btn,economy):tabs.appendChild(btn);
      btn.addEventListener("click",()=>selectTab());
    }
    if(!hub.querySelector('[data-bk-panel="calculation"]')){
      const panel=document.createElement("section");panel.className="bk-panel";panel.dataset.bkPanel="calculation";panel.innerHTML='<div id="kcv2Host" class="bk-loading">Kalkulation wird geladen …</div>';
      const economyPanel=hub.querySelector('[data-bk-panel="economy"]');economyPanel?hub.insertBefore(panel,economyPanel):hub.appendChild(panel);
    }
    return true;
  }
  function selectTab(){
    document.querySelectorAll("[data-bk-tab]").forEach(b=>b.classList.toggle("active",b.dataset.bkTab==="calculation"));
    document.querySelectorAll("[data-bk-panel]").forEach(p=>p.classList.toggle("active",p.dataset.bkPanel==="calculation"));
  }

  async function loadJob(id){
    const serial=++loadSerial;currentJobId=String(id||"");if(!currentJobId)return;
    if(!installTab()){setTimeout(()=>loadJob(id),180);return}
    const host=document.getElementById("kcv2Host");if(host){host.className="bk-loading";host.textContent="Kalkulation wird geladen …"}
    try{
      const [jobsData,calcData]=await Promise.all([api("/admin/api/jobs"),api(`/admin/api/job/${encodeURIComponent(currentJobId)}/order-calculation`)]);
      if(serial!==loadSerial)return;
      currentJob=(jobsData.jobs||[]).find(j=>String(j.jobId)===currentJobId)||null;
      calculation=calcData.calculation||blankCalculation(currentJob);
      if(!calculation.billingRate)calculation.billingRate=num(currentJob?.calculation?.billingRate||currentJob?.billingRate);
      if(!calculation.materialPercent)calculation.materialPercent=num(currentJob?.materialPercent||currentJob?.calculation?.materialPercent);
      pendingFile=null;render();installEconomyObserver();setTimeout(patchEconomy,80);
    }catch(error){if(host){host.className="bk-placeholder";host.textContent="Kalkulation konnte nicht geladen werden: "+error.message}}
  }

  function sourceHtml(){
    const src=calculation?.sourceDocument;
    if(!src)return '<div class="kcv2-muted">Noch kein Auftrags-PDF gespeichert. Das PDF wird beim Speichern zur Baustelle gelegt.</div>';
    return `<div class="kcv2-source"><strong>📄 ${esc(src.name||'Auftrag.pdf')}</strong><a href="${esc(tokenUrl(`/admin/api/job/${encodeURIComponent(currentJobId)}/order-document`))}" target="_blank" rel="noopener">PDF öffnen</a><span class="kcv2-muted">${src.importedAt?new Date(src.importedAt).toLocaleString('de-AT'):''}</span></div>`;
  }
  function options(kind){return Object.entries(KINDS).map(([key,label])=>`<option value="${key}" ${key===kind?'selected':''}>${esc(label)}</option>`).join('')}
  function positionRows(){
    const rows=calculation?.positions||[];if(!rows.length)return '<div class="kcv2-empty">Noch keine Positionen. Auftrag oben hineinziehen oder einen Nachtrag anlegen.</div>';
    return `<div class="kcv2-table-wrap"><table class="kcv2-table"><thead><tr><th>Pos.</th><th style="width:160px">Art</th><th>Kurztext für Team</th><th style="width:120px" class="num">Betrag</th><th style="width:90px" class="num">Regie h</th><th style="width:70px">MA</th><th style="width:35px"></th></tr></thead><tbody>${rows.map((r,i)=>`<tr data-index="${i}"><td><div class="kcv2-pos">${esc(r.number||r.titleNo||('P'+(i+1)))}</div>${r.needsReview?'<span class="kcv2-review">prüfen</span>':''}</td><td><select data-field="kind">${options(r.kind)}</select></td><td><input data-field="shortText" value="${esc(r.shortText||r.title||'')}" title="${esc(r.description||'')}"></td><td><input data-field="amount" type="number" step="0.01" min="0" value="${num(r.amount)}"></td><td><input data-field="plannedHours" type="number" step="0.25" min="0" value="${num(r.plannedHours)}"></td><td style="text-align:center"><input data-field="employeeVisible" type="checkbox" ${r.employeeVisible!==false?'checked':''}></td><td><button class="kcv2-delete" data-delete type="button" title="Position entfernen">×</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  function teamGroup(title,klass,kind){
    const rows=(calculation?.positions||[]).filter(r=>r.employeeVisible!==false&&r.kind===kind);
    return `<div class="kcv2-team-group ${klass}"><h4>${esc(title)}</h4>${rows.length?`<ul>${rows.map(r=>`<li>${esc(r.shortText||r.title||r.description||'Position')}${num(r.plannedHours)&&["regie","nachtrag_regie"].includes(kind)?` · <strong>${esc(hours(r.plannedHours))}</strong>`:''}</li>`).join('')}</ul>`:'<div class="kcv2-team-empty">–</div>'}</div>`;
  }
  function teamHtml(){return `${teamGroup('Auftrag','', 'auftrag')}${teamGroup('Regie','regie','regie')}${teamGroup('Nachtrag Auftrag','nachtrag','nachtrag_auftrag')}${teamGroup('Nachtrag Regie','nachtrag-regie','nachtrag_regie')}`}

  function render(){
    const host=document.getElementById("kcv2Host");if(!host||!calculation)return;host.className="";
    host.innerHTML=`<div class="kcv2-shell">
      <div class="kcv2-top">
        <div class="kcv2-card"><h3>Auftrag / Angebot hineinziehen</h3><label id="kcv2Drop" class="kcv2-drop"><input id="kcv2File" type="file" accept="application/pdf,.pdf"><div><strong>PDF hier hineinziehen</strong><span>KRISTINE liest Positionen, Regie, Beträge und macht einen ersten Vorschlag.</span></div></label><div id="kcv2ParseStatus" class="kcv2-status"></div><div style="margin-top:10px">${sourceHtml()}</div></div>
        <div class="kcv2-card"><h3>Grundlage</h3><div class="kcv2-muted">Wir starten bewusst einfach. Materialanteil und Satz bleiben korrigierbar; Positionen kommen aus dem echten Auftrag.</div><div class="kcv2-settings"><div class="kcv2-field"><label>Auftrag netto lt. PDF</label><input id="kcv2Net" type="number" step="0.01" min="0" value="${num(calculation.netTotal)}"></div><div class="kcv2-field"><label>Materialanteil % fixer Auftrag</label><input id="kcv2Material" type="number" step="0.1" min="0" max="100" value="${num(calculation.materialPercent)}"></div><div class="kcv2-field"><label>Kalkulationssatz €/h</label><input id="kcv2Rate" type="number" step="0.01" min="0" value="${num(calculation.billingRate)}"></div></div><div class="kcv2-muted" style="margin-top:9px">${calculation.orderNo?`Auftrag ${esc(calculation.orderNo)} · `:''}${calculation.projectNo?`Projekt ${esc(calculation.projectNo)} · `:''}${esc(calculation.subject||currentJob?.name||'')}</div></div>
      </div>
      <div class="kcv2-card"><div class="kcv2-section-head"><h3>Kalkulationsweg</h3><span class="kcv2-muted">Regie und Nachtrag Regie laufen getrennt von den fixen Auftragsstunden.</span></div><div class="kcv2-summary"><div class="kcv2-kpi"><span>Auftrag inkl. Nachträge</span><strong id="kcv2SumContract">–</strong></div><div class="kcv2-kpi warn"><span>Regie separat</span><strong id="kcv2SumRegie">–</strong></div><div class="kcv2-kpi"><span>Fremdleistung</span><strong id="kcv2SumExternal">–</strong></div><div class="kcv2-kpi"><span>Fahrt / Sonstiges</span><strong id="kcv2SumOther">–</strong></div><div class="kcv2-kpi emph"><span>KRISTA fixer Auftrag</span><strong id="kcv2SumFixed">–</strong></div><div class="kcv2-kpi"><span>Material</span><strong id="kcv2SumMaterial">–</strong></div><div class="kcv2-kpi"><span>Lohnanteil</span><strong id="kcv2SumLabor">–</strong></div><div class="kcv2-kpi emph"><span>Sollstunden</span><strong id="kcv2SumHours">–</strong></div></div></div>
      <div class="kcv2-card"><div class="kcv2-section-head"><div><h3>Positionen</h3><div class="kcv2-muted">Die Kurztexte werden gleichzeitig zur Mitarbeiteransicht. Preise sieht die Mannschaft nicht.</div></div><div class="kcv2-actions"><button id="kcv2AddOrder" type="button">+ Nachtrag Auftrag</button><button id="kcv2AddRegie" class="regie" type="button">+ Nachtrag Regie</button></div></div><div id="kcv2Rows">${positionRows()}</div></div>
      <div class="kcv2-card"><div class="kcv2-section-head"><div><h3>Vorschau für die Mannschaft</h3><div class="kcv2-muted">Genau diese vier Blöcke können die Mitarbeiter in KRISTINE GO sehen – ohne Preise.</div></div></div><div id="kcv2Team" class="kcv2-team">${teamHtml()}</div></div>
      <div class="kcv2-savebar"><span id="kcv2SaveMsg" class="msg"></span><button id="kcv2Save" type="button">Kalkulation übernehmen</button></div>
    </div>`;
    bind();refreshNumbers();
  }

  function bind(){
    const drop=document.getElementById("kcv2Drop"),file=document.getElementById("kcv2File");
    file.onchange=()=>file.files?.[0]&&handlePdf(file.files[0]);
    ["dragenter","dragover"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.add("drag")}));
    ["dragleave","drop"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.remove("drag")}));
    drop.addEventListener("drop",e=>{const f=e.dataTransfer?.files?.[0];if(f)handlePdf(f)});
    document.getElementById("kcv2Net").oninput=e=>{calculation.netTotal=num(e.target.value);refreshNumbers()};
    document.getElementById("kcv2Material").oninput=e=>{calculation.materialPercent=Math.min(100,num(e.target.value));refreshNumbers()};
    document.getElementById("kcv2Rate").oninput=e=>{calculation.billingRate=num(e.target.value);refreshNumbers()};
    document.getElementById("kcv2AddOrder").onclick=()=>addNachtrag("nachtrag_auftrag");
    document.getElementById("kcv2AddRegie").onclick=()=>addNachtrag("nachtrag_regie");
    document.getElementById("kcv2Save").onclick=save;
    bindRows();
  }
  function bindRows(){
    document.querySelectorAll("#kcv2Rows tr[data-index]").forEach(tr=>{
      const i=Number(tr.dataset.index),row=calculation.positions[i];if(!row)return;
      tr.querySelectorAll("[data-field]").forEach(input=>input.addEventListener(input.tagName==="SELECT"?"change":"input",()=>{
        const field=input.dataset.field;
        if(field==="kind"){row.kind=input.value;row.needsReview=false;const badge=tr.querySelector('.kcv2-review');if(badge)badge.remove()}
        else if(field==="amount"||field==="plannedHours")row[field]=num(input.value);
        else if(field==="employeeVisible")row[field]=!!input.checked;
        else row[field]=input.value;
        refreshNumbers();
      }));
      tr.querySelector("[data-delete]").onclick=()=>{calculation.positions.splice(i,1);render()};
    });
  }
  function addNachtrag(kind){
    const n=(calculation.positions||[]).filter(r=>r.addToContract).length+1;
    calculation.positions.push({id:`nachtrag_${Date.now()}`,number:`N${n}`,titleNo:"N",title:KINDS[kind],shortText:"",description:"",amount:0,plannedHours:0,kind,suggestedKind:"",needsReview:false,employeeVisible:true,addToContract:true,source:"manual"});
    render();const rows=document.querySelectorAll('#kcv2Rows tr[data-index]');const last=rows[rows.length-1];last?.querySelector('[data-field="shortText"]')?.focus();
  }
  function refreshNumbers(){
    const d=derive(calculation);const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};
    set("kcv2SumContract",money(d.contract));set("kcv2SumRegie",`${money(d.regie)} · ${hours(d.plannedRegie)}`);set("kcv2SumExternal",money(d.external));set("kcv2SumOther",money(d.other));set("kcv2SumFixed",money(d.fixed));set("kcv2SumMaterial",`${money(d.material)} · ${d.pct.toLocaleString('de-AT',{maximumFractionDigits:1})} %`);set("kcv2SumLabor",money(d.labor));set("kcv2SumHours",hours(d.target));
    const team=document.getElementById("kcv2Team");if(team)team.innerHTML=teamHtml();
  }

  function euroValue(value){const n=Number(String(value||"").replace(/\./g,"").replace(",","."));return Number.isFinite(n)?n:0}
  function classify(title,description){
    const hay=`${title||''} ${description||''}`.toLowerCase();
    if(/regiearbeiten|nach tatsächlichem aufwand|nach tatsaechlichem aufwand/.test(hay))return {kind:"regie",suggestedKind:"regie",needsReview:false};
    if(/fahrtkosten|fahrtkostenpauschale/.test(hay))return {kind:"sonstiges",suggestedKind:"sonstiges",needsReview:false};
    if(/gerüst|geruest|stahlrohrgerüst|stahlrohrgeruest/.test(hay))return {kind:"fremdleistung",suggestedKind:"fremdleistung",needsReview:true};
    return {kind:"auftrag",suggestedKind:"",needsReview:false};
  }
  function cleanLead(value){return String(value||"").replace(/\s+/g," ").replace(/\s+\d[\d.]*,\d{2}(?:\s+\d[\d.]*,\d{2})*\s*$/," ").trim().slice(0,220)}
  function parseText(text,file){
    const lines=String(text||"").split(/\r?\n/).map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
    const whole=lines.join("\n");
    const moneyMatch=re=>{const m=whole.match(re);return m?euroValue(m[1]):0};
    const orderNo=(whole.match(/Auftragssteuerung[\s\S]{0,90}?(?:Nr\.?\s*:?)?\s*(\d{6,})/i)||[])[1]||"";
    const projectNo=(whole.match(/Projekt\s*:\s*([A-Za-z0-9_-]+)/i)||[])[1]||"";
    const netTotal=moneyMatch(/Nettosumme\s*=?\s*(?:EUR)?\s*([\d.]+,\d{2})/i);
    const vatAmount=moneyMatch(/(?:USt|MwSt)[^\n]{0,30}(?:EUR)?\s*([\d.]+,\d{2})/i);
    const grossTotal=moneyMatch(/Bruttosumme\s*=?\s*(?:EUR)?\s*([\d.]+,\d{2})/i);
    let currentTitleNo="",currentTitle="",current=null,positions=[];
    const finalize=()=>{if(!current)return;const description=current.parts.join(" ").replace(/\s+/g," ").trim();const values=description.match(/\d[\d.]*,\d{2}/g)||[];const amount=values.length?euroValue(values[values.length-1]):0;const hm=description.match(/(\d+(?:[.,]\d+)?)\s*Std\b/i);const plannedHours=hm?Number(hm[1].replace(",","."))||0:0;const cls=classify(currentTitle,description);positions.push({id:`pdf_${current.number.replace(/[^A-Za-z0-9]/g,'_')}_${positions.length+1}`,number:current.number,titleNo:currentTitleNo,title:currentTitle,shortText:cleanLead(current.parts[0]||currentTitle||description),description,amount,plannedHours,kind:cls.kind,suggestedKind:cls.suggestedKind,needsReview:cls.needsReview,employeeVisible:true,addToContract:false,source:"pdf"});current=null};
    for(const line of lines){
      if(/^Titelzusammenstellung\s*:?/i.test(line)){finalize();break}
      const tm=line.match(/^Titel\s+(\d+)\s+(.+)$/i);if(tm){finalize();currentTitleNo=tm[1];currentTitle=tm[2].replace(/\s+\d[\d.]*,\d{2}\s*$/," ").trim();continue}
      const pm=line.match(/^(\d{1,2}\.\d{2})\s+(.+)$/);if(pm){finalize();current={number:pm[1],parts:[pm[2]]};continue}
      if(current&&/^Summe\b/i.test(line)){finalize();continue}
      if(current&&!/^Pos\s+Menge\b/i.test(line)&&!/^Sparkasse\b/i.test(line)&&!/^Farben Krista\b/i.test(line)&&!/^Feldkircherstraße\b/i.test(line)&&!/^\[?Auftragssteuerung\b/i.test(line)&&!/^[-–]\s*\d+\s*[-–]$/.test(line))current.parts.push(line);
    }
    finalize();
    if(!positions.length){
      const start=lines.findIndex(x=>/^Titelzusammenstellung/i.test(x));if(start>=0){for(const line of lines.slice(start+1)){if(/^Nettosumme/i.test(line))break;const m=line.match(/^(\d{1,2})\s+(.+?)\s+(\d[\d.]*,\d{2})$/);if(!m)continue;const cls=classify(m[2],m[2]);positions.push({id:`title_${m[1]}`,number:m[1],titleNo:m[1],title:m[2],shortText:cleanLead(m[2]),description:m[2],amount:euroValue(m[3]),plannedHours:0,kind:cls.kind,suggestedKind:cls.suggestedKind,needsReview:cls.needsReview||/gerüst|geruest/i.test(m[2]),employeeVisible:true,addToContract:false,source:"pdf-title"})}}
    }
    const basename=String(file?.name||"").replace(/\.pdf$/i,"").replace(/^Auftragssteuerung\s*/i,"").trim();
    return {...blankCalculation(currentJob),orderNo,projectNo,subject:currentJob?.name||basename,netTotal:netTotal||positions.reduce((s,r)=>s+num(r.amount),0),vatAmount,grossTotal,rawText:whole.slice(0,60000),positions,sourceDocument:calculation?.sourceDocument||null,billingRate:num(calculation?.billingRate||currentJob?.calculation?.billingRate),materialPercent:num(calculation?.materialPercent||currentJob?.materialPercent),parseVersion:1};
  }

  function loadPdfJs(){
    if(window.pdfjsLib)return Promise.resolve(window.pdfjsLib);
    if(window.__kcv2PdfPromise)return window.__kcv2PdfPromise;
    window.__kcv2PdfPromise=new Promise((resolve,reject)=>{
      const script=document.createElement("script");script.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";script.onload=()=>{if(!window.pdfjsLib)return reject(new Error("PDF-Leser konnte nicht gestartet werden."));window.pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";resolve(window.pdfjsLib)};script.onerror=()=>reject(new Error("PDF-Leser konnte nicht geladen werden."));document.head.appendChild(script);
    });return window.__kcv2PdfPromise;
  }
  async function extractPdf(file){
    const pdfjs=await loadPdfJs(),data=new Uint8Array(await file.arrayBuffer()),doc=await pdfjs.getDocument({data}).promise,pages=[];
    for(let p=1;p<=doc.numPages;p++){
      const page=await doc.getPage(p),content=await page.getTextContent();
      const items=(content.items||[]).filter(x=>String(x.str||"").trim()).map(x=>({str:String(x.str||"").trim(),x:Number(x.transform?.[4]||0),y:Number(x.transform?.[5]||0)})).sort((a,b)=>Math.abs(a.y-b.y)>2?b.y-a.y:a.x-b.x);
      const lines=[];let row=[],lastY=null;for(const item of items){if(lastY!==null&&Math.abs(item.y-lastY)>2){lines.push(row.sort((a,b)=>a.x-b.x).map(x=>x.str).join(" "));row=[]}row.push(item);lastY=item.y}if(row.length)lines.push(row.sort((a,b)=>a.x-b.x).map(x=>x.str).join(" "));pages.push(lines.join("\n"));
    }
    return pages.join("\n");
  }
  async function handlePdf(file){
    const status=document.getElementById("kcv2ParseStatus");if(!/\.pdf$/i.test(file.name)){status.textContent="Bitte ein PDF verwenden.";status.className="kcv2-status error";return}
    pendingFile=file;status.textContent="PDF wird gelesen …";status.className="kcv2-status";
    try{const text=await extractPdf(file);calculation=parseText(text,file);status.textContent=`✓ ${calculation.positions.length} Positionen erkannt · bitte Vorschläge kurz prüfen`;render();const nextStatus=document.getElementById("kcv2ParseStatus");if(nextStatus)nextStatus.textContent=`✓ ${calculation.positions.length} Positionen erkannt aus ${file.name}`}
    catch(error){status.textContent="PDF konnte nicht automatisch gelesen werden: "+error.message;status.className="kcv2-status error"}
  }
  function fileBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||"").split(",")[1]||"");reader.onerror=()=>reject(reader.error||new Error("Datei konnte nicht gelesen werden."));reader.readAsDataURL(file)})}

  async function save(){
    const button=document.getElementById("kcv2Save"),msg=document.getElementById("kcv2SaveMsg");button.disabled=true;msg.textContent="Speichert …";
    try{
      if(pendingFile){const dataBase64=await fileBase64(pendingFile);const upload=await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/order-document`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fileName:pendingFile.name,dataBase64})});calculation.sourceDocument=upload.sourceDocument||calculation.sourceDocument}
      const result=await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/order-calculation`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({calculation})});calculation=result.calculation||calculation;pendingFile=null;msg.textContent="✓ Gespeichert · Wirtschaft und Mitarbeiteransicht sind aktualisiert";render();setTimeout(()=>{window.BaustellenKnowledgeHub?.load?.(currentJobId);loadJob(currentJobId)},450);
    }catch(error){msg.textContent="Fehler: "+error.message;msg.style.color="#a84540"}finally{button.disabled=false}
  }

  function patchEconomy(){
    if(!calculation?.updatedAt)return;const host=document.getElementById("bkEconomy");if(!host)return;const d=derive(calculation);const sourceBadge=host.querySelector(".bk-source.missing");if(sourceBadge&&calculation.sourceDocument){sourceBadge.classList.remove("missing");sourceBadge.textContent="PDF / Auftrag zugeordnet"}
    const cards=[...host.querySelectorAll(".bk-card.bk-wide")];const card=cards.find(x=>/Vom Auftrag zu den Stunden/i.test(x.textContent||""));if(!card||card.dataset.kcv2Patch===calculation.updatedAt)return;card.dataset.kcv2Patch=calculation.updatedAt;
    const actual=num(currentJob?.calculation?.orderHours??currentJob?.calculation?.actualHours),progress=d.target?actual/d.target*100:0;
    card.innerHTML=`<div class="bk-section-title"><h3>Vom Auftrag zu den Stunden</h3><span class="bk-source">live aus neuer Kalkulation</span></div><div class="kcv2-economy-flow"><div class="kcv2-e-step"><small>Auftrag inkl. Nachträge</small><strong>${money(d.contract)}</strong></div><div class="kcv2-e-step"><small>Regie separat</small><strong>${money(d.regie)}</strong></div><div class="kcv2-e-step"><small>Fremdleistung</small><strong>${money(d.external)}</strong></div><div class="kcv2-e-step"><small>Fahrt / Sonstiges</small><strong>${money(d.other)}</strong></div><div class="kcv2-e-step main"><small>KRISTA fixer Auftrag</small><strong>${money(d.fixed)}</strong></div><div class="kcv2-e-step"><small>Material</small><strong>${money(d.material)}</strong></div><div class="kcv2-e-step main"><small>Lohn → Sollstunden</small><strong>${money(d.labor)} → ${hours(d.target)}</strong></div></div><div class="bk-progress"><span style="width:${Math.min(100,Math.max(0,progress))}%;background:${progress>100?'#a84540':'#2f7d4a'}"></span></div><div class="bk-note">${progress.toLocaleString('de-AT',{maximumFractionDigits:1})} % der fix kalkulierten Auftragsstunden verbraucht · Regie wird separat geführt.</div>`;
  }
  function installEconomyObserver(){
    const host=document.getElementById("bkEconomy");if(!host||economyObserver)return;economyObserver=new MutationObserver(()=>queueMicrotask(patchEconomy));economyObserver.observe(host,{childList:true,subtree:true});
  }

  function hookRows(){document.addEventListener("click",e=>{const row=e.target.closest?.(".job-row[data-job]");if(row)setTimeout(()=>loadJob(row.dataset.job),20)},true);window.addEventListener("hashchange",()=>{const id=decodeURIComponent(location.hash.slice(1));if(id)loadJob(id)})}
  function init(){installCss();const wait=()=>{if(!installTab())return setTimeout(wait,150);hookRows();const id=decodeURIComponent(location.hash.slice(1));if(id)setTimeout(()=>loadJob(id),180)};wait()}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
  window.KristaOrderCalculation={version:VERSION,load:loadJob,tab:selectTab};
})();
