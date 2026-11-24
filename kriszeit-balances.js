"use strict";

// Obelisk October 2026, checked and released by Alexander Krista.
// Values are decimal hours/days. Blank Obelisk balances are zero.
const OCTOBER = Object.freeze({
  "60": [817,38.33,0,818.16,-1.17,0],
  "384": [30.65,7.77,0,29.50,1.15,0],
  "26": [41.18,5.12,4.97,38.09,2.60,.50],
  "276": [50.61,8.17,6.03,46.43,3.58,.60],
  "18": [5.50,4.08,0,5.50,0,0],
  "39": [-1.28,0,0,-4.21,2.93,0],
  "139": [55.84,5.09,13.98,49.26,5.18,1.40],
  "54": [0,7.50,0,0,0,0],
  "14": [69.05,19.06,0,78.94,-9.88,0],
  "402": [3.23,3.17,0,2.87,.37,0],
  "20": [1.67,0,0,-.36,2.03,0],
});
const OCTOBER_ATTENDANCE=Object.freeze({"60":8642,"384":4469,"26":10452,"276":10511,"18":1350,"39":10556,"139":10819,"54":480,"14":7657,"402":2182,"20":10502});
const personnelNumber = e => String(e.finkzeitPersonnelNumber||e.finkzeitPersonalNumber||e.personalnummerFinkzeit||e.personnelNumber||e.personalNumber||"");
const priorMonth = month => {
  const d=new Date(month+"-01T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth()-1);
  return d.toISOString().slice(0,7);
};
function opening(employee,month,closures) {
  const seed=OCTOBER[personnelNumber(employee)];
  if(month==="2026-10"&&seed)return {source:"Obelisk",time:seed[3],vacation:null};
  if(month==="2026-11"&&seed)return {source:"Obelisk Oktober 2026",time:seed[0],vacation:seed[1]};
  const previous=closures.find(r=>String(r.employeeId)===String(employee.id||employee.employeeId)&&r.month===priorMonth(month));
  const balance=previous?.report?.balances;
  return balance&&Number.isFinite(balance.newTime)
    ? {source:previous.month,time:balance.newTime,vacation:balance.newVacation??null}:null;
}
function calculate(employee,month,closures,totals,entitlement,surcharges,adjustments=[],zaEntries=[]) {
  const seed=OCTOBER[personnelNumber(employee)],start=opening(employee,month,closures);
  if(month==="2026-10"&&seed)return {source:"Obelisk Oktober 2026",approved:true,openingTime:seed[3],monthTime:seed[4],transferTime:seed[5],correctionTime:0,newTime:seed[0],openingVacation:personnelNumber(employee)==="276"?6.08:null,accrual:personnelNumber(employee)==="276"?25/12:null,newVacation:seed[1],z10:seed[2],z50:0,attendanceMinutes:OCTOBER_ATTENDANCE[personnelNumber(employee)]};
  const items=adjustments.filter(a=>a.month===month&&String(a.employeeId)===String(employee.id||employee.employeeId));
  const total=(kind,key)=>items.filter(a=>a.kind===kind).reduce((n,a)=>n+Number(a[key]||0),0);
  const toOld=zaEntries.filter(r=>r.type==="monthly_transfer"&&r.note==="Umbuchung Zeitkonto in ZA alt"&&String(r.employeeId)===String(employee.id||employee.employeeId)&&String(r.from||"").slice(0,7)===month).reduce((n,r)=>n+Number(r.minutes||0),0)/60;
  const correctionTime=total("correction","timeHours"),transferTime=total("transfer","timeHours")-toOld;
  const correctionVacation=total("correction","vacationDays"),transferVacation=total("transfer","vacationDays");
  const monthTime=Number(totals.balanceMinutes||0)/60;
  const accrual=entitlement?.monthlyDays??null;
  const buak=personnelNumber(employee)==="20"||personnelNumber(employee)==="39";
  return {source:start?.source||null,openingTime:start?.time??null,monthTime,transferTime,correctionTime,correctionVacation,transferVacation,
    newTime:start?start.time+monthTime+correctionTime+transferTime:null,openingVacation:start?.vacation??null,accrual:buak?null:accrual,
    vacationUsed:Number(totals.vacation||0),newVacation:start?.vacation!=null&&!buak&&accrual!=null?start.vacation+accrual-Number(totals.vacation||0)+correctionVacation+transferVacation:null,
    z10:surcharges?.z10??null,z50:surcharges?.z50??null};
}
function bands(minutes){return [Math.max(0,Math.min(2700,minutes)-2400),Math.max(0,minutes-2700)]}
function weeklySurcharges(days,from,to){
  let running=0,z10=0,z50=0;
  for(const day of days){
    if(new Date(day.date+"T12:00:00Z").getUTCDay()===1)running=0;
    const old=bands(running);running+=Number(day.minutes||0);const now=bands(running);
    if(day.date>=from&&day.date<=to){z10+=now[0]-old[0];z50+=now[1]-old[1]}
  }
  return {z10:z10/60,z50:z50/60};
}
module.exports={opening,calculate,weeklySurcharges,personnelNumber};
