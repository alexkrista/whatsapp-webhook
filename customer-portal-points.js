"use strict";

const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const text=(value,max=5000)=>String(value||"").trim().slice(0,max);
const status=task=>task?.status==="done"?"done":"open";
const timestamp=value=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const read=file=>JSON.parse(fs.readFileSync(file,"utf8"));
const write=(file,value)=>{const tmp=file+"."+crypto.randomUUID()+".tmp";try{fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}};

function pointTitle(row){return text(row.title,140)||text(String(row.text||"").split(/\r?\n/)[0],100)||text(row.area,140)||"Punkt oder Wunsch";}
function historyRows(row){
  const rows=(Array.isArray(row.history)?row.history:[]).filter(event=>event&&["submitted","status"].includes(event.kind)&&["open","done"].includes(event.status)).map(event=>({kind:event.kind,status:event.status,date:timestamp(event.date)}));
  if(!rows.length||rows[0].kind!=="submitted")rows.unshift({kind:"submitted",status:"open",date:timestamp(row.date)});
  return rows;
}
function customerPointView(row,task){
  const history=historyRows(row),current=status(task);
  if(history.at(-1).status!==current)history.push({kind:"status",status:current,date:current==="done"?timestamp(task?.completedAt):null});
  const responsibility=row.responsibility==="bauherr"?"bauherr":"krista";
  const photos=(Array.isArray(row.photos)?row.photos:[]).filter(photo=>photo&&/^[a-f0-9-]{36}$/.test(photo.id||"")).map(photo=>({id:photo.id,name:text(photo.name,180)||"Foto",type:text(photo.type,80),url:`/kundenportal/api/point-photo/${encodeURIComponent(row.id)}/${encodeURIComponent(photo.id)}`}));
  return {id:row.id,module:row.module,title:pointTitle(row),text:text(row.text),area:text(row.area,140),responsibility,photos,date:timestamp(row.date),status:current,history};
}

// Capture transitions when office tasks are saved, even while the customer is
// offline. Only status and time are public; internal task notes never enter it.
function recordPortalTaskChanges(dataDir,previousTasks,nextTasks,date=new Date().toISOString()){
  const before=new Map(previousTasks.map(task=>[task.id,task]));
  for(const task of nextTasks){
    const match=String(task.id||"").match(/^customer_([a-f0-9-]{36})$/);if(!match)continue;
    const outbox=path.join(dataDir,"_kristine/customer-portal-tasks",match[1]+".json");
    if(!fs.existsSync(outbox))continue;
    const original=read(outbox);if(original.id!==task.id||!/^[A-Za-z0-9_-]{1,80}$/.test(original.jobId||""))continue;
    const file=path.join(dataDir,original.jobId,"_customer-portal",match[1]+".json");
    if(!fs.existsSync(file))continue;
    const row=read(file);if(row.id!==match[1]||row.taskId!==task.id)continue;
    const previous=before.get(task.id)||original,history=customerPointView(row,previous).history,current=status(task);
    if(history.at(-1).status!==current)history.push({kind:"status",status:current,date:timestamp(date)});
    if(JSON.stringify(row.history)!==JSON.stringify(history))write(file,{...row,history});
    // A stale bulk save omitting this task must not reopen a completed point.
    if(status(original)!==current||original.completedAt!==task.completedAt)write(outbox,{...original,status:current,completedAt:current==="done"?(timestamp(task.completedAt)||timestamp(date)):null});
  }
}

module.exports={pointTitle,customerPointView,recordPortalTaskChanges};
