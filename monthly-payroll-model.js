"use strict";
const minute=v=>{const m=/^(\d{1,2}):(\d{2})$/.exec(String(v||""));return m&&+m[1]<24&&+m[2]<60?+m[1]*60+ +m[2]:null};
const hm=v=>String(Math.floor(v/60)).padStart(2,"0")+":"+String(v%60).padStart(2,"0");
function modelFor(models,e){
 const direct=models.find(m=>String(m.id)===String(e.worktimeModelId||""));
 if(direct&&direct.id!=="krista-standard")return direct;
 const n=String(e.name||e.employeeName||e.nickname||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
 const id=/\balex(?:ander)?\b/.test(n)?"office-alex":/\bbettina\b/.test(n)?"office-bettina":/\bdunja\b/.test(n)?"office-dunja":/\bgeri\b|\bgerry\b|\bgerald\b/.test(n)?"office-geri":/\bjudith\b/.test(n)?"office-judith":"";
 return models.find(m=>m.id===id)||direct||null;
}
function split(row,id="model"){
 const a=minute(row.from),b=minute(row.to);if(a===null||b===null||b<=a)return [];
 const cuts=[[minute(row.pauseFrom),minute(row.pauseTo),"pause"],[minute(row.lunchFrom),minute(row.lunchTo),"lunch"]].filter(([x,y])=>x!==null&&y!==null&&y>x&&x<b&&y>a).map(([x,y,type])=>({a:Math.max(a,x),b:Math.min(b,y),type})).sort((x,y)=>x.a-y.a);
 const points=[...new Set([a,b,...cuts.flatMap(c=>[c.a,c.b])])].sort((x,y)=>x-y);
 return points.slice(0,-1).map((start,i)=>{const end=points[i+1],pause=cuts.find(c=>start>=c.a&&end<=c.b);
 return {id:id+"_"+i,type:pause?.type||"up",from:hm(start),to:hm(end),reason:pause?"":String(row.activityLabel||"Büro"),unproductiveCategory:pause?"":"other",unproductiveCode:pause?"":String(row.activityCode||""),payrollModel:true}});
}
function net(row){return split(row).filter(s=>s.type==="up").reduce((n,s)=>n+minute(s.to)-minute(s.from),0)}
function schedule(models,e,date){
 const model=modelFor(models,e),d=new Date(date+"T12:00:00Z"),weekday=d.getUTCDay()||7;
 if(!model||!Number.isFinite(+d))return {model:null,targetMinutes:0,fixedSegments:null};
 const rows=model.blocks?.finkTarget?.rows,matching=Array.isArray(rows)?rows.filter(r=>(r.days||[]).map(Number).includes(weekday)):null;
 const factor=model.configured===true||model.officeModel||model.id!=="krista-standard"?1:Math.max(0,Number(e.employmentPercent??e.employmentPercentage??e.workPercent??100)||0)/100;
 const legacy=(model.seasons||[]).find(s=>(s.months||[]).map(Number).includes(d.getUTCMonth()+1))?.weekdays?.[String(d.getUTCDay())]||model.days?.[(weekday+6)%7]||{};
 const targetMinutes=Math.round((matching?matching.reduce((n,r)=>n+net(r),0):Number(legacy.payrollTargetHours??legacy.shouldHours??legacy.targetHours??0)*60)*factor);
 const fixed=model.blocks?.finkFixed;
 const fixedRows=fixed?.enabled===true?(fixed.rows||[]).filter(r=>(r.days||[]).map(Number).includes(weekday)):[];
 return {model,targetMinutes,fixedSegments:fixed?.enabled===true?fixedRows.flatMap((r,i)=>split(r,"fixed_"+date+"_"+i)):null};
}
function workMinutes(segments){return segments.filter(s=>["work","up"].includes(s.type)&&!["900","901","902","903","904","911","930","945","946"].includes(String(s.unproductiveCode||""))&&!/urlaub|krank|feiertag|zeitausgleich/i.test(s.reason||"")).reduce((n,s)=>n+Math.max(0,(minute(s.to)??0)-(minute(s.from)??0)),0)}
function withMorningPause(segments){
 const start=9*60,end=start+15;
 return segments.flatMap(segment=>{
  if(segment.type!=="work")return [segment];
  const from=minute(segment.from),to=minute(segment.to);
  if(from===null||to===null||to<=start||from>=end)return [segment];
  const pauseFrom=Math.max(from,start),pauseTo=Math.min(to,end);
  const result=[];
  if(from<pauseFrom)result.push({...segment,to:hm(pauseFrom)});
  result.push({id:segment.id+"_morning_pause",type:"pause",from:hm(pauseFrom),to:hm(pauseTo)});
  if(pauseTo<to)result.push({...segment,id:segment.id+"_after_morning_pause",from:hm(pauseTo)});
  return result;
 });
}
module.exports={withMorningPause,minute,hm,modelFor,schedule,split,net,workMinutes};
