"use strict";
const minute=v=>{const m=/^(\d{1,2}):(\d{2})$/.exec(String(v||""));return m&&+m[1]<24&&+m[2]<60?+m[1]*60+ +m[2]:null};
const hm=v=>String(Math.floor(v/60)).padStart(2,"0")+":"+String(v%60).padStart(2,"0");
function assignedModel(models,e){
 return e.worktimeModelId ? models.find(m=>String(m.id)===String(e.worktimeModelId)) : undefined;
}
function modelFor(models,e){
 const direct=assignedModel(models,e);
 if(direct)return direct;
 const n=String(e.name||e.employeeName||e.nickname||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
 const id=/\balex(?:ander)?\b/.test(n)?"office-alex":/\bbettina\b/.test(n)?"office-bettina":/\bdunja\b/.test(n)?"office-dunja":/\bgeri\b|\bgerry\b|\bgerald\b/.test(n)?"office-geri":/\bjudith\b/.test(n)?"office-judith":"";
 return models.find(m=>m.id===id)||null;
}
function split(row,id="model"){
 const a=minute(row.from),b=minute(row.to);if(a===null||b===null||b<=a)return [];
 const cuts=[[minute(row.pauseFrom),minute(row.pauseTo),"pause"],[minute(row.lunchFrom),minute(row.lunchTo),"lunch"]].filter(([x,y])=>x!==null&&y!==null&&y>x&&x<b&&y>a).map(([x,y,type])=>({a:Math.max(a,x),b:Math.min(b,y),type})).sort((x,y)=>x.a-y.a);
 const points=[...new Set([a,b,...cuts.flatMap(c=>[c.a,c.b])])].sort((x,y)=>x-y);
 return points.slice(0,-1).map((start,i)=>{const end=points[i+1],pause=cuts.find(c=>start>=c.a&&end<=c.b);
 return {id:id+"_"+i,type:pause?.type||"up",from:hm(start),to:hm(end),reason:pause?"":String(row.activityLabel||"Büro"),unproductiveCategory:pause?"":"other",unproductiveCode:pause?"":String(row.activityCode||""),payrollModel:true}});
}
function net(row){return split(row).filter(s=>s.type==="up").reduce((n,s)=>n+minute(s.to)-minute(s.from),0)}
function obeliskSchedule(model,employee,weekday){
 const personnel=String(employee.finkzeitPersonnelNumber||employee.finkzeitPersonalNumber||employee.personalnummerFinkzeit||employee.personnelNumber||employee.personalNumber||"");
 const name=String(employee.name||employee.employeeName||"").toLowerCase();
 if(["20","39"].includes(personnel)||/^(johannes wiederin|wiederin johannes|ronny hoffmann|hoffmann ronny)$/.test(name)){
  const targetMinutes=weekday<5?540:weekday===5?240:0;
  return {model:{...model, name:"39 Std. + 1 vertragliche Überstunde"},targetMinutes,fixedSegments:null,regularWeekMinutes:2340,contractOvertimeWeekMinutes:60};
 }
 if(model?.id==="office-bettina")return {model,targetMinutes:weekday<=5?200:0,fixedSegments:null};
 let targetMinutes=0,from="",reason="",code="";
 if(model?.id==="office-alex"){
  targetMinutes=weekday<=5?396:0;from="07:00";reason="Modellzeit";
 }else if(model?.id==="office-geri"){
  targetMinutes=[2,4].includes(weekday)?150:0;from="14:00";reason="Werkstatt";code="913";
 }else if(model?.id==="office-judith"){
  targetMinutes=[1,5].includes(weekday)?480:weekday===2?240:0;from="08:00";reason="Büro";
 }else return null;
 const fixedSegments=targetMinutes?split({from,to:hm(minute(from)+targetMinutes),activityLabel:reason,activityCode:code},"office_"+weekday):[];
 if(["office-alex","office-judith"].includes(model.id))for(const segment of fixedSegments)segment.durationOnly=true;
 return {model,targetMinutes,fixedSegments};
}
function schedule(models,e,date){
 const assigned=assignedModel(models,e),model=assigned||modelFor(models,e),d=new Date(date+"T12:00:00Z"),weekday=d.getUTCDay()||7;
 const obelisk=Number.isFinite(+d)?obeliskSchedule(model,e,weekday):null;
 // Until BUAK has its own assigned model, keep the existing 40-hour schedule.
 if(obelisk?.contractOvertimeWeekMinutes&&(!assigned||assigned.id==="krista-standard"))return obelisk;
 if(!assigned&&!model?.blocks?.finkTarget?.rows?.length&&obelisk)return obelisk;
 if(!model||!Number.isFinite(+d))return {model:null,targetMinutes:0,fixedSegments:null};
 const rows=model.blocks?.finkTarget?.rows,matching=Array.isArray(rows)?rows.filter(r=>(r.days||[]).map(Number).includes(weekday)):null;
 const factor=model.configured===true||model.officeModel||model.id!=="krista-standard"?1:Math.max(0,Number(e.employmentPercent??e.employmentPercentage??e.workPercent??100)||0)/100;
 const legacy=(model.seasons||[]).find(s=>(s.months||[]).map(Number).includes(d.getUTCMonth()+1))?.weekdays?.[String(d.getUTCDay())]||model.days?.[(weekday+6)%7]||{};
 const targetMinutes=Math.round((matching?matching.reduce((n,r)=>n+net(r),0):Number(legacy.payrollTargetHours??legacy.shouldHours??legacy.targetHours??0)*60)*factor);
 const fixed=model.blocks?.finkFixed;
 const fixedRows=fixed?.enabled===true?(fixed.rows||[]).filter(r=>(r.days||[]).map(Number).includes(weekday)):[];
 return {model,targetMinutes,fixedSegments:fixed?.enabled===true?fixedRows.flatMap((r,i)=>split(r,"fixed_"+date+"_"+i)):null,
  regularWeekMinutes:obelisk?.regularWeekMinutes,contractOvertimeWeekMinutes:obelisk?.contractOvertimeWeekMinutes};
}
function workMinutes(segments){return segments.filter(s=>["work","up"].includes(s.type)&&!["900","901","902","903","904","911","930","945","946"].includes(String(s.unproductiveCode||""))&&!/urlaub|krank|feiertag|zeitausgleich/i.test(s.reason||"")).reduce((n,s)=>n+Math.max(0,(minute(s.to)??0)-(minute(s.from)??0)),0)}
function withMorningPause(segments){
 const start=9*60,end=start+15;
 const doctorOverlapsPause=segments.some(segment=>{
  if(segment.type!=="up")return false;
  const doctor=String(segment.unproductiveCode||"")==="902"||/^(arzt|doctor)$/i.test(segment.absenceType||"")||/\barzt(?:besuch|termin)?\b/i.test(segment.reason||"");
  const from=minute(segment.from),to=minute(segment.to);
  return doctor&&from!==null&&to!==null&&to>from&&from<end&&to>start;
 });
 if(doctorOverlapsPause)return segments;
 return segments.flatMap(segment=>{
  if(!["work","up"].includes(segment.type))return [segment];
  if(segment.type==="up"&&(["900","901","904","930"].includes(String(segment.unproductiveCode||""))||
    ["vacation","sick","urlaub","krank","feiertag","za","holiday"].includes(String(segment.absenceType||segment.unproductiveCategory||"").toLowerCase())||
    /(?:^|\b)urlaub\b|krank|feiertag|zeitausgleich/i.test(segment.reason||"")))return [segment];
  const from=minute(segment.from),to=minute(segment.to);
  if(from===null||to===null||to<=start||from>=end)return [segment];
  const pauseFrom=Math.max(from,start),pauseTo=Math.min(to,end);
  const result=[];
  if(from<pauseFrom)result.push({...segment,to:hm(pauseFrom)});
  result.push({id:segment.id+"_morning_pause",type:"pause",from:hm(pauseFrom),to:hm(pauseTo),morningPauseSource:segment});
  if(pauseTo<to)result.push({...segment,id:segment.id+"_after_morning_pause",from:hm(pauseTo)});
  return result;
 });
}
module.exports={withMorningPause,minute,hm,modelFor,schedule,split,net,workMinutes};
