"use strict";
// Saving a stale browser list must never erase dates loaded by another user.
function annualCompanyHolidays(){
 const rows=[];
 // The planning calendar supports years through 2100; historical years stay unchanged.
 for(let year=2026;year<=2100;year++)for(const [day,name] of [["12-24","Heiliger Abend"],["12-31","Silvester"]])
  rows.push({date:year+"-"+day,name:name+" - betrieblicher Feiertag"});
 return rows;
}
function mergeHolidayRows(existing,incoming,deletedDates=[]){
 const deleted=new Set((Array.isArray(deletedDates)?deletedDates:[]).map(String));
 const byDate=new Map(annualCompanyHolidays().map(row=>[row.date,row]));
 for(const row of [...(existing||[]),...(incoming||[])])
  if(row&&/^\d{4}-\d{2}-\d{2}$/.test(String(row.date))&&!deleted.has(String(row.date)))
   byDate.set(String(row.date),{date:String(row.date),name:String(row.name||"Feiertag").trim().slice(0,120)||"Feiertag"});
 return [...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
module.exports={mergeHolidayRows,annualCompanyHolidays};
