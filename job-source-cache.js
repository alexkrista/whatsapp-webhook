"use strict";

const fs=require("node:fs/promises"),path=require("node:path"),crypto=require("node:crypto");
const {projects}=require("./public/ui/baustellen-data");

function registerJobSourceCache(app,{dataDir,requireAdmin,readJobMeta}){
  async function location(req){
    const jobId=String(req.params.jobId||""),kind=String(req.params.kind||""),projectNumber=String(req.query.projectNumber||"");
    if(!/^[A-Za-z0-9_-]+$/.test(jobId)||!["hours","billing"].includes(kind)||!/^\d{2,12}$/.test(projectNumber))throw Object.assign(new Error("Ungültige Stunden-/Rechnungsquelle."),{status:400});
    await fs.access(path.join(dataDir,jobId));
    const job={...await readJobMeta(jobId),jobId};
    if(!projects(job,[job]).some(row=>row.projectNumber===projectNumber))throw Object.assign(new Error("WinWorker-Akte gehört nicht zu dieser Baustelle."),{status:400});
    return {jobId,kind,projectNumber,file:path.join(dataDir,"_system","ww-cache",kind,`${projectNumber}.json`)};
  }
  app.get("/admin/api/job/:jobId/ww-cache/:kind",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{const info=await location(req);let snapshot=null;try{snapshot=JSON.parse(await fs.readFile(info.file,"utf8"))}catch(error){if(error.code!=="ENOENT")throw error}
      res.setHeader("Cache-Control","no-store");res.json({ok:true,snapshot});
    }catch(error){res.status(error.status||500).json({ok:false,error:error.message})}
  });
  app.put("/admin/api/job/:jobId/ww-cache/:kind",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const info=await location(req),data=req.body?.data;
      if(!data||typeof data!=="object"||String(data.projectNumber||"")!==info.projectNumber||typeof data.found!=="boolean")return res.status(400).json({ok:false,error:"Unvollständiger WinWorker-Stand."});
      const keys=info.kind==="hours"?["rows","days"]:["invoices","payments","runs"];
      if(!keys.every(key=>Array.isArray(data[key])))return res.status(400).json({ok:false,error:"WinWorker-Listen fehlen."});
      const snapshot={projectNumber:info.projectNumber,syncedAt:new Date().toISOString(),data};
      const body=JSON.stringify(snapshot);if(Buffer.byteLength(body)>5*1024*1024)return res.status(413).json({ok:false,error:"WinWorker-Stand ist zu groß."});
      await fs.mkdir(path.dirname(info.file),{recursive:true});const tmp=info.file+"."+crypto.randomUUID()+".tmp";
      try{await fs.writeFile(tmp,body);await fs.rename(tmp,info.file)}finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
      res.json({ok:true,syncedAt:snapshot.syncedAt});
    }catch(error){res.status(error.status||500).json({ok:false,error:error.message})}
  });
}
// Read-only check for the collection reported by the user. No source records
// are rewritten; missing external snapshots are explicitly counted as missing.
async function auditStoredCollection({dataDir,jobId,readJobMeta,readDocumentation}){
  const head={...await readJobMeta(jobId),jobId},ids=[...new Set([jobId,...(head.collectionMemberJobIds||[])])];
  const rows=[];
  for(const id of ids){
    const exists=await fs.stat(path.join(dataDir,id)).then(stat=>stat.isDirectory()).catch(()=>false);
    if(!exists){rows.push({jobId:id,missing:true});continue}
    const meta={...await readJobMeta(id),jobId:id},docs=await readDocumentation(id);
    const hasCalculation=await fs.access(path.join(dataDir,id,".order-calculation.json")).then(()=>true).catch(()=>false);
    rows.push({jobId:id,documents:docs.length,regieReports:docs.filter(doc=>doc.type==="regie_report").length,hasCalculation,wwProjects:projects(meta,[meta]).map(ref=>ref.projectNumber)});
  }
  return {jobId,memberCount:ids.length,missingMembers:rows.filter(row=>row.missing).map(row=>row.jobId),storedRegieReports:rows.reduce((sum,row)=>sum+(row.regieReports||0),0),membersWithCalculation:rows.filter(row=>row.hasCalculation).length,rows};
}
module.exports={registerJobSourceCache,auditStoredCollection};
