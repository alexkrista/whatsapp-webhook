"use strict";

(function(){
  const VERSION="2026-08-24-0920";
  const USER_KEY="kristaCurrentUserIdV2";
  const SESSION_USER_KEY="kristaCurrentSessionUserIdV2";
  const DEVICE_ADMIN_KEY="kristaDeviceAdminV2";
  const SESSION_ADMIN_KEY="kristaSessionAdminV2";
  const TASK_VIEW_KEY="kristaTaskOwnerView";
  let currentUserId="";
  let pendingTaskCreation=null;
  let booted=false;
  let promptShown=false;

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
  function currentName(){return current()?employeeName(current()):""}
  function adminDevice(){return localStorage.getItem(DEVICE_ADMIN_KEY)==="1"||sessionStorage.getItem(SESSION_ADMIN_KEY)==="1"}
  function canChangeIdentity(){return !current()||isAlexander(current())||adminDevice()}
  function can(permission){
    const e=current();
    if(!e)return false;
    if(permission==="financeApproval"){
      if(e.financeApproval===true||e.canApproveFinance===true)return true;
      if(e.financeApproval===false||e.canApproveFinance===false)return false;
      return isAlexander(e);
    }
    if(permission==="admin")return isAlexander(e)||roleFor(e)==="admin";
    return true;
  }

  function resolveInitialUser(){
    const candidates=[
      sessionStorage.getItem(SESSION_USER_KEY),
      localStorage.getItem(USER_KEY)
    ].filter(Boolean);
    for(const id of candidates){if(findEmployee(id))return String(id)}
    return "";
  }

  function rememberMode(){
    if(sessionStorage.getItem(SESSION_USER_KEY))return "session";
    if(localStorage.getItem(USER_KEY))return "device";
    return "none";
  }

  function setCurrentUser(id,{remember=true,force=false}={}){
    const e=findEmployee(id);if(!e)return false;
    if(current()&&employeeId(current())!==employeeId(e)&&!force&&!canChangeIdentity()){
      alert("Der Benutzer ist auf diesem Gerät gesperrt. Nur Alexander kann die Zuordnung ändern.");
      return false;
    }
    const changed=currentUserId!==employeeId(e);
    currentUserId=employeeId(e);

    if(remember){
      localStorage.setItem(USER_KEY,currentUserId);
      sessionStorage.removeItem(SESSION_USER_KEY);
      if(isAlexander(e))localStorage.setItem(DEVICE_ADMIN_KEY,"1");
    }else{
      sessionStorage.setItem(SESSION_USER_KEY,currentUserId);
      if(isAlexander(e))sessionStorage.setItem(SESSION_ADMIN_KEY,"1");
    }

    if(changed)localStorage.setItem(TASK_VIEW_KEY,"me");
    updateCreatorField();
    renderIdentity();
    ensureTaskViewFilter();
    if(changed){
      window.dispatchEvent(new CustomEvent("krista:userchange",{detail:{id:currentUserId,name:employeeName(e),role:roleFor(e),remember:remember?"device":"session"}}));
      if(typeof window.renderTasks==="function")setTimeout(()=>window.renderTasks(),0);
    }
    return true;
  }

  function updateCreatorField(){
    const field=document.getElementById("tCreatorName");
    if(!field)return;
    if(currentName()&&field.value!==currentName()){
      field.value=currentName();
      field.dispatchEvent(new Event("input",{bubbles:true}));
      field.dispatchEvent(new Event("change",{bubbles:true}));
    }
    field.readOnly=Boolean(current());
    field.title=current()?"Wird automatisch vom angemeldeten Benutzer gesetzt.":"";
  }

  function installStyle(){
    if(document.getElementById("kristaUserContextStyle"))return;
    const s=document.createElement("style");s.id="kristaUserContextStyle";s.textContent=`
      .krista-user-context{display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:145px}.krista-user-context strong{font-size:12px}.krista-user-context small{font-size:10px;opacity:.72}.krista-user-context button{border:0;background:transparent;color:inherit;padding:0;font:inherit;text-align:right;cursor:pointer}.krista-user-context button:hover{text-decoration:underline}.krista-user-context .krista-user-static{display:block;text-align:right}
      .krista-user-pick-bg{position:fixed;inset:0;background:rgba(0,0,0,.52);z-index:50020;display:none;place-items:center;padding:18px}.krista-user-pick-bg.open{display:grid}.krista-user-pick{width:min(440px,100%);background:#fff;color:#222;border-radius:18px;padding:20px;box-shadow:0 20px 70px rgba(0,0,0,.3)}.krista-user-pick h3{margin:0 0 7px}.krista-user-pick select{width:100%;margin:12px 0}.krista-user-remember{display:flex;align-items:flex-start;gap:9px;padding:11px 12px;border:1px solid #e0ddd5;border-radius:11px;background:#faf9f6;margin-bottom:14px;cursor:pointer}.krista-user-remember input{width:auto;margin:2px 0 0;flex:0 0 auto}.krista-user-remember strong{display:block;font-size:13px}.krista-user-remember small{display:block;color:#777;margin-top:2px;line-height:1.35}.krista-user-pick-actions{display:flex;justify-content:flex-end;gap:8px}.krista-user-lockhint{margin-top:9px;padding:8px 10px;border-radius:9px;background:#eef7ee;color:#245b31;font-size:11px;font-weight:700}
      .krista-task-ownerbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 12px;padding:9px 10px;border:1px solid #e4e0d8;background:#faf9f6;border-radius:10px}.krista-task-ownerbar label{margin:0;font-size:12px;font-weight:800;color:#555}.krista-task-ownerbar select{width:auto;min-width:220px;padding:7px 9px;background:#fff}.krista-task-ownerbar .krista-task-userhint{margin-left:auto;font-size:11px;color:#777}
      #tCreatorName[readonly]{background:#f3f2ee;color:#444}
      @media(max-width:760px){.krista-user-context{align-items:flex-start}.krista-user-context .krista-user-static{text-align:left}.krista-task-ownerbar select{width:100%;min-width:0}.krista-task-ownerbar .krista-task-userhint{width:100%;margin-left:0}}
    `;document.head.appendChild(s);
  }

  function ensureUserPicker(){
    let bg=document.getElementById("kristaUserPickBg");if(bg)return bg;
    bg=document.createElement("div");bg.id="kristaUserPickBg";bg.className="krista-user-pick-bg";
    bg.innerHTML=`<div class="krista-user-pick"><h3>👤 Wer arbeitet gerade mit KRISTINE?</h3><div class="small">Damit werden persönliche Aufgaben, „Von“-Felder und Berechtigungen automatisch richtig gesetzt.</div><select id="kristaUserPickSelect"></select><label class="krista-user-remember"><input id="kristaUserRemember" type="checkbox" checked><span><strong>Auf diesem Gerät merken</strong><small>Beim nächsten Einstieg wird dieser Benutzer automatisch verwendet. Ohne Häkchen gilt die Auswahl nur für diese Browser-Sitzung.</small></span></label><div class="krista-user-lockhint">🔒 Nach der Zuordnung kann nur Alexander den Benutzer auf diesem Gerät ändern.</div><div class="krista-user-pick-actions"><button type="button" class="secondary" data-user-cancel>Abbrechen</button><button type="button" class="green" data-user-save>Übernehmen</button></div></div>`;
    document.body.appendChild(bg);
    bg.addEventListener("click",e=>{if((e.target===bg||e.target.closest("[data-user-cancel]"))&&current())bg.classList.remove("open")});
    bg.querySelector("[data-user-save]").onclick=()=>{
      const id=bg.querySelector("#kristaUserPickSelect")?.value;
      if(!id){alert("Bitte einen Benutzer auswählen.");return}
      const remember=bg.querySelector("#kristaUserRemember")?.checked!==false;
      if(setCurrentUser(id,{remember}))bg.classList.remove("open");
    };
    return bg;
  }

  function openUserPicker(){
    if(current()&&!canChangeIdentity()){
      alert("Die Benutzerzuordnung ist auf diesem Gerät gesperrt. Nur Alexander kann sie ändern.");
      return;
    }
    const bg=ensureUserPicker();const select=bg.querySelector("#kristaUserPickSelect");
    select.innerHTML='<option value="">– Benutzer auswählen –</option>'+employees().sort((a,b)=>employeeName(a).localeCompare(employeeName(b),"de")).map(e=>`<option value="${esc(employeeId(e))}" ${employeeId(e)===currentId()?"selected":""}>${esc(employeeName(e))}</option>`).join("");
    const remember=bg.querySelector("#kristaUserRemember");if(remember)remember.checked=rememberMode()!=="session";
    const cancel=bg.querySelector("[data-user-cancel]");if(cancel)cancel.hidden=!current();
    bg.classList.add("open");
  }

  function renderIdentity(){
    const host=document.querySelector(".krista-user");if(!host)return;
    host.classList.add("krista-user-context");
    if(!current()){
      host.innerHTML='<button type="button"><strong>Benutzer wählen</strong></button><small>noch nicht zugeordnet</small>';
      host.querySelector("button").onclick=openUserPicker;
      return;
    }
    const label=roleFor(current())==="admin"?"Chef / Admin":(rememberMode()==="device"?"🔒 Gerät zugeordnet":"Browser-Sitzung");
    if(canChangeIdentity()){
      host.innerHTML=`<button type="button" title="Benutzerzuordnung ändern"><strong>${esc(currentName())}</strong></button><small>${esc(label)}</small>`;
      host.querySelector("button").onclick=openUserPicker;
    }else{
      host.innerHTML=`<span class="krista-user-static"><strong>${esc(currentName())}</strong><small>${esc(label)}</small></span>`;
    }
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
    const renderKey=[currentId(),view,can("financeApproval")?"1":"0",...people.map(e=>employeeId(e)+":"+employeeName(e))].join("|");
    if(bar.dataset.renderKey===renderKey){const select=bar.querySelector("select");if(select&&select.value!==view)select.value=view;return}
    bar.dataset.renderKey=renderKey;
    bar.innerHTML=`<label for="kristaTaskOwnerFilter">Anzeigen</label><select id="kristaTaskOwnerFilter"><option value="me" ${view==="me"?"selected":""}>Meine Aufgaben · ${esc(currentName())}</option>${people.map(e=>`<option value="${esc(employeeId(e))}" ${view===employeeId(e)?"selected":""}>${esc(employeeName(e))}</option>`).join("")}<option value="all" ${view==="all"?"selected":""}>Alle Aufgaben</option></select><span class="krista-task-userhint">Angemeldet: ${esc(currentName())}</span>`;
    bar.querySelector("select").onchange=e=>{localStorage.setItem(TASK_VIEW_KEY,e.target.value||"me");bar.dataset.renderKey="";if(typeof window.renderTasks==="function")window.renderTasks()};
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
        if(!current()){openUserPicker();return}
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
    if(!currentUserId){
      const resolved=resolveInitialUser();
      if(resolved)setCurrentUser(resolved,{remember:rememberMode()!=="session",force:true});
      else{
        installStyle();renderIdentity();installTaskCreatorHooks();guardFinanceActions();
        if(!promptShown){promptShown=true;setTimeout(openUserPicker,120)}
        return;
      }
    }else if(!current()){
      currentUserId="";sessionStorage.removeItem(SESSION_USER_KEY);localStorage.removeItem(USER_KEY);promptShown=false;return refresh();
    }
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

  window.KristaUser={current,currentId,currentName,role:()=>roleFor(current()),can,canChangeIdentity,setCurrentUser,openUserPicker,taskVisible,rememberMode,version:VERSION};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
