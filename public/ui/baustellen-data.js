"use strict";

(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.BaustellenData=api;
})(typeof window!=="undefined"?window:null,function(){
  const num=value=>Number.isFinite(Number(value))?Number(value):0;
  const positive=value=>Math.max(0,num(value));
  const unique=values=>[...new Set(values.filter(value=>value!=null&&String(value)!=="").map(String))];
  function memberIds(job){return unique([job?.jobId,...(job?.collectionMemberJobIds||[]),...(job?.collectionSummary?.jobIds||[])])}
  function members(job,jobs){const byId=new Map((jobs||[]).map(row=>[String(row.jobId),row]));return memberIds(job).map(id=>byId.get(id)||(id===String(job?.jobId)?job:null)).filter(Boolean)}
  function single(job){return {...job,collectionSummary:undefined,collectionMemberJobIds:[]}}
  function fixedTarget(job){const c=job?.calculation||{};return positive(c.fixedCalculatedHours??c.calculatedHours)}
  function orderHours(job){const c=job?.calculation||{};return positive(c.orderHours??positive(num(c.actualHours)-num(c.actualRegieHours)))}
  function remaining(job,actual=orderHours(job)){return Math.max(0,fixedTarget(job)-positive(actual))}
  function projects(job,jobs){
    const result=[],seen=new Set(),rows=members(job,jobs);
    for(const member of rows){
      // A WW link never suppresses the numeric project number of another member.
      const links=[...(member.wwProjectLinks||[]),{projectNumber:member.wwProjectNumber||member.jobId,projectIndex:member.wwProjectIndex}];
      for(const link of links){
        const projectNumber=String(link.projectNumber||"").trim();if(!/^\d{2,12}$/.test(projectNumber))continue;
        const key=projectNumber;if(seen.has(key))continue;seen.add(key);
        const owner=rows.find(row=>String(row.wwProjectNumber||row.jobId)===projectNumber)||member;
        result.push({jobId:String(owner.jobId),projectNumber,projectIndex:positive(link.projectIndex)});
      }
    }
    return result;
  }
  function aggregateCalculation(rows){
    const out={};
    for(const key of ["contractAmount","externalServices","kristaAmount","materialAmount","laborAmount","calculatedHours","plannedRegieHours","actualHours","actualRegieHours","orderHours","regieBudgetAmount","regieLaborAmount","regieMaterialAmount","otherExcludedAmount","legacyNachtragRegieAmount"]){
      out[key]=rows.reduce((sum,row)=>sum+num(row.calculation?.[key]??row[key]),0);
    }
    out.fixedCalculatedHours=rows.reduce((sum,row)=>sum+fixedTarget(row),0);
    out.remainingOrderHours=rows.reduce((sum,row)=>sum+remaining(row),0);
    out.overrunHours=rows.reduce((sum,row)=>sum+Math.max(0,orderHours(row)-fixedTarget(row)),0);
    out.materialPercent=out.kristaAmount>0?out.materialAmount/out.kristaAmount*100:0;
    out.billingRate=out.fixedCalculatedHours>0?out.laborAmount/out.fixedCalculatedHours:0;
    out.progressPercent=out.fixedCalculatedHours>0?out.orderHours/out.fixedCalculatedHours*100:0;
    return out;
  }
  function recalculateCollections(payload){
    if(!Array.isArray(payload?.jobs))return payload;
    const jobs=payload.jobs;
    for(const job of jobs){
      const rows=members(job,jobs);if(rows.length<2)continue;
      const calculation=aggregateCalculation(rows);
      job.collectionSummary={...job.collectionSummary,count:rows.length,jobIds:rows.map(row=>String(row.jobId)),calculation,
        contractAmount:calculation.contractAmount,calculatedHours:calculation.calculatedHours,fixedCalculatedHours:calculation.fixedCalculatedHours,
        actualHours:calculation.actualHours,actualRegieHours:calculation.actualRegieHours,orderHours:calculation.orderHours,
        remainingOrderHours:calculation.remainingOrderHours,overrunHours:calculation.overrunHours,
        openOrderHours:rows.filter(row=>["Auftrag","Laufend"].includes(row.status)).reduce((sum,row)=>sum+remaining(row),0),
        wwProjects:projects(job,jobs)};
    }
    return payload;
  }
  function view(job,jobs){
    if(memberIds(job).length<2)return job;
    const calculation=aggregateCalculation(members(job,jobs));
    return {...job,contractAmount:calculation.contractAmount,calculation};
  }
  async function mapLimit(items,limit,fn){
    const out=new Array(items.length);let next=0;
    async function worker(){while(next<items.length){const i=next++;try{out[i]={status:"fulfilled",value:await fn(items[i],i)}}catch(reason){out[i]={status:"rejected",reason}}}}
    await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;
  }
  function combineBilling(results){
    const invoices=[],payments=[],runs=[],seen=new Set(),summary={};
    for(const {jobId,projectNumber,billing} of results){
      for(const kind of ["invoices","payments","runs"]){
        for(const row of billing?.[kind]||[]){
          const key=`${kind}|${row.source||""}|${row.sourceId||`${row.runId||""}:${row.id||""}:${projectNumber}`}`;
          if(seen.has(key))continue;seen.add(key);
          ({invoices,payments,runs})[kind].push({...row,jobId,projectNumber});
        }
      }
      for(const [key,value] of Object.entries(billing?.summary||{}))if(typeof value==="number")summary[key]=num(summary[key])+value;
    }
    const issued=invoices.filter(row=>row.status==="issued"),draft=invoices.filter(row=>row.status==="draft");
    Object.assign(summary,{invoiceCount:issued.length,draftCount:draft.length,documentCount:invoices.length,
      billedNet:issued.reduce((s,r)=>s+num(r.net),0),billedGross:issued.reduce((s,r)=>s+num(r.gross),0),
      draftNet:draft.reduce((s,r)=>s+num(r.net),0),draftGross:draft.reduce((s,r)=>s+num(r.gross),0),
      paidGross:payments.reduce((s,r)=>s+num(r.gross),0),openGross:runs.reduce((s,r)=>s+num(r.openGross),0)});
    return {found:results.some(row=>row.billing?.found),summary,invoices,payments,runs};
  }
  return {num,memberIds,members,single,fixedTarget,orderHours,remaining,projects,aggregateCalculation,recalculateCollections,view,mapLimit,combineBilling};
});
