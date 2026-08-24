"use strict";

(function(){
  const VERSION="2026-08-24-1202";
  let installed=false;

  function card(){return document.querySelector("#tasks .task-create-card")}
  function backdrop(){return document.getElementById("kristaTaskCreateBackdrop")}
  function isOpen(){return backdrop()?.classList.contains("open")}

  function installStyle(){
    if(document.getElementById("kristaTaskCreateModalStyle"))return;
    const s=document.createElement("style");
    s.id="kristaTaskCreateModalStyle";
    s.textContent=`
      #tasks .krista-task-create-launch{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 10px}
      #tasks .krista-task-create-launch h3{margin:0}
      #tasks .krista-task-create-launch button{padding:8px 12px;font-weight:850}
      #kristaTaskCreateBackdrop{position:fixed;inset:0;z-index:39990;display:none;place-items:start center;padding:5vh 18px 18px;background:rgba(0,0,0,.52);overflow:auto}
      #kristaTaskCreateBackdrop.open{display:grid}
      #kristaTaskCreateBackdrop .task-create-card{width:min(1050px,100%);max-height:90vh;overflow:auto;margin:0!important;border-radius:18px;box-shadow:0 24px 85px rgba(0,0,0,.34)}
      #kristaTaskCreateBackdrop .krista-task-create-head{position:sticky;top:-16px;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-16px -16px 15px;padding:16px;background:#fff;border-bottom:1px solid #ebe7df;border-radius:18px 18px 0 0}
      #kristaTaskCreateBackdrop .krista-task-create-head h3{margin:0}
      #kristaTaskCreateBackdrop .krista-task-create-close{width:40px;min-width:40px;height:40px;padding:0;border-radius:10px;background:#fff;color:#222;border:1px solid #d6d1c9;font-size:22px;line-height:1}
      #kristaTaskCreateBackdrop .krista-task-create-footnote{font-size:11px;color:#777;margin-left:8px;align-self:center}
      body.krista-task-create-open{overflow:hidden}
      @media(max-width:760px){#kristaTaskCreateBackdrop{padding:10px}#kristaTaskCreateBackdrop .task-create-card{max-height:calc(100vh - 20px)}#tasks .krista-task-create-launch{align-items:stretch}#tasks .krista-task-create-launch button{width:100%}}
    `;
    document.head.appendChild(s);
  }

  function ensureLaunchButton(){
    const listCard=document.querySelector("#tasks .task-list-card");
    if(!listCard)return;
    let bar=listCard.querySelector(".krista-task-create-launch");
    if(!bar){
      const oldTitle=[...listCard.children].find(el=>el.tagName==="H3");
      bar=document.createElement("div");bar.className="krista-task-create-launch";
      const title=document.createElement("h3");title.textContent=oldTitle?.textContent||"Aufgaben";
      const button=document.createElement("button");button.type="button";button.className="green";button.dataset.kristaNewTask="1";button.textContent="＋ Neue Aufgabe";
      button.addEventListener("click",()=>open());
      bar.append(title,button);
      if(oldTitle){oldTitle.replaceWith(bar)}else listCard.insertBefore(bar,listCard.firstChild);
    }
  }

  function ensureBackdrop(){
    const tasks=document.getElementById("tasks");
    const form=card();
    if(!tasks||!form)return null;
    let bg=backdrop();
    if(!bg){
      bg=document.createElement("div");
      bg.id="kristaTaskCreateBackdrop";
      bg.setAttribute("role","dialog");
      bg.setAttribute("aria-modal","true");
      bg.setAttribute("aria-label","Neue Aufgabe");
      tasks.appendChild(bg);
      bg.addEventListener("click",event=>{if(event.target===bg)close()});
    }
    if(form.parentElement!==bg)bg.appendChild(form);
    if(!form.querySelector(".krista-task-create-head")){
      const oldTitle=[...form.children].find(el=>el.tagName==="H3");
      const head=document.createElement("div");head.className="krista-task-create-head";
      const title=document.createElement("h3");title.textContent=oldTitle?.textContent||"📝 Neue Aufgabe";
      const closeButton=document.createElement("button");closeButton.type="button";closeButton.className="krista-task-create-close";closeButton.title="Schließen";closeButton.setAttribute("aria-label","Schließen");closeButton.textContent="×";closeButton.onclick=close;
      head.append(title,closeButton);
      if(oldTitle)oldTitle.remove();
      form.insertBefore(head,form.firstChild);
    }
    return bg;
  }

  function open(){
    const bg=ensureBackdrop();if(!bg)return;
    bg.classList.add("open");
    document.body.classList.add("krista-task-create-open");
    setTimeout(()=>document.getElementById("tTitle")?.focus(),40);
  }

  function close(){
    const bg=backdrop();if(!bg)return;
    bg.classList.remove("open");
    document.body.classList.remove("krista-task-create-open");
  }

  function maybeOpenForPrefill(event){
    if(event?.isTrusted)return;
    const title=document.getElementById("tTitle");
    if(title&&String(title.value||"").trim())open();
  }

  function watchInboxPrefill(){
    const title=document.getElementById("tTitle");
    if(title&&!title.dataset.kristaTaskModalPrefill){
      title.dataset.kristaTaskModalPrefill="1";
      title.addEventListener("input",maybeOpenForPrefill);
      title.addEventListener("change",maybeOpenForPrefill);
    }
    const tasks=document.getElementById("tasks");
    if(tasks&&!tasks.dataset.kristaTaskModalObserver){
      tasks.dataset.kristaTaskModalObserver="1";
      new MutationObserver(()=>{
        const pending=document.getElementById("kristaInboxPending");
        if(pending&&pending.style.display!=="none"&&String(pending.textContent||"").trim())open();
      }).observe(tasks,{childList:true,subtree:true});
    }
  }

  function wrapAddTask(){
    const fn=window.addTask;
    if(typeof fn!=="function"||fn.__kristaTaskCreateModal)return;
    const wrapped=async function(){
      const result=await fn.apply(this,arguments);
      setTimeout(()=>{
        const title=document.getElementById("tTitle");
        if(isOpen()&&title&&!String(title.value||"").trim())close();
      },0);
      return result;
    };
    for(const key of ["__kristaUserCreator","__kristaInboxV2TaskHook"])if(fn[key])wrapped[key]=fn[key];
    wrapped.__kristaTaskCreateModal=true;
    window.addTask=wrapped;
  }

  function install(){
    if(!location.pathname.toLowerCase().includes("/kristine"))return;
    installStyle();ensureLaunchButton();ensureBackdrop();watchInboxPrefill();wrapAddTask();
    if(!installed){
      installed=true;
      document.addEventListener("keydown",event=>{if(event.key==="Escape"&&isOpen())close()});
      window.addEventListener("hashchange",()=>setTimeout(()=>{ensureLaunchButton();ensureBackdrop();watchInboxPrefill();wrapAddTask()},0));
      setInterval(()=>{ensureLaunchButton();ensureBackdrop();watchInboxPrefill();wrapAddTask()},1800);
      console.info("KRISTINE Aufgabenmaske",VERSION);
    }
  }

  window.openTaskCreateModal=open;
  window.closeTaskCreateModal=close;
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
})();
