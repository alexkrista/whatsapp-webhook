"use strict";

const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");

const text=(value,max=5000)=>String(value||"").trim().slice(0,max);
const taskStatus=task=>task?.status==="done"?"done":"open";
const timestamp=value=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const safeId=value=>/^[A-Za-z0-9_-]{1,80}$/.test(String(value||""));
const read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch(error){if(error.code==="ENOENT")return fallback;throw error;}};
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+"."+crypto.randomUUID()+".tmp";try{fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}};
const publicKinds=new Set(["submitted","captured","sent","read","assigned","internal_done","customer_confirmed","customer_reopened","office_reopened","legacy_done","legacy_reopened"]);

function pointTitle(row){return text(row.title,140)||text(String(row.text||"").split(/\r?\n/)[0],100)||text(row.area,140)||"Punkt oder Wunsch";}

function publicEvent(event){
  const row={kind:event.kind,date:timestamp(event.date)};
  if(event.status==="open"||event.status==="done")row.status=event.status;
  if(event.assigneeName)row.assigneeName=text(event.assigneeName,140);
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(event.dueDate||"")))row.dueDate=String(event.dueDate);
  if(event.channel)row.channel=text(event.channel,80);
  if(event.reason)row.reason=event.reason==="confirmation"?"confirmation":"update";
  if(event.comment)row.comment=text(event.comment,1000);
  return row;
}

function historyRows(row){
  const source=Array.isArray(row.history)?row.history:[],rows=[];
  for(const event of source){
    if(!event||typeof event!=="object")continue;
    if(publicKinds.has(event.kind)){rows.push(publicEvent(event));continue;}
    // Compatibility for points written before the customer-confirmation flow.
    if(event.kind==="status"&&event.status==="done")rows.push({kind:"legacy_done",status:"done",date:timestamp(event.date)});
    else if(event.kind==="status"&&event.status==="open")rows.push({kind:"legacy_reopened",status:"open",date:timestamp(event.date)});
  }
  if(!rows.length||!["submitted","captured"].includes(rows[0].kind)){
    rows.unshift({kind:row.source==="office"?"captured":"submitted",status:"open",date:timestamp(row.date)});
  }
  return rows;
}

function pointState(row,task,history=historyRows(row)){
  let state=row.source==="office"?"captured":"received";
  for(const event of history){
    if(event.kind==="sent")state=event.reason==="confirmation"&&state==="awaiting_confirmation"?state:"sent";
    else if(event.kind==="read")state=state==="awaiting_confirmation"?state:"read";
    else if(event.kind==="assigned")state="assigned";
    else if(event.kind==="internal_done")state="awaiting_confirmation";
    else if(event.kind==="customer_confirmed")state="confirmed";
    else if(["customer_reopened","office_reopened","legacy_reopened"].includes(event.kind))state="reopened";
    else if(event.kind==="legacy_done")state="legacy_done";
  }
  if(taskStatus(task)==="done"&&!history.some(event=>["internal_done","customer_confirmed","legacy_done"].includes(event.kind)))state="legacy_done";
  return state;
}

function customerPointView(row,task){
  const history=historyRows(row),state=pointState(row,task,history);
  if(state==="legacy_done"&&!history.some(event=>event.kind==="legacy_done"))history.push({kind:"legacy_done",status:"done",date:timestamp(task?.completedAt)});
  const responsibility=row.responsibility==="bauherr"?"bauherr":"krista";
  const photos=(Array.isArray(row.photos)?row.photos:[]).filter(photo=>photo&&photo.internal!==true&&/^[a-f0-9-]{36}$/.test(photo.id||"")).map(photo=>({id:photo.id,name:text(photo.name,180)||"Foto",type:text(photo.type,80),url:`/kundenportal/api/point-photo/${encodeURIComponent(row.id)}/${encodeURIComponent(photo.id)}`}));
  return {
    id:row.id,
    module:row.module,
    source:row.source==="office"?"office":"customer",
    title:pointTitle(row),
    text:text(row.text),
    area:text(row.area,140),
    responsibility,
    photos,
    date:timestamp(row.date),
    status:taskStatus(task),
    state,
    canConfirm:state==="awaiting_confirmation",
    history,
  };
}

function pointFiles(dataDir,jobId,pointId){
  if(!safeId(jobId)||!/^[a-f0-9-]{36}$/.test(String(pointId||"")))throw new Error("Ungültiger Kundenpunkt.");
  return {
    point:path.join(dataDir,jobId,"_customer-portal",pointId+".json"),
    outbox:path.join(dataDir,"_kristine/customer-portal-tasks",pointId+".json"),
    tasks:path.join(dataDir,"_kristine/tasks.json"),
  };
}

function updatePointAndTask(dataDir,{jobId,pointId,event=null,pointPatch={},taskPatch={}}){
  const files=pointFiles(dataDir,jobId,pointId),row=read(files.point,null);
  if(!row||row.id!==pointId)throw new Error("Kundenpunkt nicht gefunden.");
  const history=historyRows(row);
  if(event)history.push(publicEvent({...event,date:timestamp(event.date)||new Date().toISOString()}));
  const nextRow={...row,...pointPatch,history};
  const originalTask=read(files.outbox,null);
  if(!originalTask||originalTask.id!==row.taskId)throw new Error("Aufgabe zum Kundenpunkt nicht gefunden.");
  const projected=customerPointView(nextRow,{...originalTask,...taskPatch});
  const nextTask={...originalTask,...taskPatch,customerPointId:pointId,customerPointSource:nextRow.source==="office"?"office":"customer",customerPointState:projected.state,customerPointUpdatedAt:event?.date||new Date().toISOString(),customerPointRevision:Math.max(Number(originalTask.customerPointRevision)||0,Number(taskPatch.customerPointRevision)||0)+1};
  write(files.point,nextRow);write(files.outbox,nextTask);
  const tasks=read(files.tasks,null);
  if(Array.isArray(tasks)){
    const index=tasks.findIndex(task=>task?.id===row.taskId);
    if(index>=0){tasks[index]={...tasks[index],...nextTask};write(files.tasks,tasks);}
  }
  return {row:nextRow,task:nextTask,view:customerPointView(nextRow,nextTask)};
}

