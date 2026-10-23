"use strict";
const fs=require("node:fs"),path=require("node:path");
const {checkWwProjectIdentity}=require("./ww-project-identity");
async function verifyRenumber({dataDir,oldJobId,newJobId,expectedName,brainJson}){
 if(!/^\d{5}$/.test(oldJobId)||!/^\d{5}$/.test(newJobId)||oldJobId===newJobId)throw Error("Bitte eine andere fünfstellige Baustellennummer eingeben.");
 const source=path.join(dataDir,oldJobId),stat=fs.lstatSync(source);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("Diese Nummer wurde bereits geändert oder ist keine eigenständige Baustelle.");
 const meta=JSON.parse(fs.readFileSync(path.join(source,".meta.json"),"utf8"));
 if(!expectedName||String(meta.name)!==String(expectedName))throw Error("Baustellendaten haben sich geändert. Bitte neu öffnen.");
 if(Number(meta.wwProjectIndex)>0||(meta.wwProjectLinks||[]).length||(meta.wwProjectNumber&&String(meta.wwProjectNumber)!==oldJobId))throw Error("Explizite WinWorker-Verknüpfung: vor der Nummernänderung prüfen.");
 if(fs.existsSync(path.join(dataDir,newJobId)))throw Error("Zielnummer bereits in KRISTINE vergeben.");
 const [target,sourceWw,targetRuns,sourceRuns]=await Promise.all([
  brainJson("/api/outgoing/project-search?q="+encodeURIComponent(newJobId)),
  brainJson("/api/outgoing/project-search?q="+encodeURIComponent(oldJobId)),
  brainJson("/api/outgoing/runs?projectNumber="+encodeURIComponent(newJobId)),
  brainJson("/api/outgoing/runs?projectNumber="+encodeURIComponent(oldJobId))
 ]);
 if(!Array.isArray(target.projects)||!Array.isArray(sourceWw.projects)||!Array.isArray(targetRuns.runs)||!Array.isArray(sourceRuns.runs))throw Error("WinWorker-/Rechnungsprüfung unvollständig; Nummer bleibt unverändert.");
 if(target.projects.some(p=>String(p.projectNumber).trim()===newJobId)||targetRuns.runs.length)throw Error("Zielnummer bereits in WinWorker oder im Rechnungsbuch vergeben.");
 if(sourceWw.projects.some(p=>String(p.projectNumber).trim()===oldJobId&&checkWwProjectIdentity(p,meta,oldJobId).ok))throw Error("Baustelle gehört zu einem gleichnamigen WinWorker-Projekt. Verknüpfung vor einer Änderung prüfen.");
 if(sourceRuns.runs.some(r=>Number(r.invoiceCount)>0&&String(r.project_title||"").toLowerCase()===String(meta.name).toLowerCase()))throw Error("Für diese Baustelle existieren bereits Rechnungen. Nummernänderung muss mit dem Rechnungsbuch abgestimmt werden.");
 return meta;
}
module.exports={verifyRenumber};
