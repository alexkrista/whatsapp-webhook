"use strict";

(function(){
  const VERSION="2026-08-24-0751";

  function taskCard(){return document.querySelector("#tasks .task-create-card")}

  function ensureSaveButton(){
    const card=taskCard();if(!card)return null;
    let button=card.querySelector('button[onclick="addTask()"]');
    let actions=button?.closest(".actions")||null;

    if(!actions){
      actions=document.createElement("div");
      actions.className="actions krista-task-save-actions";
      actions.style.marginTop="14px";
      const notice=card.querySelector("#taskSaveNotice");
      if(notice)card.insertBefore(actions,notice);else card.appendChild(actions);
    }

    if(!button){
      button=document.createElement("button");
      button.type="button";
      button.className="green";
      button.setAttribute("onclick","addTask()");
      button.textContent="+ Aufgabe anlegen";
      actions.appendChild(button);
    }

    button.hidden=false;
    if(button.style.display==="none")button.style.removeProperty("display");
    return button;
  }

  function relocatePendingBox(){
    const card=taskCard();
    const box=document.getElementById("kristaInboxPending");
    const grid=card?.querySelector(".task-formgrid");
    if(!card||!box||!grid)return;
    box.classList.add("full");
    if(box.parentElement!==grid)grid.appendChild(box);
  }

  function repair(){ensureSaveButton();relocatePendingBox()}

  function boot(){
    if(!location.pathname.toLowerCase().includes("/kristine"))return;
    repair();
    const target=document.getElementById("tasks")||document.body;
    new MutationObserver(()=>repair()).observe(target,{childList:true,subtree:true});
    window.addEventListener("hashchange",()=>setTimeout(repair,0));
    setTimeout(repair,250);
    setTimeout(repair,900);
    console.info("KRISTINE Task Save Guard",VERSION);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
