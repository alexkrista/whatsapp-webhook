'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const queues=new Map();
function cleanRows(rows){
 if(!Array.isArray(rows)||rows.length>500)throw Error('Bitte höchstens 500 Farbkonzept-Zeilen speichern.');
 const ids=new Set();return rows.flatMap(row=>{
  if(!row||typeof row!=='object')throw Error('Ungültige Farbkonzept-Zeile.');
  const text=(key,max)=>String(row[key]??'').trim().slice(0,max);
  const room=text('room',180),floor=text('floor',60),surface=text('surface',30),color=text('color',240),material=text('material',240),rawArea=row.area;
  if(!room&&!floor&&!surface&&!color&&!material&&(rawArea===''||rawArea==null))return [];
  if(!room)throw Error('Bitte für jede Zeile den Raum angeben.');
  if(!['','Wand','Decke','Wand/Decke','Sonstiges'].includes(surface))throw Error('Bitte Wand oder Decke auswählen.');
  let area=null;if(rawArea!==''&&rawArea!=null){area=Number(String(rawArea).replace(',','.'));if(!Number.isFinite(area)||area<0||area>1000000)throw Error('Bitte eine gültige Fläche in m² angeben.');area=Math.round(area*100)/100;}
  const id=text('id',100)||crypto.randomUUID();if(!/^[\w-]+$/.test(id)||ids.has(id))throw Error('Doppelte oder ungültige Zeilen-ID.');ids.add(id);return [{id,room,floor,surface,area,color,material}];
 });
}
function registerProjectColorConcept(app,{dataDir,requireAdmin,appendHistory}){
 async function fileFor(jobId){if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId||'')||!(await fs.stat(path.join(dataDir,jobId)).catch(()=>null))?.isDirectory())throw Error('Baustelle nicht gefunden.');return path.join(dataDir,jobId,'.color-concept.json');}
 async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return {revision:0,rows:[],updatedAt:null};throw e}}
 app.get('/admin/api/job/:jobId/color-concept',async(req,res)=>{if(!requireAdmin(req,res))return;try{res.setHeader('Cache-Control','private, no-store');res.json({ok:true,...await read(await fileFor(String(req.params.jobId||'')))})}catch(e){res.status(400).json({ok:false,error:e.message})}});
 app.put('/admin/api/job/:jobId/color-concept',async(req,res)=>{
  if(!requireAdmin(req,res))return;const jobId=String(req.params.jobId||''),key=path.join(dataDir,jobId);
  const run=(queues.get(key)||Promise.resolve()).then(async()=>{const file=await fileFor(jobId),previous=await read(file);if(req.body?.revision!==previous.revision){const error=Error('Das Farbkonzept wurde inzwischen geändert. Bitte neu laden und deine Änderungen erneut eintragen.');error.status=409;throw error;}
   const rows=cleanRows(req.body?.rows),next={revision:previous.revision+1,rows,updatedAt:new Date().toISOString()},tmp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';await fs.writeFile(tmp,JSON.stringify(next,null,2),'utf8');await fs.rename(tmp,file);if(appendHistory)await appendHistory(jobId,{type:'color_concept_updated',title:'Farbkonzept gespeichert',detail:rows.length+' Raum-/Flächeneinträge',source:'Qualität & Oberfläche'}).catch(console.error);return next;
  });queues.set(key,run.catch(()=>{}));try{res.json({ok:true,...await run})}catch(e){res.status(e.status||400).json({ok:false,error:e.message})}
 });
}
module.exports={cleanRows,registerProjectColorConcept};
