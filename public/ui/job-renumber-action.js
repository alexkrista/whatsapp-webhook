"use strict";
(function(){
 const token=new URLSearchParams(location.search).get("token")||"";
 const url=p=>{const u=new URL(p,location.origin);if(token)u.searchParams.set("token",token);return u.pathname+u.search};
 async function api(p,options={}){const r=await fetch(url(p),options),d=await r.json();if(!r.ok||d.ok===false)throw Error(d.error||"Nummer konnte nicht geändert werden.");return d}
 let busy=false;
 async function open(job){
  if(busy)return;busy=true;
  try{
   let suggested="";try{suggested=String((await api("/admin/api/jobs/next-number")).nextNumber||"")}catch{}
   const value=prompt("Baustellennummer ändern: "+job.jobId+" · "+job.name+"\nNeue Nummer (wird in KRISTINE, WinWorker und Rechnungsbuch geprüft):",suggested);
   if(value===null)return;
   const newJobId=value.trim();if(!/^\d{5}$/.test(newJobId)||newJobId===String(job.jobId))throw Error("Bitte eine andere fünfstellige Nummer eingeben.");
   if(!confirm(job.name+": Nummer "+job.jobId+" → "+newJobId+" ändern?\nStunden, Berichte, Planung und Dateien werden mitgeführt. Eine belegte Zielnummer wird abgelehnt."))return;
   const result=await api("/admin/api/job/"+encodeURIComponent(job.jobId)+"/safe-renumber",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({newJobId,expectedName:job.name})});
   location.href=url("/kristine/baustellen")+"#"+encodeURIComponent(result.newJobId);location.reload();
  }catch(error){alert("Nummer unverändert: "+error.message)}finally{busy=false}
 }
 window.KristaJobRenumber={open};
})();
