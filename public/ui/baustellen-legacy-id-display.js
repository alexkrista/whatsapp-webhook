"use strict";

(function(){
  const VERSION="2026-08-23-legacy-id-display-2";

  function isRealJobNumber(value){
    return /^\d{5}$/.test(String(value||"").trim());
  }

  function humanizeLegacyId(value){
    return String(value||"")
      .trim()
      .replace(/^[@#]+/,"")
      .replace(/[_-]+/g," ")
      .replace(/\s+/g," ")
      .trim()
      .replace(/(^|\s)([a-zäöü])/g,(m,space,char)=>space+char.toUpperCase());
  }

  function visibleRowName(row,id){
    const name=row?.querySelector(".job-name");
    if(!name)return humanizeLegacyId(id);
    const direct=[...name.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);
    const current=String(direct?.nodeValue||"").trim();
    return !current||/^ohne bezeichnung$/i.test(current)?humanizeLegacyId(id):current;
  }

  function normalizeRow(row){
    const id=String(row?.dataset?.job||"").trim();
    if(!id||isRealJobNumber(id))return;

    const number=row.querySelector(".job-number");
    if(number){
      number.textContent="";
      number.setAttribute("aria-label","Keine Baustellennummer vergeben");
    }

    const name=row.querySelector(".job-name");
    if(name){
      const display=visibleRowName(row,id);
      const direct=[...name.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);
      if(direct)direct.nodeValue=display;
      else name.prepend(document.createTextNode(display));
      name.dataset.legacyDisplayName=display;
    }
  }

  function normalizeRows(){
    document.querySelectorAll(".job-row[data-job]").forEach(normalizeRow);
  }

  function normalizeDetail(id,row){
    id=String(id||"").trim();
    if(!id||isRealJobNumber(id))return;
    const display=row?.querySelector(".job-name")?.dataset?.legacyDisplayName||visibleRowName(row,id)||humanizeLegacyId(id);

    const number=document.getElementById("detailNumber");
    const name=document.getElementById("detailName");
    if(number)number.textContent="";
    if(name&&(!String(name.textContent||"").trim()||/^ohne bezeichnung$/i.test(String(name.textContent||"").trim())))name.textContent=display;

    const cockpitTitle=document.querySelector("#bcShell .bc-title");
    if(cockpitTitle&&cockpitTitle.textContent.includes("#"+id)){
      cockpitTitle.textContent=display;
    }
    document.querySelectorAll(".bi-brief-title").forEach(el=>{
      if(el.textContent.includes(id)&&/ohne bezeichnung/i.test(el.textContent))el.textContent=display;
    });
  }

  function loadFotoGallery(){
    if(document.querySelector("script[data-baustellen-foto-gallery]"))return;
    const script=document.createElement("script");
    script.src="/public/ui/baustellen-foto-gallery.js?v=20260823-gallery1";
    script.defer=true;
    script.setAttribute("data-baustellen-foto-gallery","1");
    document.head.appendChild(script);
  }

  function install(){
    if(!location.pathname.toLowerCase().includes("baustellen.html")&&!location.pathname.toLowerCase().includes("/kristine/baustellen"))return;
    loadFotoGallery();
    normalizeRows();

    const list=document.getElementById("jobList");
    if(list){
      new MutationObserver(normalizeRows).observe(list,{subtree:true,childList:true});
    }

    document.addEventListener("click",event=>{
      const row=event.target.closest?.(".job-row[data-job]");
      if(!row)return;
      const id=row.dataset.job;
      if(isRealJobNumber(id))return;
      setTimeout(()=>normalizeDetail(id,row),0);
      setTimeout(()=>normalizeDetail(id,row),250);
      setTimeout(()=>normalizeDetail(id,row),900);
    },true);

    const detail=document.getElementById("detail");
    if(detail){
      new MutationObserver(()=>{
        const id=decodeURIComponent(location.hash.slice(1));
        if(id&&!isRealJobNumber(id))normalizeDetail(id,document.querySelector(`.job-row[data-job="${CSS.escape(id)}"]`));
      }).observe(detail,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["class"]});
    }

    const hash=decodeURIComponent(location.hash.slice(1));
    if(hash&&!isRealJobNumber(hash))setTimeout(()=>normalizeDetail(hash,document.querySelector(`.job-row[data-job="${CSS.escape(hash)}"]`)),500);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);else install();
  window.BaustellenLegacyIdDisplay={version:VERSION,refresh:normalizeRows};
})();
