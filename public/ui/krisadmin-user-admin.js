"use strict";

(function(){
  const VERSION="2026-08-24-users-1";
  const USER_KEY="kristaCurrentUserId";
  let snapshot=null;

  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
  const token=()=>new URLSearchParams(location.search).get("token")||"";
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token()&&u.origin===location.origin)u.searchParams.set("token",token());return u.pathname+u.search+u.hash};
  const actorId=()=>localStorage.getItem(USER_KEY)||"";

  async function api(path,options={}){
    const headers={...(options.headers||{})};
    if(actorId())headers["X-Krista-User-Id"]=actorId();
    const response=await fetch(tokenUrl(path),{...options,headers});
    const text=await response.text();
    let json=null;try{json=text?JSON.parse(text):null}catch{}
    if(!response.ok)throw new Error(json?.error||text||response.statusText);
    return json;
  }

  function installCss(){
    if(document.getElementById("krisadminUserCss"))return;
    const s=document.createElement("style");s.id="krisadminUserCss";s.textContent=`
      .kau-bg{position:fixed;inset:0;z-index:60020;background:rgba(0,0,0,.52);display:none;place-items:center;padding:18px}.kau-bg.open{display:grid}.kau-modal{width:min(1040px,100%);max-height:92vh;overflow:auto;background:#f7f5ef;border-radius:18px;box-shadow:0 25px 90px rgba(0,0,0,.3);padding:18px}.kau-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.kau-head h2{margin:0}.kau-sub{font-size:12px;color:#707070;margin-top:4px}.kau-list{display:grid;gap:8px;margin-top:15px}.kau-row{display:grid;grid-template-columns:minmax(170px,1.2fr) 150px minmax(0,2.3fr);gap:10px;align-items:center;background:#fff;border:1px solid #dedad1;border-radius:12px;padding:11px}.kau-person strong{display:block}.kau-person small{color:#777}.kau-perms{display:flex;gap:7px 12px;flex-wrap:wrap}.kau-perms label{display:inline-flex;gap:5px;align-items:center;font-size:11px;color:#3e433e;margin:0}.kau-perms input{width:auto}.kau-lock{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#eef4ee;color:#27633b;padding:4px 8px;font-size:10px;font-weight:850}.kau-actions{display:flex;justify-content:flex-end;gap:8px;align-items:center;margin-top:14px}.kau-status{margin-right:auto;font-size:12px;font-weight:750}.kau-status.ok{color:#21602f}.kau-status.error{color:#9d2525}.kau-blocked{padding:18px;border-radius:12px;background:#fff3d6;color:#765300;margin-top:14px}.kau-role{width:100%;padding:8px}.kau-role:disabled{background:#eee;color:#555}@media(max-width:800px){.kau-row{grid-template-columns:1fr}.kau-actions{flex-wrap:wrap}.kau-actions button{flex:1}.kau-status{width:100%}}
    `;document.head.appendChild(s);
  }

  function ensureModal(){
    let bg=document.getElementById("krisadminUserBg");if(bg)return bg;
    bg=document.createElement("div");bg.id="krisadminUserBg";bg.className="kau-bg";
    bg.innerHTML=`<div class="kau-modal"><div class="kau-head"><div><h2>👤 Benutzer & Rechte</h2><div class="kau-sub">Zentrale Benutzerrollen für KRISTINE. Änderungen sind ausschließlich im Alexander-Kontext erlaubt.</div></div><button type="button" class="secondary" data-close>Schließen</button></div><div id="kauContent"></div></div>`;
    document.body.appendChild(bg);
    bg.addEventListener("click",e=>{if(e.target===bg||e.target.closest("[data-close]"))bg.classList.remove("open")});
    return bg;
  }

  function roleLabel(role){return role==="admin"?"Chef / Admin":role==="office"?"Büro":"Benutzer"}
  function currentActor(){return snapshot?.users?.find(u=>String(u.employeeId)===String(actorId()))||null}

  function permissionControl(user,key,label){
    const locked=key==="financeApproval"||key==="userAdmin";
    if(locked)return `<span class="kau-lock">🔒 ${esc(label)}: ${user.permissions?.[key]?"Ja":"Nein"}</span>`;
    return `<label><input type="checkbox" data-perm="${esc(key)}" ${user.permissions?.[key]?"checked":""}>${esc(label)}</label>`;
  }

  function render(){
    const content=document.getElementById("kauContent");if(!content)return;
    const actor=currentActor();
    if(!snapshot){content.innerHTML='<div class="kau-blocked">Lade Benutzer …</div>';return}
    if(!actor?.isAlexander){
      content.innerHTML='<div class="kau-blocked"><strong>Nur Alexander darf Benutzer und Rechte verändern.</strong><br><span class="small">Bitte KRISTINE auf diesem Gerät zuerst im Alexander-Kontext öffnen. Danach hier nochmals aufrufen.</span></div>';
      return;
    }
    content.innerHTML=`<div class="kau-list">${snapshot.users.map(user=>`
      <div class="kau-row" data-user="${esc(user.employeeId)}">
        <div class="kau-person"><strong>${esc(user.employeeName)}</strong><small>${user.isAlexander?'Hauptadministrator · nicht delegierbar':'Mitarbeiter-ID '+esc(user.employeeId)}</small></div>
        <div><label>Rolle</label><select class="kau-role" data-role ${user.isAlexander?'disabled':''}>${user.isAlexander?'<option value="admin">Chef / Admin</option>':'<option value="user" '+(user.role==='user'?'selected':'')+'>Benutzer</option><option value="office" '+(user.role==='office'?'selected':'')+'>Büro</option>'}</select></div>
        <div class="kau-perms">
          ${permissionControl(user,'taskViewAll','Alle Aufgaben ansehen')}
          ${permissionControl(user,'taskCreate','Aufgaben anlegen')}
          ${permissionControl(user,'planningEdit','Planung ändern')}
          ${permissionControl(user,'employeeAdmin','Mitarbeiterdaten ändern')}
          ${permissionControl(user,'brainAccess','The Brain')}
          ${permissionControl(user,'financeApproval','Freigaben')}
          ${permissionControl(user,'userAdmin','Benutzerverwaltung')}
        </div>
      </div>`).join("")}</div><div class="kau-actions"><span id="kauStatus" class="kau-status"></span><button type="button" class="secondary" data-close>Abbrechen</button><button type="button" class="green" id="kauSave">💾 Rechte speichern</button></div>`;
    content.querySelector("#kauSave").onclick=save;
    content.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>document.getElementById("krisadminUserBg")?.classList.remove("open"));
  }

  function collect(){
    return snapshot.users.map(user=>{
      const row=document.querySelector(`.kau-row[data-user="${CSS.escape(String(user.employeeId))}"]`);
      const permissions={...user.permissions};
      row?.querySelectorAll("[data-perm]").forEach(input=>{permissions[input.dataset.perm]=input.checked});
      return {employeeId:user.employeeId,role:user.isAlexander?'admin':(row?.querySelector("[data-role]")?.value||'user'),permissions};
    });
  }

  async function save(){
    const status=document.getElementById("kauStatus"),button=document.getElementById("kauSave");
    if(status){status.textContent="Speichert …";status.className="kau-status"}if(button)button.disabled=true;
    try{
      snapshot=await api("/kristine/api/user-access",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId:actorId(),users:collect()})});
      if(status){status.textContent=`✓ Gespeichert von ${snapshot.updatedBy||'Alexander'}`;status.className="kau-status ok"}
      render();const s=document.getElementById("kauStatus");if(s){s.textContent=`✓ Gespeichert von ${snapshot.updatedBy||'Alexander'}`;s.className="kau-status ok"}
    }catch(error){if(status){status.textContent=error.message||String(error);status.className="kau-status error"}}
    finally{const b=document.getElementById("kauSave");if(b)b.disabled=false}
  }

  async function open(){
    installCss();const bg=ensureModal();bg.classList.add("open");
    document.getElementById("kauContent").innerHTML='<div class="kau-blocked">Lade Benutzer und Rechte …</div>';
    try{snapshot=await api("/kristine/api/user-access");render()}
    catch(error){document.getElementById("kauContent").innerHTML=`<div class="kau-blocked"><strong>Benutzerverwaltung konnte nicht geladen werden.</strong><br>${esc(error.message||error)}</div>`}
  }

  window.openKrisadminUsers=open;
  window.KrisadminUsers={open,version:VERSION};
  installCss();
})();
