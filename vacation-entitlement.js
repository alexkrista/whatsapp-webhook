"use strict";

function months(value) {
  const n=Number(value);
  return Number.isFinite(n)?Math.max(0,Math.floor(n)):0;
}

function vacationEntitlement(employee, asOf) {
  const entry=String(employee.employmentStart||"");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(entry)||entry>asOf)return null;
  const [year,month,day]=entry.split("-").map(Number);
  const entryDate=new Date(entry+"T12:00:00Z");
  if(!Number.isFinite(+entryDate)||entryDate.toISOString().slice(0,10)!==entry)return null;
  const overFive=employee.vacationPriorServiceOverFive??(employee.vacationPriorServiceConfirmed===true&&months(employee.vacationPriorServiceMonths)>60);
  const priorMonths=overFive===true?60:0;
  const eligibleMonths=year*12+month-1+300-priorMonths;
  const eligibleYear=Math.floor(eligibleMonths/12);
  const eligibleMonth=eligibleMonths%12;
  const eligibleDay=Math.min(day,new Date(Date.UTC(eligibleYear,eligibleMonth+1,0)).getUTCDate());
  const eligibleFrom=new Date(Date.UTC(eligibleYear,eligibleMonth,eligibleDay)).toISOString().slice(0,10);
  const annualDays=asOf>=eligibleFrom?30:25;
  return {entry,eligibleFrom,annualDays,monthlyDays:annualDays/12};
}
module.exports={months,vacationEntitlement};
