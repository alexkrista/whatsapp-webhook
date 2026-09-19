"use strict";
// One implementation of the Baustellen WW/KRISTINE reconciliation, used by
// the authoritative server snapshot and the site's reconciliation preview.
(function(root, factory) {
  const api=factory(typeof module!=="undefined"&&module.exports?require("./baustellen-data"):root.BaustellenData);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.BaustellenHoursCore=api;
})(typeof window!=="undefined"?window:null,function(D){
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
  const nameKey=v=>String(v||"").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  const canonicalPersonName=v=>({"max-krista":"Maximilian Krista","mandi":"Manuel Faes","mandi-faes":"Manuel Faes","johannes":"Johannes Wiederin","edi-mock":"Edmund Mock","cathrin-grabherr":"Cathrin Anna Grabherr","anna-cathrin-grabherr":"Cathrin Anna Grabherr","cathrin-anna-grabherr":"Cathrin Anna Grabherr"})[nameKey(v)]||String(v||"").trim();
  const finkNumber=(employee,row={})=>String(row?.finkzeitPersonnelNumber||row?.finkzeitPersonalNumber||row?.personalnummerFinkzeit||row?.personnelNumber||employee?.finkzeitPersonnelNumber||employee?.finkzeitPersonalNumber||employee?.personalnummerFinkzeit||employee?.personnelNumber||employee?.personalNumber||"").trim();
  const identity=(fink,name,fallback="")=>fink?`fink:${fink}`:nameKey(name)?`name:${nameKey(name)}`:`ma:${fallback||"unbekannt"}`;
  function parseWwHours(d,jobId){
    const payload=d.hours||{},days=new Map((payload.days||[]).map(row=>[String(row.date||"").slice(0,10),num(row.hours)])),grouped=new Map();
    const sourceRows=(payload.rows||[]).length?payload.rows:(payload.days||[]).map(row=>({date:row.date,hours:row.hours,employeeName:"WinWorker gesamt"}));
    for(const row of sourceRows){const date=String(row.date||"").slice(0,10),fink=String(row.finkNumber||"").trim(),employeeName=String(row.employeeName||"WinWorker gesamt").trim(),personIdentity=identity(fink,employeeName,row.maIndex),key=`${date}|${personIdentity}`,current=grouped.get(key)||{key,date,identity:personIdentity,finkNumber:fink,maIndex:row.maIndex??null,employeeName,hours:0,sourceProjectNumber:String(jobId)};current.hours+=num(row.hours??row.netHours);grouped.set(key,current)}
    // Der Brain Connector liefert bereits produktive WW-Stunden nach Pausenabzug.
    // Hier kein zweites Mal 0,25 h je Mitarbeiter/Tag abziehen.
    const rows=[...grouped.values()].map(row=>({...row,hours:Math.max(0,row.hours)})).sort((a,b)=>a.date.localeCompare(b.date)||a.employeeName.localeCompare(b.employeeName,"de")),netDays=new Map();for(const row of rows)netDays.set(row.date,num(netDays.get(row.date))+row.hours);
    return {found:!!payload.found,totalHours:rows.reduce((sum,row)=>sum+row.hours,0),days:netDays,rows,pauseDeductionHours:num(payload.pauseDeductionHours),cached:d.cached,syncedAt:d.syncedAt,saved:d.saved!==false};
  }
  function combineWw(found){
    const days=new Map(),rows=[];let pauseDeductionHours=0;
    for(const {number,data} of found){pauseDeductionHours+=num(data.pauseDeductionHours);for(const [date,value] of data.days||[])days.set(date,num(days.get(date))+num(value));for(const row of data.rows||[])rows.push({...row,key:`${number}|${row.key}`,sourceProjectNumber:number})}
    rows.sort((a,b)=>a.date.localeCompare(b.date)||a.employeeName.localeCompare(b.employeeName,"de")||a.sourceProjectNumber.localeCompare(b.sourceProjectNumber,"de"));
    const stamps=found.map(x=>x.data.syncedAt).filter(Boolean).sort();
    return {found:found.some(x=>x.data.found),totalHours:rows.reduce((sum,row)=>sum+num(row.hours),0),days,rows,pauseDeductionHours,projectNumbers:found.map(x=>x.number),cached:found.some(x=>x.data.cached),syncedAt:stamps[0]||"",saved:found.every(x=>x.data.saved!==false)};
  }
  function hmMinutes(v){const m=String(v||"").match(/^(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):null}
  function collectionJobIds(j){const ids=Array.isArray(j?.collectionSummary?.jobIds)?j.collectionSummary.jobIds:[j?.jobId];return [...new Set(ids.map(String).filter(Boolean))]}
  function calc(j){return j?.calculation||{}}
  function oldTotalHours(j){return num(j?.collectionSummary?.actualHours??calc(j).actualHours)}

  function createEngine({jobs=[],bootstrap={},wwByMember=new Map(),wwByJob=new Map(),reconciliationDrafts=new Map(),now=new Date()}={}) {
    let liveByJob=new Map(),peopleByJob=new Map();
    function nowMinutes(){const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Vienna",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(now);const part=type=>Number(parts.find(p=>p.type===type)?.value||0);return part("hour")*60+part("minute")+part("second")/60}
  function buildLiveMaps(){
    liveByJob=new Map();peopleByJob=new Map();
    const events=Array.isArray(bootstrap?.timeEvents)?bootstrap.timeEvents:[];
    const archive=Array.isArray(bootstrap?.projectTimeArchive)?bootstrap.projectTimeArchive:[];
    const states=bootstrap?.states||{};
    const employees=new Map((bootstrap?.employees||[]).map(e=>[String(e.id||e.employeeId||""),e]));
    // Nur ein tatsächlich brauchbarer Baustellenstand darf die Live-Ereignisse
    // dieses Tages ersetzen. Ein leerer/unvollständiger Archivsatz darf niemals
    // alle Baustellen aus dem Leitstand verschwinden lassen.
    const usableArchive=archive.filter(row=>(row?.segments||[]).some(segment=>String(segment?.type||"")==="work"&&String(segment?.jobId||segment?.jobName||"").trim()));
    const groups=new Map(),archivedPersonDays=new Set(usableArchive.map(row=>`${String(row?.employeeId||"")}|${String(row?.date||"").slice(0,10)}`));

    const addDuration=({employeeId,date,jobId,name,fink,duration})=>{
      if(!employeeId||!date||!jobId||duration<=0||duration>18)return;
      const personIdentity=identity(fink,name,employeeId),current=liveByJob.get(jobId)||{totalHours:0,segments:0,days:new Map(),dayPeople:new Map()};
      current.totalHours+=duration;current.segments++;current.days.set(date,num(current.days.get(date))+duration);liveByJob.set(jobId,current);
      if(!peopleByJob.has(jobId))peopleByJob.set(jobId,new Map());
      const people=peopleByJob.get(jobId),person=people.get(employeeId)||{employeeId,identity:personIdentity,finkNumber:fink,name,hours:0,days:new Set()};
      person.hours+=duration;person.days.add(date);people.set(employeeId,person);
      if(!current.dayPeople.has(date))current.dayPeople.set(date,new Map());
      const dayPeople=current.dayPeople.get(date),dayPerson=dayPeople.get(personIdentity)||{employeeId,identity:personIdentity,finkNumber:fink,name,hours:0};
      dayPerson.hours+=duration;dayPeople.set(personIdentity,dayPerson);
    };

    events.forEach((event,index)=>{
      const employeeId=String(event?.employeeId||"");
      const date=String(event?.date||"").slice(0,10);
      const minute=hmMinutes(event?.at);
      if(!employeeId||!date||minute===null)return;
      const key=employeeId+"|"+date;
      if(archivedPersonDays.has(key))return;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({...event,_index:index,_minute:minute});
    });

    for(const [key,rows] of groups){
      rows.sort((a,b)=>a._minute-b._minute||String(a.createdAt||"").localeCompare(String(b.createdAt||""))||a._index-b._index);
      const [employeeId,date]=key.split("|");
      const state=states?.[employeeId]||{};
      for(let i=0;i<rows.length;i++){
        const row=rows[i];
        if(!["start","weiter"].includes(String(row.type||"").toLowerCase()))continue;
        const jobId=String(row.jobId||"").trim();
        if(!jobId)continue;
        const start=row._minute;
        const next=rows[i+1];
        let end=next?._minute??null;
        if(end===null&&date===String(bootstrap?.today||"")&&["working","pause","lunch"].includes(String(state?.mode||"")))end=nowMinutes();
        if(end===null||end<=start)continue;
        const duration=(end-start)/60;
        if(duration<=0||duration>18)continue;

        const employee=employees.get(employeeId)||{};
        const name=String(row.employeeName||employee.nickname||employee.name||employee.employeeName||employeeId);
        addDuration({employeeId,date,jobId,name,fink:finkNumber(employee,row),duration});
      }
    }
    for(const released of usableArchive){
      const employeeId=String(released?.employeeId||""),date=String(released?.date||"").slice(0,10),employee=employees.get(employeeId)||{},name=String(released?.employeeName||employee.nickname||employee.name||employee.employeeName||employeeId),fink=finkNumber(employee,released);
      for(const segment of Array.isArray(released?.segments)?released.segments:[]){
        if(String(segment?.type||"")!=="work")continue;
        const from=hmMinutes(segment?.from),to=hmMinutes(segment?.to),jobId=String(segment?.jobId||"").trim();
        if(from===null||to===null||to<=from)continue;
        addDuration({employeeId,date,jobId,name,fink,duration:(to-from)/60});
      }
    }
    for(const current of liveByJob.values()){
      current.days=new Map();current.totalHours=0;
      for(const [date,dayPeople] of current.dayPeople){let dayTotal=0;for(const person of dayPeople.values()){person.hours=Math.max(0,person.hours-.25);dayTotal+=person.hours}current.days.set(date,dayTotal);current.totalHours+=dayTotal}
    }
    for(const people of peopleByJob.values())for(const person of people.values())person.hours=Math.max(0,person.hours-.25*person.days.size);
  }
  function liveOrderHours(j){if(!j)return 0;return collectionJobIds(j).reduce((sum,id)=>sum+num(liveByJob.get(id)?.totalHours),0)}
  function kristineFor(j){
    const combined={totalHours:0,days:new Map(),dayPeople:new Map()};
    for(const id of collectionJobIds(j)){const source=liveByJob.get(id);if(!source)continue;combined.totalHours+=num(source.totalHours);for(const [date,value] of source.days||[])combined.days.set(date,num(combined.days.get(date))+num(value));for(const [date,people] of source.dayPeople||[]){if(!combined.dayPeople.has(date))combined.dayPeople.set(date,new Map());const target=combined.dayPeople.get(date);for(const person of people.values()){const current=target.get(person.identity)||{...person,hours:0};current.hours+=num(person.hours);target.set(person.identity,current)}}}
    return combined;
  }
  function matchingKristinePerson(krDayPeople,wwRow){
    if(!krDayPeople)return null;
    if(krDayPeople.has(wwRow.identity))return krDayPeople.get(wwRow.identity);
    const wanted=nameKey(canonicalPersonName(wwRow.employeeName));return [...krDayPeople.values()].find(person=>(wwRow.finkNumber&&person.finkNumber===wwRow.finkNumber)||(wanted&&nameKey(canonicalPersonName(person.name))===wanted))||null;
  }
  function suggestedExclusions(ww,kr){
    const selected=new Set();for(const row of ww?.rows||[]){if(matchingKristinePerson(kr?.dayPeople?.get(row.date),row))selected.add(row.key)}return selected;
  }
  function selectedExclusions(j,ww,kr){
    const jobId=String(j?.jobId||"");
    if(reconciliationDrafts.has(jobId))return reconciliationDrafts.get(jobId);
    if(j?.hoursCutoverDate)return new Set((ww?.rows||[]).filter(row=>row.date>=String(j.hoursCutoverDate)).map(row=>row.key));
    if(j?.hoursOverlapResolvedAt)return new Set(Array.isArray(j.hoursOverlapExcludedWwKeys)?j.hoursOverlapExcludedWwKeys:[]);
    return suggestedExclusions(ww,kr);
  }
  function singleFusion(j,head=j){
    j=D.single(j);
    const jobId=String(j?.jobId||""),ww=wwByMember.get(jobId)||wwByJob.get(jobId),kr=kristineFor(j),kristineDetailTotal=liveOrderHours(j),kristineTotal=Math.max(oldTotalHours(j),kristineDetailTotal);
    if(!ww?.found)return {total:kristineTotal,ww:0,kristine:kristineTotal,detailTotal:kristineDetailTotal,overlaps:[],excluded:new Set(),source:"KRISTINE"};
    const krDays=kr?.days||new Map(),rawKr=num(kr?.totalHours),scale=rawKr>0?kristineTotal/rawKr:0;
    const overlaps=[...ww.days.keys()].filter(day=>krDays.has(day)).sort();
    const owner=!D.isCollection(head)&&(reconciliationDrafts.has(String(head.jobId))||head.hoursOverlapResolvedAt||head.hoursCutoverDate)?head:j;
    const rawExcluded=selectedExclusions(owner,ww,kr),excluded=new Set((ww.rows||[]).filter(row=>rawExcluded.has(row.key)||rawExcluded.has(row.key.slice(row.key.indexOf("|")+1))).map(row=>row.key)),legacyCutover=String(owner?.hoursCutoverDate||"");
    let wwHours=0,kristineHours=0;
    if(legacyCutover&&!reconciliationDrafts.has(jobId)){for(const [day,value] of ww.days)if(day<legacyCutover)wwHours+=num(value);for(const [day,value] of krDays)if(day>=legacyCutover)kristineHours+=num(value)*scale}
    else{wwHours=(ww.rows||[]).reduce((sum,row)=>sum+(excluded.has(row.key)?0:num(row.hours)),0);kristineHours=kristineTotal}
    return {total:wwHours+kristineHours,ww:wwHours,kristine:kristineHours,detailTotal:kristineDetailTotal,overlaps,excluded,source:"WW + KRISTINE",legacyCutover};
  }

    function snapshot(){
      const byJob={};
      for(const j of jobs){
        const members=D.members(j,jobs),rows=members.map(member=>({jobId:String(member.jobId),target:D.totalTarget(member),...singleFusion(member,j)}));
        const target=rows.reduce((sum,row)=>sum+row.target,0),total=rows.reduce((sum,row)=>sum+row.total,0);
        const balance=D.hourBalance(target,total);
        byJob[String(j.jobId)]={target,total,ww:rows.reduce((sum,row)=>sum+row.ww,0),kristine:rows.reduce((sum,row)=>sum+row.kristine,0),...balance,remaining:D.isSettled(j)?0:balance.remaining};
      }
      const counted=new Set(),open=[];
      for(const j of jobs.filter(row=>!(row.collectionParentJobIds||[]).length)){
        if(D.isSettled(j))continue;
        const members=D.members(j,jobs).filter(row=>["Auftrag","Laufend"].includes(row.status)&&!counted.has(String(row.jobId)));
        if(!members.length)continue;
        for(const member of members)counted.add(String(member.jobId));
        const target=members.reduce((sum,row)=>sum+D.totalTarget(row),0),worked=members.reduce((sum,row)=>sum+singleFusion(row,j).total,0);
        open.push({jobId:String(j.jobId),target,worked,...D.hourBalance(target,worked)});
      }
      return {version:1,source:"baustellen",calculatedAt:now.toISOString(),targetHours:open.reduce((sum,row)=>sum+row.target,0),workedHours:open.reduce((sum,row)=>sum+row.worked,0),remainingHours:open.reduce((sum,row)=>sum+row.remaining,0),overrunHours:open.reduce((sum,row)=>sum+row.overrun,0),byJob};
    }
    buildLiveMaps();
    return {liveByJob,peopleByJob,liveOrderHours,kristineFor,matchingKristinePerson,suggestedExclusions,selectedExclusions,singleFusion,snapshot};
  }
  return {createEngine,parseWwHours,combineWw};
});
