"use strict";

(function(){
  function ensureCss(href,id){
    if(document.getElementById(id)) return;
    const link=document.createElement("link");link.id=id;link.rel="stylesheet";link.href=href;document.head.appendChild(link);
  }
  function ensureScript(src,key){
    if(document.querySelector(`script[${key}]`)) return;
    const s=document.createElement("script");s.src=src;s.setAttribute(key,"1");s.defer=true;document.head.appendChild(s);
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
      @media(max-width:1250px){#empPersonnelDocumentsSection .personnel-add-grid{grid-template-columns:repeat(2,minmax(240px,1fr))!important}}
      @media(max-width:760px){#empPersonnelDocumentsSection .personnel-add-grid{grid-template-columns:1fr!important}}
    `;document.head.appendChild(s);
  }
  function install(){
    ensureCss("/public/ui/admin-employee-personnel-layout.css","kristaPersonnelLayoutCss");
    ensureScript("/public/ui/admin-employee-ui-polish.js","data-krista-admin-employee-polish");
    installStyle();installDropzone();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
  new MutationObserver(()=>installDropzone()).observe(document.documentElement,{childList:true,subtree:true});
})();
