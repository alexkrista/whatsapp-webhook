"use strict";
const fs=require("fs/promises"),path=require("path");
const SOURCE="company_calendar",EFFECTIVE_FROM="2026-11-20";
const labels={urlaub:"Urlaub",za:"Zeitausgleich",feiertag:"Feiertag"};
function hm(value){return String(Math.floor(value/60)).padStart(2,"0")+":"+String(value%60).padStart(2,"0")}
function minutes(value){const m=/^(\d{1,2}):(\d{2})$/.exec(String(value||""));return m?+m[1]*60+ +m[2]:null}
function net(row){const a=minutes(row?.from),b=minutes(row?.to);if(a===null||b===null||b<=a)return 0;let result=b-a;for(const [x,y] of [["pauseFrom","pauseTo"],["lunchFrom","lunchTo"]]){const c=minutes(row[x]),d=minutes(row[y]);if(c!==null&&d!==null)result-=Math.max(0,Math.min(b,d)-Math.max(a,c))}return Math.max(0,result)}
function modelFor(models,employee){return models.find(m=>String(m.id)===String(employee.worktimeModelId||"krista-standard"))||null}
function payrollSchedule(models,employee,date){
 const model=modelFor(models,employee),d=new Date(date+"T12:00:00Z");if(!model||Number.isNaN(d.getTime()))return null;
 const wd=d.getUTCDay(),day=wd||7;
 if(!model.officeModel&&(wd===0||wd===6))return null;
 const rows=model.blocks?.finkTarget?.rows;
 const row=Array.isArray(rows)?rows.find(r=>(r.days||[]).map(Number).includes(day)):null;
 const season=(model.seasons||[]).find(s=>(s.months||[]).map(Number).includes(d.getUTCMonth()+1)),legacy=season?.weekdays?.[String(wd)]||{};
 if(Array.isArray(rows)&&!row)return null;
 let total=row?net(row):Math.round(Number(legacy.payrollTargetHours??model.payrollTargetHoursWeekday??0)*60);
 const factor=model.configured===true||model.officeModel||String(model.id)!=="krista-standard"?1:Math.max(0,Number(employee.employmentPercent??100))/100;
 total=Math.round(total*factor);
 const from=row?.from||legacy.from||"07:00",start=minutes(from);
 if(total<=0||start===null||start+total>1440)return null;
 const planRow=(model.blocks?.planning?.rows||[]).find(r=>(r.days||[]).map(Number).includes(day));
 const planningFree=season?Boolean(legacy.free)||!(Number(legacy.targetHours||0)>0):!planRow||net(planRow)<=0;
 return {from,to:hm(start+total),minutes:total,modelName:String(model.name||model.id),planningFree,officeModel:Boolean(model.officeModel),weekday:wd};
}
function dateRange(from,to){const out=[];for(let d=new Date(from+"T12:00:00Z");d<=new Date(to+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+1))out.push(d.toISOString().slice(0,10));return out}
function key(row){return String(row.employeeId)+"|"+String(row.date)}
function absenceType(row){
 const explicit=String(row.cardType||row.type||"").toLowerCase();if(["urlaub","za","feiertag","krank","sonderurlaub","arzt","schulung"].includes(explicit))return explicit;
 const text=String(row.jobName||row.jobId||"").toLowerCase();
 if(/feiertag/.test(text))return "feiertag";if(/zeitausgleich|__za__/.test(text))return "za";if(/urlaub/.test(text))return "urlaub";return "";
}
function deriveCalendarAssignments({assignments=[],employees=[],models=[],holidays=[],vacations=[],overrides=[],closedMonths=[],timeEvents=[],releases=[],from=EFFECTIVE_FROM,to=String(new Date().getFullYear()+1)+"-12-31"}){
 const raw=assignments.filter(r=>r.source!==SOURCE),occupied=new Set(raw.map(key));
 const worked=new Set(timeEvents.filter(r=>["start","weiter","up"].includes(String(r.type))).map(key));
 const released=new Set(releases.filter(r=>r.released===true&&r.returned!==true).map(key));
 const overrideMap=new Map(overrides.map(r=>[key(r),r]));
 const holidayMap=new Map(holidays.map(r=>[r.date,r.name])),dates=dateRange(from<EFFECTIVE_FROM?EFFECTIVE_FROM:from,to);
 const generated=[];
 for(const employee of new Map(employees.map(e=>[String(e.id||e.employeeId),e])).values()){
  const id=String(employee.id||employee.employeeId||"");if(!id||employee.active===false||employee.archived===true)continue;
  for(const date of dates){
   const k=id+"|"+date;if(occupied.has(k)||worked.has(k)||released.has(k))continue;
   if((employee.employmentStart&&date<employee.employmentStart)||(employee.employmentEnd&&date>employee.employmentEnd))continue;
   if(closedMonths.some(r=>String(r.employeeId)===id&&String(r.month)===date.slice(0,7)))continue;
   const schedule=payrollSchedule(models,employee,date);if(!schedule)continue;
   const vacation=vacations.find(r=>date>=r.from&&date<=r.to),holiday=holidayMap.get(date),override=overrideMap.get(k);
   const reason=String(vacation?.reason||"");
   const bridge=Boolean(vacation&&/br[uü]e?cken|freier?\s*freitag|zeitausgleich|(^|\W)za(\W|$)/i.test(reason));
   const freeFriday=schedule.weekday===5&&schedule.planningFree&&!schedule.officeModel;
   let type=holiday?"feiertag":bridge||freeFriday?"za":vacation?"urlaub":"";
   if(override?.type==="none")continue;
   if(override&&["urlaub","za"].includes(override.type)&&!holiday)type=override.type;
   if(!type)continue;
   generated.push({id:"calendar:"+id+":"+date,date,employeeId:id,employeeName:String(employee.name||employee.employeeName||id),finkzeitPersonnelNumber:String(employee.finkzeitPersonnelNumber||""),cardType:type,jobId:"__"+type+"__",jobName:labels[type],from:schedule.from,to:schedule.to,hours:Number((schedule.minutes/60).toFixed(4)),source:SOURCE,calendarBooking:true,calendarOverride:Boolean(override),calendarMinutes:schedule.minutes,calendarModelName:schedule.modelName,note:(override?"Manuell geändert · ":"Kalendervorschlag · ")+(holiday||reason||(freeFriday?"Freier Freitag":""))+" · "+schedule.modelName});
  }
 }
 return [...raw.map(row=>{
  if(row.date<EFFECTIVE_FROM||closedMonths.some(c=>String(c.employeeId)===String(row.employeeId)&&c.month===row.date.slice(0,7))||!["urlaub","feiertag"].includes(absenceType(row)))return row;
  const employee=employees.find(e=>String(e.id||e.employeeId)===String(row.employeeId)),schedule=employee&&payrollSchedule(models,employee,row.date);
  return schedule?{...row,calendarMinutes:schedule.minutes,calendarModelName:schedule.modelName}:row;
 }),...generated];
}
async function read(file,fallback){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch(e){if(e.code!=="ENOENT")throw e;return fallback}}
async function calendarContext(dataDir,options={}){
 const root=path.join(dataDir,"_kristine"),system=path.join(dataDir,"_system");
 const [employees,models,holidays,vacations,overrides,closedMonths,timeEvents,releases]=await Promise.all([
  options.employees?Promise.resolve(options.employees):read(path.join(system,"employees.json"),[]),read(path.join(system,"worktime-models.json"),[]),read(path.join(system,"holidays.json"),[]),read(path.join(system,"company-vacations.json"),[]),
  read(path.join(root,"calendar-booking-overrides.json"),[]),read(path.join(root,"month-closures.json"),[]),read(path.join(root,"time-events.json"),[]),read(path.join(root,"day-releases.json"),[])]);
 return {employees,models,holidays,vacations,overrides,closedMonths,timeEvents,releases,...options};
}
async function assignmentsForCalendar(dataDir,assignments,options={}){return deriveCalendarAssignments({...await calendarContext(dataDir,options),assignments})}
function totals(rows,employeeId,from,to){
 const days=new Map();for(const row of rows)if(String(row.employeeId)===String(employeeId)&&row.date>=from&&row.date<=to&&absenceType(row)){const k=key(row);if(!days.has(k))days.set(k,row)}
 const result={vacationMinutes:0,zaMinutes:0,holidayMinutes:0,days:[]};
 for(const row of days.values()){const type=absenceType(row),value=Math.round(Number(row.calendarMinutes??Number(row.hours||0)*60));const field=type==="urlaub"?"vacationMinutes":type==="za"?"zaMinutes":type==="feiertag"?"holidayMinutes":"";if(field)result[field]+=value;result.days.push({date:row.date,type,minutes:value,manual:row.source!==SOURCE||row.calendarOverride===true})}return result;
}
module.exports={SOURCE,EFFECTIVE_FROM,net,payrollSchedule,deriveCalendarAssignments,assignmentsForCalendar,calendarContext,totals};
