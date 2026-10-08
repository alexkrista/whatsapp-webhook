"use strict";
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,32);
const phone=value=>String(value||'').replace(/\D/g,'');
async function json(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
async function lines(file){try{return (await fs.readFile(file,'utf8')).split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})}catch(e){if(e.code==='ENOENT')return [];throw e}}
function localStamp(at){const d=new Date(at);if(!Number.isFinite(d.getTime()))return {date:'',at:''};const parts=Object.fromEntries(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Vienna',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,at:`${parts.hour}:${parts.minute}`}}
async function collectMessages(dataDir){
 const root=path.join(dataDir,'_kristine'),employees=await json(path.join(root,'employees.json'),[]),items=new Map();
 const sender=row=>{const number=phone(row.from);const employee=employees.find(e=>number&&phone(e.phone)===number);return {employeeId:row.employeeId||employee?.id||number||'unknown',employeeName:row.employeeName||employee?.name||(number?'WhatsApp · '+number:'Absender offen')}};
 const put=item=>items.set(item.file,item);
 for(const row of await lines(path.join(root,'events.jsonl'))){if(row.type!=='employee_message'||!String(row.detail||'').trim())continue;const file='message:'+hash(JSON.stringify([row.at,String(row.employeeId||'unknown'),row.detail]));put({...sender(row),...localStamp(row.at),date:row.date||localStamp(row.at).date,file,category:'text',content:String(row.detail),originalJobId:row.jobId||'',previousJobId:row.jobId||'',createdAt:row.at,source:'Mitarbeiternachricht'})}
 const states=await json(path.join(root,'states.json'),{});
 for(const [employeeId,state] of Object.entries(states))for(const row of state.timeline||[]){
  if(row.type!=='message'||!String(row.detail||'').trim())continue;
  const id=state.employeeId||employeeId,file='message:'+hash(JSON.stringify([row.at,String(id),row.detail]));
  if(items.has(file))continue;
  put({...localStamp(row.at),employeeId:id,employeeName:state.employeeName||employees.find(e=>String(e.id)===String(id))?.name||'Mitarbeiter',file,category:'text',content:String(row.detail),originalJobId:row.jobId||'',previousJobId:row.jobId||'',createdAt:row.at,source:'Mitarbeiterverlauf'});
 }
 async function walk(dir,jobId,depth){
  for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})){
   const full=path.join(dir,entry.name);if(entry.isDirectory()&&depth<3)await walk(full,jobId,depth+1);
   if(!entry.isFile()||entry.name!=='log.jsonl')continue;
   const logs=await lines(full),audio=new Map();
   for(const row of logs){
    if(['audio_saved','audio_transcript','transcription_failed'].includes(row.type)&&row.file&&path.basename(row.file)===row.file){const relative=path.relative(dataDir,path.join(dir,row.file)).split(path.sep).join('/'),previous=audio.get(relative)||{};audio.set(relative,{...previous,...row,at:previous.at||row.at,from:previous.from||row.from,transcript:row.transcript||previous.transcript||'',error:row.error||previous.error||''});}
    if(row.type==='text'&&String(row.text||'').trim()){const file='message:'+hash(JSON.stringify([path.relative(dataDir,full),row.raw?.id||row.at,row.from,row.text]));put({...sender(row),...localStamp(row.at),file,category:'text',content:String(row.text),originalJobId:jobId==='unknown'?'':jobId,createdAt:row.at,source:'WhatsApp-Protokoll'})}
   }
   for(const [file,row] of audio){const exists=(await fs.stat(path.join(dataDir,file)).catch(()=>null))?.isFile();put({...sender(row),...localStamp(row.at),file,category:'audio',content:row.transcript||'',transcriptionError:row.error||'',missingAudio:!exists,originalJobId:jobId,previousJobId:jobId==='unknown'?'':jobId,createdAt:row.at,source:'WhatsApp-Sprachnachricht'})}
  }
 }
 for(const entry of await fs.readdir(dataDir,{withFileTypes:true}))if(entry.isDirectory()&&/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name))await walk(path.join(dataDir,entry.name),entry.name,0);
 const tasks=await json(path.join(root,'tasks.json'),[]);
 const recordings=path.join(root,'visit-recordings');
 for(const dir of await fs.readdir(recordings,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})){if(!dir.isDirectory())continue;for(const name of await fs.readdir(path.join(recordings,dir.name))){if(!name.endsWith('.json'))continue;const row=await json(path.join(recordings,dir.name,name),null);if(!row?.id||!/^visit-[\w-]+$/.test(row.id))continue;const task=tasks.find(t=>t.id===dir.name),file=`_kristine/visit-recordings/${dir.name}/${row.id}.webm`;put({...localStamp(row.recordedAt),file,category:'audio',content:row.transcript||'',transcriptionError:row.transcriptionError||'',missingAudio:!(await fs.stat(path.join(dataDir,file)).catch(()=>null))?.isFile(),employeeId:task?.assigneeId||'admin',employeeName:task?.assigneeName||'Büro',originalJobId:task?.jobId||'',previousJobId:task?.jobId||'',createdAt:row.recordedAt,source:row.kind==='own_memo'?'Gesprochene Notiz':'Gesprächsaufnahme',taskId:dir.name})}}
 return [...items.values()];
}
module.exports={collectMessages,localStamp};
