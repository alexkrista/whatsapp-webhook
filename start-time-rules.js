"use strict";
const { clampStartTime } = require("./morning-status");
const { isOfficeJobId } = require("./office-time");
const minutes=value=>{const match=/^(\d{1,2}):(\d{2})$/.exec(String(value||""));return match&&+match[1]<24&&+match[2]<60?+match[1]*60 + +match[2]:null};
const closedKey=row=>`${row.employeeId}|${String(row.date||"").slice(0,7)}`;
function applies(row,rules,closed){return !closed.has(closedKey(row)) && rules?.[String(row.employeeId)]?.activityMode!=="unproductive" && !isOfficeJobId(row.jobId) && String(row.unproductiveCode||row.upCode||"")!=="022";}
function normalizeTimeEvents(rows,rules={},closures=[]){
 const closed=new Set(closures.map(row=>`${row.employeeId}|${row.month}`)),first=new Map();
 rows.forEach((row,index)=>{if(!applies(row,rules,closed)||!["start","weiter","resume","up"].includes(row.type)||minutes(row.at)===null)return;const key=`${row.employeeId}|${row.date}`,previous=first.get(key);if(previous===undefined||minutes(row.at)<minutes(rows[previous].at))first.set(key,index)});
 return rows.map((row,index)=>{
  if(closed.has(closedKey(row))||!["start","weiter","resume","up","pause","mittag","ende","fertig","stop","stopp"].includes(row.type))return row;
  const at=minutes(row.at);if(at===null)return row;
  const booked=at<420?"07:00":first.get(`${row.employeeId}|${row.date}`)===index?clampStartTime(row.at):row.at;
  return booked===row.at?row:{...row,at:booked,actualAt:row.actualAt||row.at,adjusted:true,startRule:"07:00 minimum; first start through 07:15 books 07:00"};
 });
}
function normalizeSegments(segments,employeeId,date,rules={},closures=[]){
 const rows=segments.map(row=>({...row,employeeId,date,at:row.from,type:row.type==="work"?"start":row.type==="lunch"?"mittag":row.type}));
 const normalized=normalizeTimeEvents(rows,rules,closures);
 return segments.map((row,index)=>normalized[index].at===row.from?row:{...row,from:normalized[index].at,actualFrom:row.actualFrom||row.from,startRule:normalized[index].startRule});
}
function normalizeProjectArchive(rows,rules={},closures=[]){return rows.map(row=>({...row,segments:normalizeSegments(row.segments||[],row.employeeId,row.date,rules,closures)}));}
module.exports={normalizeTimeEvents,normalizeSegments,normalizeProjectArchive};
