"use strict";

(function(){
  const VERSION="2026-08-24-1155";
  let lastKey="";
  let attempts=0;

  function currentView(){
    try{return localStorage.getItem("kristaTaskOwnerView")||"me"}catch{return "me"}
  }

  function enforce(force=false){
    const user=window.KristaUser;
    const render=window.renderTasks;
    if(!user||typeof user.currentId!=="function"||typeof render!=="function"||!render.__kristaUserScope)return false;
    const id=String(user.currentId()||"");
    if(!id)return false;
    const key=id+"|"+currentView();
    if(!force&&key===lastKey)return true;
    lastKey=key;
    render();
    return true;
  }

  function boot(){
    const timer=setInterval(()=>{
      attempts++;
      if(enforce(false)||attempts>=30)clearInterval(timer);
    },250);
    setTimeout(()=>enforce(true),1200);
    window.addEventListener("krista:userchange",()=>setTimeout(()=>enforce(true),0));
    window.addEventListener("hashchange",()=>setTimeout(()=>enforce(true),0));
    document.addEventListener("change",event=>{
      if(event.target?.id==="kristaTaskOwnerFilter")setTimeout(()=>enforce(true),0);
    });
    console.info("KRISTINE Aufgaben-Sicht Guard",VERSION);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
