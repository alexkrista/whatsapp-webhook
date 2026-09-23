"use strict";

(function(){
  const VERSION="2026-09-23-personal-login1";
  const USER_KEY="kristaCurrentUserIdV2";
  const SESSION_USER_KEY="kristaCurrentSessionUserIdV2";
  const TASK_VIEW_KEY="kristaTaskOwnerView";
  let currentUserId="";
  let pendingTaskCreation=null;
  let booted=false;
  let promptShown=false;
  let accessSnapshot=null;
  let accessLoadedAt=0;
  let sessionActor=null;
  let sessionLoadedAt=0;
  let actorHeaderInstalled=false;
  const pageVisitId=(window.crypto?.randomUUID?.()||`visit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const entrySentFor=new Set();

  const norm=v=>String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
  const employeeId=e=>String(e?.id||e?.employeeId||"").trim();
  const employeeName=e=>String(e?.nickname||e?.rufname||e?.name||e?.employeeName||employeeId(e)||"Benutzer").trim();

  function employees(){
    try{
      const localRows=typeof masterEmployees!=="undefined"&&Array.isArray(masterEmployees)?masterEmployees:(typeof data!=="undefined"&&Array.isArray(data?.employees)?data.employees:[]);
      const rows=[...(localRows.length?localRows:(Array.isArray(accessSnapshot?.users)?accessSnapshot.users.map(row=>({id:row.employeeId,name:row.employeeName,employeeName:row.employeeName,active:true,userRole:row.role})):[]))];
      if(sessionActor&&!rows.some(e=>employeeId(e)===sessionActor.id))rows.push({id:sessionActor.id,name:sessionActor.name,active:true});
      return rows.filter(e=>e&&e.active!==false&&employeeId(e));
    }catch{return []}
  }

  function findEmployee(id){return employees().find(e=>employeeId(e)===String(id||""))||null}
  function isAlexander(e){
    const text=norm([e?.nickname,e?.rufname,e?.firstName,e?.vorname,e?.name,e?.employeeName].filter(Boolean).join(" "));
    return /(^| )(alex|alexander)( |$)/.test(text)&&(/krista/.test(text)||text==="alex"||text==="alexander");
  }
  function accessRow(e){
    const id=employeeId(e);if(!id)return null;
    return accessSnapshot?.users?.find(row=>String(row.employeeId)===id)||null;
  }
  function roleFor(e){
    if(sessionActor?.id===employeeId(e))return sessionActor.role;
    const row=accessRow(e);if(row?.role)return String(row.role);
    const explicit=String(e?.userRole||e?.accessRole||e?.role||"").trim().toLowerCase();
    if(explicit)return explicit;
    return isAlexander(e)?"admin":"user";
  }
  function current(){return findEmployee(currentUserId)||null}
  function currentId(){return employeeId(current())||currentUserId||""}
  function currentName(){return current()?employeeName(current()):""}
  function can(permission){
    const e=current();
    if(!e)return false;
    if(sessionActor?.id===employeeId(e))return permission==="admin"?sessionActor.role==="admin":sessionActor.permissions?.[permission]===true;
    const row=accessRow(e);
    if(row?.permissions&&typeof row.permissions[permission]==="boolean")return row.permissions[permission];
    if(permission==="financeApproval"||permission==="userAdmin")return isAlexander(e);
    if(permission==="admin")return isAlexander(e)||roleFor(e)==="admin";
    if(permission==="taskViewAll"||permission==="taskCreate")return true;
    return false;
  }
  function canChangeIdentity(){return false}

  async function loadIdentity(force=false){
    if(!force&&Date.now()-sessionLoadedAt<15000)return sessionActor;
    try{
      const response=await fetch('/auth/me',{cache:'no-store'});
      const payload=await response.json();
      sessionActor=response.ok&&payload?.user?payload.user:null;
      currentUserId=sessionActor?.id||"";
    }catch{sessionActor=null;currentUserId=""}
    sessionLoadedAt=Date.now();
    return sessionActor;
  }

  function tokenUrl(path){
    const url=new URL(path,location.origin);
    const token=new URLSearchParams(location.search).get("token");
    if(token&&url.origin===location.origin)url.searchParams.set("token",token);
    return url.pathname+url.search+url.hash;
  }

  async function loadAccess(force=false){
    if(!force&&accessSnapshot&&Date.now()-accessLoadedAt<15000)return accessSnapshot;
    try{
      const response=await fetch(tokenUrl("/kristine/api/user-access"),{headers:currentId()?{"X-Krista-User-Id":currentId()}:undefined});
      if(!response.ok)return accessSnapshot;
      const json=await response.json();
      if(json?.ok){accessSnapshot=json;accessLoadedAt=Date.now()}
    }catch{}
    return accessSnapshot;
  }

  function installActorHeader(){
    if(actorHeaderInstalled)return;actorHeaderInstalled=true;
    const originalFetch=window.fetch.bind(window);
    window.fetch=function(input,init={}){
      try{
        const url=new URL(typeof input==="string"?input:input?.url||"",location.href);
        const method=String(init?.method||input?.method||"GET").toUpperCase();
        const internalApi=url.pathname.startsWith("/kristine/api/")||url.pathname.startsWith("/admin/api/")||url.pathname.startsWith("/kristool/api/")||url.pathname.startsWith("/api/");
        if(url.origin===location.origin&&["POST","PUT","PATCH","DELETE"].includes(method)&&internalApi&&currentId()){
          const headers=new Headers(init.headers||input?.headers||{});
          headers.set("X-Krista-User-Id",currentId());
          init={...init,headers};
        }
      }catch{}
      return originalFetch(input,init);
    };
  }

  async function recordEntry(){
    const id=currentId();
    if(!id||entrySentFor.has(id))return;
    entrySentFor.add(id);
    try{
      await fetch(tokenUrl("/kristine/api/activity/session"),{method:"POST",headers:{"Content-Type":"application/json","X-Krista-User-Id":id},body:JSON.stringify({page:location.pathname+location.hash,title:document.title,sessionId:pageVisitId})});
    }catch{}
  }

  function resolveInitialUser(){
    return sessionActor?.id||"";
  }

  function rememberMode(){
    return sessionActor?"device":"none";
  }

  function setCurrentUser(id,{remember=true,force=false}={}){
    if(!sessionActor||sessionActor.id!==String(id))return false;
    const e=findEmployee(id);if(!e)return false;
    if(current()&&employeeId(current())!==employeeId(e)&&!force&&!canChangeIdentity()){
      alert("Der Benutzer ist auf diesem Gerät gesperrt. Nur Alexander kann die Zuordnung ändern.");
      return false;
    }
    const changed=currentUserId!==employeeId(e);
    currentUserId=employeeId(e);
    localStorage.removeItem(USER_KEY);sessionStorage.removeItem(SESSION_USER_KEY);
    if(changed)localStorage.setItem(TASK_VIEW_KEY,"me");
    updateCreatorField();renderIdentity();ensureTaskViewFilter();
    void recordEntry();
    if(changed){
      window.dispatchEvent(new CustomEvent("krista:userchange",{detail:{id:currentUserId,name:employeeName(e),role:roleFor(e),remember:remember?"device":"session"}}));
      if(typeof window.renderTasks==="function")setTimeout(()=>window.renderTasks(),0);
    }
    return true;
  }

  function updateCreatorField(){
    const field=document.getElementById("tCreatorName");if(!field)return;
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
      .krista-task-ownerbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 12px;padding:9px 10px;border:1px solid #e4e0d8;background:#faf9f6;border-radius:10px}.krista-task-ownerbar label{margin:0;font-size:12px;font-weight:800;color:#555}.krista-task-ownerbar select{width:auto;min-width:220px;padding:7px 9px;background:#fff}.krista-task-ownerbar .krista-task-userhint{margin-left:auto;font-size:11px;color:#777}#tCreatorName[readonly]{background:#f3f2ee;color:#444}
      @media(max-width:760px){.krista-user-context{align-items:flex-start}.krista-user-context .krista-user-static{text-align:left}.krista-task-ownerbar select{width:100%;min-width:0}.krista-task-ownerbar .krista-task-userhint{width:100%;margin-left:0}}
    `;document.head.appendChild(s);
  }

  function openUserPicker(){
    const u=new URL(location.href);u.searchParams.delete('token');
    location.href='/anmelden?return='+encodeURIComponent(u.pathname+u.search+u.hash);
  }

  function renderIdentity(){
    const host=document.querySelector(".krista-user");if(!host)return;
    const mobileLink=document.getElementById('kristaLoginLink');
    if(mobileLink){
      mobileLink.href='/anmelden';mobileLink.onclick=null;
      mobileLink.querySelector('span:last-child').textContent=current()?`Abmelden · ${currentName()}`:'Anmelden';
      if(current())mobileLink.onclick=async e=>{e.preventDefault();await fetch('/auth/logout',{method:'POST'});location.href='/anmelden'};
    }
    host.classList.add("krista-user-context");
    if(!current()){
      host.innerHTML='<button type="button"><strong>Anmelden</strong></button><small>persönlicher Zugang</small>';
      host.querySelector("button").onclick=openUserPicker;return;
    }
    const role=roleFor(current());
    const label=role==="admin"?"Chef / Admin":role==="office"?"Büro":"Benutzer";
    host.innerHTML=`<span class="krista-user-static"><strong>${esc(currentName())}</strong><small>${esc(label)}</small></span><button type="button" title="Von diesem Gerät abmelden">Abmelden</button>`;
    host.querySelector("button").onclick=async()=>{await fetch('/auth/logout',{method:'POST'});location.href='/anmelden'};
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
    let view=taskView();
    if(!can("taskViewAll")&&view!=="me")view="me";
    if(view==="all")return true;
    const id=view==="me"?currentId():view;
    return id?taskMatchesUser(task,id):true;
  }

  function ensureTaskViewFilter(){
    const card=document.querySelector("#tasks .task-list-card");if(!card||!current())return;
    let bar=card.querySelector(".krista-task-ownerbar");
    if(!bar){bar=document.createElement("div");bar.className="krista-task-ownerbar";const tabs=card.querySelector(".task-tabs");if(tabs)tabs.insertAdjacentElement("afterend",bar);else card.insertBefore(bar,card.querySelector("#taskList"))}
    let view=taskView();if(!can("taskViewAll")&&view!=="me"){view="me";localStorage.setItem(TASK_VIEW_KEY,"me")}
    const people=employees().sort((a,b)=>employeeName(a).localeCompare(employeeName(b),"de"));
    const renderKey=[currentId(),view,can("financeApproval")?"1":"0",can("taskViewAll")?"1":"0",...people.map(e=>employeeId(e)+":"+employeeName(e))].join("|");
    if(bar.dataset.renderKey===renderKey){const select=bar.querySelector("select");if(select&&select.value!==view)select.value=view;return}
    bar.dataset.renderKey=renderKey;
    const extra=can("taskViewAll")?people.map(e=>`<option value="${esc(employeeId(e))}" ${view===employeeId(e)?"selected":""}>${esc(employeeName(e))}</option>`).join("")+`<option value="all" ${view==="all"?"selected":""}>Alle Aufgaben</option>`:"";
    bar.innerHTML=`<label for="kristaTaskOwnerFilter">Anzeigen</label><select id="kristaTaskOwnerFilter"><option value="me" ${view==="me"?"selected":""}>Meine Aufgaben · ${esc(currentName())}</option>${extra}</select><span class="krista-task-userhint">Angemeldet: ${esc(currentName())}</span>`;
    bar.querySelector("select").onchange=e=>{localStorage.setItem(TASK_VIEW_KEY,e.target.value||"me");bar.dataset.renderKey="";if(typeof window.renderTasks==="function")window.renderTasks()};
  }

  function installRenderScope(){
    const fn=window.renderTasks;if(typeof fn!=="function"||fn.__kristaUserScope)return;
    const wrapped=function(){let originalTasks=null;try{if(typeof data!=="undefined"&&Array.isArray(data.tasks)){originalTasks=data.tasks;data.tasks=originalTasks.filter(taskVisible)}return fn.apply(this,arguments)}finally{if(originalTasks)data.tasks=originalTasks;setTimeout(ensureTaskViewFilter,0)}};
    for(const key of ["__kristaCompact","__kristaFinanceApproval","__kristaBeulen"])if(fn[key])wrapped[key]=fn[key];
    wrapped.__kristaUserScope=true;window.renderTasks=wrapped;
  }

  function installModalScope(){
    const fn=window.openTaskListModal;if(typeof fn!=="function"||fn.__kristaUserScope)return;
    const wrapped=function(focusId=""){
      if(focusId){const task=(typeof data!=="undefined"&&Array.isArray(data.tasks))?data.tasks.find(t=>String(t.id)===String(focusId)):null;if(task&&!taskVisible(task)){alert("Diese Aufgabe ist für diesen Benutzer nicht freigegeben.");return}}
      let originalTasks=null;try{if(!focusId&&typeof data!=="undefined"&&Array.isArray(data.tasks)){originalTasks=data.tasks;data.tasks=originalTasks.filter(taskVisible)}return fn.apply(this,arguments)}finally{if(originalTasks)data.tasks=originalTasks}
    };
    wrapped.__kristaUserScope=true;window.openTaskListModal=wrapped;
  }

  function installTaskCreatorHooks(){
    if(typeof window.persistTasks==="function"&&!window.persistTasks.__kristaUserCreator){
      const originalPersist=window.persistTasks;
      const wrappedPersist=function(){
        if(pendingTaskCreation&&typeof data!=="undefined"&&Array.isArray(data.tasks))for(const task of data.tasks)if(!pendingTaskCreation.before.has(String(task.id||""))){task.creatorId=pendingTaskCreation.id||task.creatorId||"admin";task.creatorName=pendingTaskCreation.name||task.creatorName||"Chef / Büro"}
        return originalPersist.apply(this,arguments);
      };
      wrappedPersist.__kristaUserCreator=true;window.persistTasks=wrappedPersist;
    }
    if(typeof window.addTask==="function"&&!window.addTask.__kristaUserCreator){
      const originalAdd=window.addTask;
      const wrappedAdd=async function(){
        if(!current()){openUserPicker();return}
        if(!can("taskCreate")){alert("Für diesen Benutzer ist das Anlegen von Aufgaben nicht freigeschaltet.");return}
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

  async function refresh(){
    await loadIdentity(false);
    await loadAccess(false);
    if(!sessionActor){installStyle();renderIdentity();return}
    if(!employees().length)return;
    installStyle();renderIdentity();updateCreatorField();ensureTaskViewFilter();installRenderScope();installModalScope();installTaskCreatorHooks();guardFinanceActions();
    void recordEntry();
  }

  function boot(){
    if(booted)return;booted=true;
    installStyle();installActorHeader();
    setInterval(refresh,1200);
    window.addEventListener("hashchange",()=>setTimeout(refresh,0));
    window.addEventListener("krista:userchange",()=>{accessLoadedAt=0;setTimeout(refresh,0)});
    setTimeout(refresh,0);setTimeout(refresh,400);setTimeout(refresh,1200);
    console.info("KRISTINE Benutzerkontext",VERSION);
  }

  window.KristaUser={current,currentId,currentName,role:()=>roleFor(current()),can,canChangeIdentity,setCurrentUser,openUserPicker,taskVisible,rememberMode,reloadAccess:()=>loadAccess(true),version:VERSION};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
