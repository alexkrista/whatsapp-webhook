"use strict";

(function(){
  const VERSION="2026-08-24-0902";
  const USER_KEY="kristaCurrentUserId";
  const TASK_VIEW_KEY="kristaTaskOwnerView";
  let currentUserId="";
  let pendingTaskCreation=null;
  let booted=false;

  const norm=v=>String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
  const employeeId=e=>String(e?.id||e?.employeeId||"").trim();
  const employeeName=e=>String(e?.nickname||e?.rufname||e?.name||e?.employeeName||employeeId(e)||"Benutzer").trim();

  function employees(){
    try{
      const rows=typeof masterEmployees!=="undefined"&&Array.isArray(masterEmployees)?masterEmployees:(Array.isArray(data?.employees)?data.employees:[]);
      return rows.filter(e=>e&&e.active!==false&&employeeId(e));
    }catch{return []}
  }

  function findEmployee(id){return employees().find(e=>employeeId(e)===String(id||""))||null}
  function isAlexander(e){
    const text=norm([e?.nickname,e?.rufname,e?.firstName,e?.vorname,e?.name,e?.employeeName].filter(Boolean).join(" "));
    return /(^| )(alex|alexander)( |$)/.test(text)&&(/krista/.test(text)||text==="alex"||text==="alexander");
  }
  function roleFor(e){
    const explicit=String(e?.userRole||e?.accessRole||e?.role||"").trim().toLowerCase();
    if(explicit)return explicit;
    return isAlexander(e)?"admin":"user";
  }
  function current(){return findEmployee(currentUserId)||null}
  function currentId(){return employeeId(current())||currentUserId||""}
  function currentName(){return employeeName(current())||"Benutzer"}
  function can(permission){
    const e=current();
    if(!e)return false;
    if(permission==="financeApproval"){
      if(e.financeApproval===true||e.canApproveFinance===true)return true;
      if(e.financeApproval===false||e.canApproveFinance===false)return false;
      return isAlexander(e);
    }
    if(permission==="admin")return roleFor(e)==="admin";
    return true;
  }

  function resolveInitialUser(){
    const query=new URLSearchParams(location.search);
    const candidates=[
      query.get("employeeId"),
      localStorage.getItem(USER_KEY),
      localStorage.getItem("kristineGoEmployeeId")
    ].filter(Boolean);
    for(const id of candidates){if(findEmployee(id))return String(id)}
    const alex=employees().find(isAlexander);
    return alex?employeeId(alex):(employees()[0]?employeeId(employees()[0]):"");
  }

  function setCurrentUser(id,{persist=true}={}){
    const e=findEmployee(id);if(!e)return false;
    const changed=currentUserId!==employeeId(e);
    currentUserId=employeeId(e);
    if(persist)localStorage.setItem(USER_KEY,currentUserId);
    if(changed)localStorage.setItem(TASK_VIEW_KEY,"me");
    updateCreatorField();
    renderIdentity();
    ensureTaskViewFilter();
    if(changed){
      window.dispatchEvent(new CustomEvent("krista:userchange",{detail:{id:currentUserId,name:employeeName(e),role:roleFor(e)}}));
      if(typeof window.renderTasks==="function")setTimeout(()=>window.renderTasks(),0);
    }
    return true;
  }

  function updateCreatorField(){
    const field=document.getElementById("tCreatorName");
    if(field&&currentName()&&field.value!==currentName()){
      field.value=currentName();
      field.dispatchEvent(new Event("input",{bubbles:true}));
      field.dispatchEvent(new Event("change",{bubbles:true}));
    }
  }

  function installStyle(){
    if(document.getElementById("kristaUserContextStyle"))return;
    const s=document.createElement("style");s.id="kristaUserContextStyle";s.textContent=`
      .krista-user-context{display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:145px}.krista-user-context strong{font-size:12px}.krista-user-context small{font-size:10px;opacity:.7}.krista-user-context button{border:0;background:transparent;color:inherit;padding:0;font:inherit;text-align:right;cursor:pointer}.krista-user-context button:hover{text-decoration:underline}
      .krista-user-pick-bg{position:fixed;inset:0;background:rgba(0,0,0,.48);z-index:50020;display:none;place-items:center;padding:18px}.krista-user-pick-bg.open{display:grid}.krista-user-pick{width:min(420px,100%);background:#fff;color:#222;border-radius:16px;padding:18px;box-shadow:0 20px 70px rgba(0,0,0,.28)}.krista-user-pick h3{margin:0 0 12px}.krista-user-pick select{width:100%;margin:7px 0 14px}.krista-user-pick-actions{display:flex;justify-content:flex-end;gap:8px}
      .krista-task-ownerbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 12px;padding:9px 10px;border:1px solid #e4e0d8;background:#faf9f6;border-radius:10px}.krista-task-ownerbar label{margin:0;font-size:12px;font-weight:800;color:#555}.krista-task-ownerbar select{width:auto;min-width:220px;padding:7px 9px;background:#fff}.krista-task-ownerbar .krista-task-userhint{margin-left:auto;font-size:11px;color:#777}
      @media(max-width:760px){.krista-user-context{align-items:flex-start}.krista-task-ownerbar select{width:100%;min-width:0}.krista-task-ownerbar .krista-task-userhint{width:100%;margin-left:0}}
    `;document.head.appendChild(s);
  }

  function ensureUserPicker(){
    let bg=document.getElementById("kristaUserPickBg");if(bg)return bg;
    bg=document.createElement("div");bg.id="kristaUserPickBg";bg.className="krista-user-pick-bg";
    bg.innerHTML=`<div class="krista-user-pick"><h3>Benutzer festlegen</h3><div class="small">Dieser Benutzer wird auf diesem Gerät gespeichert und für „Von“, persönliche Aufgaben und Berechtigungen verwendet.</div><select id="kristaUserPickSelect"></select><div class="krista-user-pick-actions"><button type="button" class="secondary" data-user-cancel>Abbrechen</button><button type="button" class="green" data-user-save>Übernehmen</button></div></div>`;
    document.body.appendChild(bg);
    bg.addEventListener("click",e=>{if(e.target===bg||e.target.closest("[data-user-cancel]"))bg.classList.remove("open")});
    bg.querySelector("[data-user-save]").onclick=()=>{const id=bg.querySelector("#kristaUserPickSelect")?.value;if(setCurrentUser(id))bg.classList.remove("open")};
    return bg;
  }

  function openUserPicker(){
    const bg=ensureUserPicker();const select=bg.querySelector("#kristaUserPickSelect");
    select.innerHTML=employees().sort((a,b)=>employeeName(a).localeCompare(employeeName(b),"de")).map(e=>`<option value="${esc(employeeId(e))}" ${employeeId(e)===currentId()?"selected":""}>${esc(employeeName(e))}</option>`).join("");
    bg.classList.add("open");
  }

  function renderIdentity(){
    const host=document.querySelector(".krista-user");if(!host||!current())return;
    host.classList.add("krista-user-context");
    host.innerHTML=`<button type="button" title="Benutzer auf diesem Gerät ändern"><strong>${esc(currentName())}</strong></button><small>${roleFor(current())==="admin"?"Chef / Admin":"Benutzer"}</small>`;
    host.querySelector("button").onclick=openUserPicker;
  }

  function financeTask(task){return String(task?.creatorId||"")==="brain-finance"||String(task?.reminder||"").includes("[FINANCE_APPROVAL]")}
  function taskMatchesUser(task,id){
    const wanted=findEmployee(id);if(!wanted)return false;
    if(String(task?.assigneeId||"")===employeeId(wanted))return true;
    return Boolean(task?.assigneeName&&norm(task.assigneeName)===norm(employeeName(wanted)));
  }
  function taskView(){return localStorage.getItem(TASK_VIEW_KEY)||"me"}
  function taskVisible(task){
    if(financeTask(task)&&!can("financeApproval"))return false;
    const view=taskView();
    if(view==="all")return true;
    const id=view==="me"?currentId():view;
    return id?taskMatchesUser(task,id):true;
  }

  function ensureTaskViewFilter(){
    const card=document.querySelector("#tasks .task-list-card");if(!card||!current())return;
    let bar=card.querySelector(".krista-task-ownerbar");
    if(!bar){
      bar=document.createElement("div");bar.className="krista-task-ownerbar";
      const tabs=card.querySelector(".task-tabs");
      if(tabs)tabs.insertAdjacentElement("afterend",bar);else card.insertBefore(bar,card.querySelector("#taskList"));
    }
    const view=taskView();
    const people=employees().sort((a,b)=>employeeName(a).localeCompare(employeeName(b),"de"));
    bar.innerHTML=`<label for="kristaTaskOwnerFilter">Anzeigen</label><select id="kristaTaskOwnerFilter"><option value="me" ${view==="me"?"selected":""}>Meine Aufgaben · ${esc(currentName())}</option>${people.map(e=>`<option value="${esc(employeeId(e))}" ${view===employeeId(e)?"selected":""}>${esc(employeeName(e))}</option>`).join("")}<option value="all" ${view==="all"?"selected":""}>Alle Aufgaben</option></select><span class="krista-task-userhint">Angemeldet: ${esc(currentName())}</span>`;
    bar.querySelector("select").onchange=e=>{localStorage.setItem(TASK_VIEW_KEY,e.target.value||"me");if(typeof window.renderTasks==="function")window.renderTasks()};
  }

  function installRenderScope(){
    const fn=window.renderTasks;
    if(typeof fn!=="function"||fn.__kristaUserScope)return;
    const wrapped=function(){
      let originalTasks=null;
      try{
        if(typeof data!=="undefined"&&Array.isArray(data.tasks)){
          originalTasks=data.tasks;
          data.tasks=originalTasks.filter(taskVisible);
        }
        return fn.apply(this,arguments);
      }finally{
        if(originalTasks)data.tasks=originalTasks;
        setTimeout(ensureTaskViewFilter,0);
      }
    };
    for(const key of ["__kristaCompact","__kristaFinanceApproval","__kristaBeulen"])if(fn[key])wrapped[key]=fn[key];
    wrapped.__kristaUserScope=true;
    window.renderTasks=wrapped;
  }

  function installModalScope(){
    const fn=window.openTaskListModal;
    if(typeof fn!=="function"||fn.__kristaUserScope)return;
    const wrapped=function(focusId=""){
      if(focusId){
        const task=(typeof data!=="undefined"&&Array.isArray(data.tasks))?data.tasks.find(t=>String(t.id)===String(focusId)):null;
        if(task&&!taskVisible(task)){alert("Diese Aufgabe ist für diesen Benutzer nicht freigegeben.");return}
      }
      let originalTasks=null;
      try{
        if(!focusId&&typeof data!=="undefined"&&Array.isArray(data.tasks)){
          originalTasks=data.tasks;data.tasks=originalTasks.filter(taskVisible);
        }
        return fn.apply(this,arguments);
      }finally{if(originalTasks)data.tasks=originalTasks}
    };
    wrapped.__kristaUserScope=true;window.openTaskListModal=wrapped;
  }

  function installTaskCreatorHooks(){
    if(typeof window.persistTasks==="function"&&!window.persistTasks.__kristaUserCreator){
      const originalPersist=window.persistTasks;
      const wrappedPersist=function(){
        if(pendingTaskCreation&&typeof data!=="undefined"&&Array.isArray(data.tasks)){
          for(const task of data.tasks){
            if(!pendingTaskCreation.before.has(String(task.id||""))){
              task.creatorId=pendingTaskCreation.id||task.creatorId||"admin";
              task.creatorName=pendingTaskCreation.name||task.creatorName||"Chef / Büro";
            }
          }
        }
        return originalPersist.apply(this,arguments);
      };
      wrappedPersist.__kristaUserCreator=true;window.persistTasks=wrappedPersist;
    }

    if(typeof window.addTask==="function"&&!window.addTask.__kristaUserCreator){
      const originalAdd=window.addTask;
      const wrappedAdd=async function(){
        updateCreatorField();
        const before=new Set(((typeof data!=="undefined"&&Array.isArray(data.tasks))?data.tasks:[]).map(t=>String(t.id||"")));
        pendingTaskCreation={before,id:currentId(),name:currentName()};
        try{return await originalAdd.apply(this,arguments)}finally{pendingTaskCreation=null;updateCreatorField()}
      };
      wrappedAdd.__kristaUserCreator=true;window.addTask=wrappedAdd;
    }
  }

  function guardFinanceActions(){
    for(const name of ["financeApproveTask","financeReduceTask","financeBlockTask"]){
      const fn=window[name];if(typeof fn!=="function"||fn.__kristaUserGuard)continue;
      const wrapped=function(){if(!can("financeApproval")){alert("Rechnungsfreigaben sind nur für Alexander freigeschaltet.");return}return fn.apply(this,arguments)};
      wrapped.__kristaUserGuard=true;window[name]=wrapped;
    }
  }

  function refresh(){
    if(!employees().length)return;
    if(!currentUserId)setCurrentUser(resolveInitialUser(),{persist:true});
    else if(!current())setCurrentUser(resolveInitialUser(),{persist:true});
    installStyle();renderIdentity();updateCreatorField();ensureTaskViewFilter();installRenderScope();installModalScope();installTaskCreatorHooks();guardFinanceActions();
  }

  function boot(){
    if(booted||!location.pathname.toLowerCase().includes("/kristine"))return;booted=true;
    installStyle();
    setInterval(refresh,1200);
    window.addEventListener("hashchange",()=>setTimeout(refresh,0));
    window.addEventListener("krista:userchange",()=>setTimeout(refresh,0));
    setTimeout(refresh,0);setTimeout(refresh,400);setTimeout(refresh,1200);
    console.info("KRISTINE Benutzerkontext",VERSION);
  }

  window.KristaUser={current,currentId,currentName,role:()=>roleFor(current()),can,setCurrentUser,openUserPicker,taskVisible,version:VERSION};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
