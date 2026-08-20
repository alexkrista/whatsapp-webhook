"use strict";

(function(){
  let worktimeModelCache=[];

  function ensureCss(href,id){
    if(document.getElementById(id)) return;
    const link=document.createElement("link");link.id=id;link.rel="stylesheet";link.href=href;document.head.appendChild(link);
  }
  function ensureScript(src,key){
    if(document.querySelector(`script[${key}]`)) return;
    const s=document.createElement("script");s.src=src;s.setAttribute(key,"1");s.defer=true;document.head.appendChild(s);
  }
  function withToken(pathname){
    const url=new URL(pathname,location.origin);
    const token=new URLSearchParams(location.search).get("token");
    if(token)url.searchParams.set("token",token);
    return `${url.pathname}${url.search}`;
  }
  async function loadWorktimeModelCache(){
    try{
      const response=await fetch(withToken("/admin/api/worktime-models"),{credentials:"same-origin"});
      const data=await response.json();
      if(response.ok&&data?.ok!==false&&Array.isArray(data?.models))worktimeModelCache=data.models;
    }catch{}
    enableWorktimeAssignment();
  }
  function currentModel(){
    const select=document.getElementById("empWorktimeModel");
    return worktimeModelCache.find(model=>String(model?.id||"")===String(select?.value||""))||null;
  }
  function formatHours(value){
    const number=Number(value);
    if(!Number.isFinite(number))return "";
    return number.toLocaleString("de-AT",{minimumFractionDigits:0,maximumFractionDigits:2});
  }
  function renderWorktimeSummary(){
    const box=document.getElementById("worktimeModelSummary");
    const model=currentModel();
    if(!box||!model)return;

    if(model.id==="krista-standard"){
      box.innerHTML=`<strong>${model.name||"Produktion · Sommer/Winter"}</strong><br>${model.description||"Produktionsmodell mit Sommer- und Winterregel."}`;
      return;
    }
    if(model.id==="office-alex"&&Number(model.automaticPayrollHours)>0){
      box.innerHTML=`<strong>${model.name||"Alex"}</strong><br>Automatisch ${formatHours(model.automaticPayrollHours)} h Fink-Lohnzeit intern · echte Baustellenstempel bleiben separate Projektzeit.`;
      return;
    }
    if(model.configured===false){
      box.innerHTML=`<strong>${model.name||"Arbeitszeitmodell"}</strong><br>Modell angelegt · konkrete Arbeitstage und Zeiten werden noch festgelegt. Bis dahin keine automatische Zeit.`;
      return;
    }
    box.innerHTML=`<strong>${model.name||"Arbeitszeitmodell"}</strong><br>${model.description||"Arbeitszeit wird nach diesem Modell geführt."}`;
  }
  function enableWorktimeAssignment(){
    const worktime=document.getElementById("empWorktimeModel");
    if(!worktime)return;

    // Ein früherer UI-Hotfix hatte die Zuordnung absichtlich schreibgeschützt.
    // Die Modelllogik liegt jetzt zentral im Arbeitszeitmodell; die Mitarbeiterkarte
    // darf deshalb wieder ausschließlich die Modell-ID zuordnen.
    worktime.disabled=false;
    worktime.classList.remove("employee-rule-readonly");
    worktime.style.pointerEvents="auto";
    worktime.style.cursor="pointer";
    const label=worktime.closest("div")?.querySelector("label");
    if(label)label.textContent="Arbeitszeitmodell";

    if(!worktime.dataset.kristaModelAssignment){
      worktime.dataset.kristaModelAssignment="1";
      worktime.addEventListener("change",()=>setTimeout(renderWorktimeSummary,0));
    }
    setTimeout(renderWorktimeSummary,0);
  }
  function installDropzone(){
    const section=document.getElementById("empPersonnelDocumentsSection");
    if(!section||document.getElementById("empPersonnelDropzone")) return;
    const grid=section.querySelector(".personnel-add-grid");
    if(!grid) return;
    const zone=document.createElement("div");
    zone.id="empPersonnelDropzone";
    zone.className="emp-personnel-dropzone";
    zone.innerHTML='<strong>📥 Dokumente hier hineinziehen</strong><span>Mehrere Dateien möglich · werden nacheinander in die Personalakte übernommen</span><small>JPG/PNG/WebP/PDF/DOC/DOCX · max. 4 MB je Datei</small>';
    grid.insertAdjacentElement("beforebegin",zone);
    const fileInput=document.getElementById("empPersonnelDocFile");
    const title=document.getElementById("empPersonnelDocTitle");
    const add=document.getElementById("empPersonnelDocAdd");
    const category=document.getElementById("empPersonnelDocCategory");
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    async function addFile(file){
      if(!fileInput||!add) return;
      const dt=new DataTransfer();dt.items.add(file);fileInput.files=dt.files;
      if(title&&!title.value) title.value=file.name.replace(/\.[^.]+$/,"");
      if(category&&!category.value) category.value="Sonstiges";
      const before=document.querySelectorAll("#empPersonnelDocumentsList .employee-personnel-row").length;
      add.click();
      for(let i=0;i<40;i++){
        await wait(100);
        const now=document.querySelectorAll("#empPersonnelDocumentsList .employee-personnel-row").length;
        if(now>before) break;
      }
    }
    async function handle(files){
      const list=[...(files||[])];if(!list.length)return;
      zone.classList.add("busy");zone.querySelector("span").textContent=`${list.length} Dokument(e) werden übernommen …`;
      for(const file of list) await addFile(file);
      zone.classList.remove("busy");zone.querySelector("span").textContent="Mehrere Dateien möglich · werden nacheinander in die Personalakte übernommen";
    }
    ["dragenter","dragover"].forEach(t=>zone.addEventListener(t,e=>{e.preventDefault();zone.classList.add("dragover")}));
    ["dragleave","drop"].forEach(t=>zone.addEventListener(t,e=>{e.preventDefault();zone.classList.remove("dragover")}));
    zone.addEventListener("drop",e=>handle(e.dataTransfer?.files));
    zone.addEventListener("click",()=>fileInput?.click());
  }
  function installStyle(){
    if(document.getElementById("kristaEmployeeBeulenStyle")) return;
    const s=document.createElement("style");s.id="kristaEmployeeBeulenStyle";s.textContent=`
      #empPersonnelDocumentsSection{width:100%!important;max-width:none!important}
      #empPersonnelDocumentsSection .personnel-add-grid{grid-template-columns:minmax(240px,1.2fr) minmax(190px,.8fr) minmax(170px,.65fr) minmax(360px,1.6fr)!important;gap:14px 16px!important}
      #empPersonnelDocumentsSection .personnel-add-grid .full{grid-column:1/-1!important}
      #empPersonnelDocumentsSection .personnel-add-grid input,#empPersonnelDocumentsSection .personnel-add-grid select{width:100%!important;max-width:none!important}
      .emp-personnel-dropzone{grid-column:1/-1;border:2px dashed #aeb8ad;border-radius:14px;padding:18px 20px;margin:14px 0;background:#f8faf7;display:grid;gap:4px;cursor:pointer;transition:.15s ease}
      .emp-personnel-dropzone strong{font-size:15px}.emp-personnel-dropzone span,.emp-personnel-dropzone small{color:#6d756d}.emp-personnel-dropzone.dragover{border-color:#27713d;background:#eef7ee;box-shadow:0 0 0 3px rgba(39,113,61,.10)}.emp-personnel-dropzone.busy{opacity:.72;pointer-events:none}
      #empWorktimeModel:not(:disabled){background:#fff!important;color:#202020!important;font-weight:700;pointer-events:auto!important;cursor:pointer!important}
      @media(max-width:1250px){#empPersonnelDocumentsSection .personnel-add-grid{grid-template-columns:repeat(2,minmax(240px,1fr))!important}}
      @media(max-width:760px){#empPersonnelDocumentsSection .personnel-add-grid{grid-template-columns:1fr!important}}
    `;document.head.appendChild(s);
  }
  function install(){
    ensureCss("/public/ui/admin-employee-personnel-layout.css","kristaPersonnelLayoutCss");
    ensureScript("/public/ui/admin-employee-ui-polish.js","data-krista-admin-employee-polish");
    installStyle();installDropzone();enableWorktimeAssignment();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{install();loadWorktimeModelCache()},{once:true});else{install();loadWorktimeModelCache()}
  new MutationObserver(()=>{installDropzone();enableWorktimeAssignment()}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["disabled","class"]});
})();