// Capture transitions when office tasks are saved, even while the customer is
// offline. Only the public lifecycle fields enter the point history; internal
// task notes never do.
function recordPortalTaskChanges(dataDir,previousTasks,nextTasks,date=new Date().toISOString()){
  const before=new Map(previousTasks.map(task=>[task.id,task])),changes=[];
  for(const task of nextTasks){
    const match=String(task.id||"").match(/^customer_([a-f0-9-]{36})$/);if(!match)continue;
    const outbox=path.join(dataDir,"_kristine/customer-portal-tasks",match[1]+".json");
    if(!fs.existsSync(outbox))continue;
    const original=read(outbox);if(original.id!==task.id||!safeId(original.jobId))continue;
    const file=path.join(dataDir,original.jobId,"_customer-portal",match[1]+".json");
    if(!fs.existsSync(file))continue;
    const row=read(file);if(row.id!==match[1]||row.taskId!==task.id)continue;
    const previous=before.get(task.id)||original,history=historyRows(row),previousRevision=Number(previous.customerPointRevision)||0,incomingRevision=Number(task.customerPointRevision)||0;
    let lifecycleChanged=false;const was=taskStatus(previous);let current=taskStatus(task);
    // A browser that was left open must never undo a newer customer decision
    // or assignment while saving some unrelated task.
    if(incomingRevision<previousRevision){
      Object.assign(task,{status:was,completedAt:previous.completedAt||null,assigneeId:previous.assigneeId,assigneeName:previous.assigneeName,dueDate:previous.dueDate||"",customerPointAssignedAt:previous.customerPointAssignedAt||null,customerPointState:previous.customerPointState||pointState(row,previous,history),customerPointUpdatedAt:previous.customerPointUpdatedAt,customerPointRevision:previousRevision,customerPointResponse:previous.customerPointResponse||"",customerPointConfirmedAt:previous.customerPointConfirmedAt||null,customerPointNotificationSentAt:previous.customerPointNotificationSentAt||null,customerPointNotificationError:previous.customerPointNotificationError||""});current=was;
      changes.push({type:"stale_status_ignored",taskId:task.id,jobId:original.jobId,pointId:match[1]});
    }else{
      const assignedAt=timestamp(task.customerPointAssignedAt),previousAssignedAt=timestamp(previous.customerPointAssignedAt);
      if(assignedAt&&assignedAt!==previousAssignedAt){
        history.push({kind:"assigned",date:assignedAt,assigneeName:text(task.assigneeName||task.assigneeId,140),dueDate:/^\d{4}-\d{2}-\d{2}$/.test(String(task.dueDate||""))?task.dueDate:""});
        task.customerPointUpdatedAt=assignedAt;
        lifecycleChanged=true;
        changes.push({type:"assigned",taskId:task.id,jobId:original.jobId,pointId:match[1]});
      }
    }
    if(was!==current){
      if(current==="done"){
        const at=timestamp(task.completedAt)||timestamp(date)||new Date().toISOString();
        history.push({kind:"internal_done",status:"done",date:at});
        task.customerPointState="awaiting_confirmation";task.customerPointUpdatedAt=at;
        lifecycleChanged=true;
        changes.push({type:"internal_done",taskId:task.id,jobId:original.jobId,pointId:match[1],title:pointTitle(row),contactName:task.contactName||original.contactName||"",contactPhone:task.contactPhone||original.contactPhone||"",contactEmail:task.contactEmail||original.contactEmail||""});
      }else if(!history.some(event=>event.kind==="customer_reopened"&&event.date===timestamp(task.customerPointUpdatedAt))){
        const at=timestamp(date)||new Date().toISOString();
        history.push({kind:"office_reopened",status:"open",date:at});
        task.customerPointState="reopened";task.customerPointUpdatedAt=at;
        lifecycleChanged=true;
        changes.push({type:"office_reopened",taskId:task.id,jobId:original.jobId,pointId:match[1]});
      }
    }
    const projected=customerPointView({...row,history},task);
    task.customerPointId=match[1];task.customerPointSource=row.source==="office"?"office":"customer";task.customerPointState=projected.state;
    if(lifecycleChanged)task.customerPointRevision=Math.max(previousRevision,incomingRevision)+1;else if(previousRevision>incomingRevision)task.customerPointRevision=previousRevision;
    if(JSON.stringify(row.history)!==JSON.stringify(history))write(file,{...row,history});
    const nextOutbox={...original,...task,status:current,completedAt:current==="done"?(timestamp(task.completedAt)||timestamp(date)):null,customerPointState:projected.state};
    if(JSON.stringify(original)!==JSON.stringify(nextOutbox))write(outbox,nextOutbox);
  }
  return changes;
}

module.exports={pointTitle,historyRows,pointState,customerPointView,recordPortalTaskChanges,updatePointAndTask};
