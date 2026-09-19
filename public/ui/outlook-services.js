"use strict";
(function(){
  let status=null,pending=null,checkedAt=0,connecting=false;
  async function api(path,body){
    const url=new URL(path,location.origin),token=new URLSearchParams(location.search).get("token");
    if(token)url.searchParams.set("token",token);
    const response=await fetch(url.pathname+url.search,{method:body?"POST":"GET",credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(15000),...(body?{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok||data.ok===false)throw new Error(data.error||"Outlook ist nicht erreichbar.");return data;
  }
  async function refresh(force=false){
    if(pending)return pending;
    if(!force&&status&&Date.now()-checkedAt<30000)return status;
    pending=api("/kristine/api/outlook/status"+(force?"?refresh=1":"")).catch(()=>({connected:false,status:"unavailable",error:"Outlook-Status nicht erreichbar."})).then(value=>{
      status=value;checkedAt=Date.now();window.dispatchEvent(new CustomEvent("krista:outlook-status",{detail:value}));return value;
    }).finally(()=>{pending=null});return pending;
  }
  function row(){
    const state=status?.status||(status?.connected?"connected":"unavailable");
    const labels={connected:"Verbunden",not_connected:"Nicht verbunden",expired:"Anmeldung abgelaufen",unavailable:"Prüfung nicht möglich"};
    return {id:"outlook",name:"Outlook-Anmeldung",icon:"📅",level:state==="connected"?"green":state==="unavailable"?"yellow":"red",status:labels[state]||labels.unavailable,detail:status?.account||status?.expectedAccount||"Microsoft Kalender",lastError:status?.error||"",canConnect:!status?.connected,connecting};
  }
  async function connect(host){
    if(connecting)return;
    connecting=true;const popup=window.open("about:blank","_blank");let opened=false;if(popup)popup.opener=null;
    host.textContent="Microsoft-Anmeldung wird geöffnet …";
    try{
      const start=await api("/kristine/api/outlook/login/start",{}),uri=new URL(start.verificationUri);
      if(uri.protocol!=="https:"||!["microsoft.com","www.microsoft.com","login.microsoft.com","login.microsoftonline.com"].includes(uri.hostname))throw new Error("Ungültige Microsoft-Anmeldeadresse.");
      if(popup){popup.location.href=uri.href;opened=true;}
      host.textContent="Microsoft-Code: ";const code=document.createElement("strong");code.textContent=start.userCode;host.append(code,document.createElement("br"));
      const link=document.createElement("a");link.href=uri.href;link.target="_blank";link.rel="noopener noreferrer";link.textContent="Microsoft-Anmeldung öffnen";host.append(link,document.createElement("br"),"Als alexander.krista@krista.at anmelden. Der Status aktualisiert sich automatisch.");
      const deadline=Date.now()+Math.max(60,Number(start.expiresIn)||900)*1000;let interval=Math.max(5,Number(start.interval)||5);
      while(Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,interval*1000));
        const result=await api("/kristine/api/outlook/login/poll",{sessionId:start.sessionId});
        if(result.status==="connected"){
          const verified=await refresh(true);host.textContent=verified.connected?"✓ Outlook ist verbunden.":"Anmeldung abgeschlossen. Outlook-Verbindung wird geprüft …";
          window.KrisadminServices?.load();return;
        }
        interval=Math.max(interval,Number(result.retryAfter)||0);
      }
      throw new Error("Der Anmeldecode ist abgelaufen. Bitte erneut verbinden.");
    }catch(error){if(popup&&!opened)popup.close();host.textContent=error.message||"Anmeldung fehlgeschlagen. Bitte erneut versuchen.";}
    finally{connecting=false;window.dispatchEvent(new CustomEvent("krista:outlook-status",{detail:status}));}
  }
  window.KristaOutlookServices={refresh,row,connect,get status(){return status}};
})();
