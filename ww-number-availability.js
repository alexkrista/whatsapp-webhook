"use strict";
// Server-side WinWorker number availability. Never treat a failed lookup as "free".
// WW_PROJECT_SEARCH_BASE must be a server-reachable, trusted Brain origin.
function createNumberChecker({baseUrl, fetchImpl=globalThis.fetch, timeoutMs=4000}={}) {
  const root=String(baseUrl||"").replace(/\/$/,"");
  return async function check(number) {
    const value=String(number||"").trim();
    if(!/^\d{5}$/.test(value)) return {ok:false,error:"Ungültige fünfstellige Projektnummer."};
    if(!root) return {ok:false,error:"WinWorker-Nummernprüfung nicht konfiguriert."};
    try {
      const url=new URL("/project/search",root);
      url.searchParams.set("q",value);
      url.searchParams.set("limit","250");
      const response=await fetchImpl(url.toString(),{headers:{Accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok) throw new Error("HTTP "+response.status);
      const json=await response.json();
      if(json?.ok!==true||!Array.isArray(json.projects)) throw new Error("Ungültige Antwort");
      // A truncated fuzzy search must never be interpreted as definitive absence.
      if(json.projects.length>=250 || Number(json.count||0)>json.projects.length) {
        return {ok:false,error:"WinWorker-Suche möglicherweise unvollständig."};
      }
      const matches=json.projects.filter(row=>String(row?.projectNumber||"").trim()===value);
      return {ok:true,available:matches.length===0,matches:matches.map(row=>({projectNumber:value,projectIndex:row.projectIndex||null,name:row.company||row.customer||row.title||""}))};
    } catch(e){return {ok:false,error:"WinWorker-Prüfung nicht erreichbar: "+String(e?.message||e)};}
  };
}
module.exports={createNumberChecker};
