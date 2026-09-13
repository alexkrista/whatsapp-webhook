"use strict";
(function(){
  const D=window.BaustellenData,token=new URLSearchParams(location.search).get("token")||"";
  const LOCAL="http://127.0.0.1:5051",REMOTE="https://pc-alex02.tail610122.ts.net";
  const requests=new Map(),unavailable=new Map(),collections=new Map();
  const loaded=new Map();
  const url=path=>{const u=new URL(path,location.origin);if(token)u.searchParams.set("token",token);return u.pathname+u.search};
  async function json(path,options={}){
    const response=await fetch(url(path),{signal:AbortSignal.timeout(20000),...options}),data=await response.json();
    if(!response.ok||data?.ok===false)throw new Error(data?.error||`HTTP ${response.status}`);return data;
  }
  async function brain(kind,projectNumber){
    const route=`/api/outgoing/project-${kind==="regie"?"regie-reports":kind}`;
    let lastError;
    for(const host of [LOCAL,REMOTE]){
      const key=host+route;if((unavailable.get(key)||0)>Date.now())continue;
      const headers={Accept:"application/json","Content-Type":"application/json"};
      try{
        if(host===LOCAL){if(token)headers["X-Krista-Token"]=token}
        else{const auth=await json(`/admin/api/brain-permit?path=${encodeURIComponent(route)}`);headers["X-Krista-Brain-Permit"]=auth.permit}
        const response=await fetch(host+route,{method:"POST",headers,body:JSON.stringify({projectNumber}),signal:AbortSignal.timeout(host===LOCAL?3500:15000)});
        const data=await response.json();if(!response.ok||!data?.ok){if([401,403,404,503].includes(response.status))unavailable.set(key,Date.now()+30000);throw new Error(data?.error||`HTTP ${response.status}`)}
        return data;
      }catch(error){lastError=error;if(error.name==="TypeError"||["TimeoutError","AbortError"].includes(error.name))unavailable.set(key,Date.now()+30000)}
    }
    throw new Error("WinWorker ist nicht erreichbar. Die Verbindung zum Büro-Rechner muss verfügbar sein.",{cause:lastError});
  }
  async function ww(kind,ref,{force=false}={}){
    const key=`${kind}|${ref.projectNumber}`,old=requests.get(key);
    if(old&&(!force||old.pending)&&old.until>Date.now())return old.promise;
    const entry={pending:true,until:Date.now()+60000};requests.set(key,entry);
    entry.promise=(async()=>{
      const cachePath=`/admin/api/job/${encodeURIComponent(ref.jobId)}/ww-cache/${kind}?projectNumber=${encodeURIComponent(ref.projectNumber)}`;
      try{
        const result=await brain(kind,ref.projectNumber);
        let syncedAt=new Date().toISOString(),saved=true;
        if(kind!=="regie"){
          const data=result[kind];if(!data||!Array.isArray(data[kind==="hours"?"rows":"invoices"]))throw new Error("WinWorker liefert keinen vollständigen Stand.");
          try{const response=await json(cachePath,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({data})});syncedAt=response.syncedAt}catch{saved=false}
        }
        return {...result,cached:false,syncedAt,saved};
      }catch(error){
        if(kind!=="regie"){
          const cache=await json(cachePath).catch(()=>null);
          if(cache?.snapshot)return {ok:true,[kind]:cache.snapshot.data,cached:true,syncedAt:cache.snapshot.syncedAt,error:error.message};
        }
        throw error;
      }finally{entry.pending=false}
    })();
    return entry.promise;
  }
  function sourceError(error){return String(error?.message||error||"Abgleich fehlt")}
  async function loadCollection(job,jobs,{force=false}={}){
    const ids=D.memberIds(job),key=String(job.jobId)+"|"+ids.join(","),old=collections.get(key);
    if(old&&(!force||old.pending)&&old.until>Date.now())return old.promise;
    const entry={pending:true,until:Date.now()+10000};collections.set(key,entry);
    entry.promise=(async()=>{
      const sourceJobs=D.members(job,jobs),refs=D.projects(job,jobs),byId=new Map();
      for(const row of sourceJobs)byId.set(String(row.jobId),{jobId:String(row.jobId),job:row,name:row.name,errors:[],documents:[],days:[],regies:[],regieSources:[],billingSources:[]});
      const localPromise=D.mapLimit(sourceJobs,4,async member=>{
        const row=byId.get(String(member.jobId)),base=`/admin/api/job/${encodeURIComponent(member.jobId)}`;
        const local=await Promise.allSettled([json(base+"/days"),json(base+"/documentation")]);
        if(local[0].status==="fulfilled")row.days=(local[0].value.detailed||[]).map(day=>({...day,jobId:String(member.jobId)}));else row.errors.push("Tagesdaten: "+sourceError(local[0].reason));
        if(local[1].status==="fulfilled")row.documents=(local[1].value.items||[]).map(doc=>({...doc,jobId:String(member.jobId)}));else row.errors.push("Dokumente: "+sourceError(local[1].reason));
        const regies=await D.mapLimit(row.days,3,async day=>{const result=await json(`${base}/day/${encodeURIComponent(day.day)}/regie`);return {day:day.day,jobId:String(member.jobId),regie:result.regie||result}});
        for(const result of regies)if(result.status==="fulfilled")row.regies.push(result.value);else row.errors.push("Tagesbericht: "+sourceError(result.reason));
      });
      const remotePromise=D.mapLimit(refs,3,async ref=>{
        const row=byId.get(ref.jobId),result=await Promise.allSettled([ww("regie",ref,{force}),ww("billing",ref,{force})]);
        row.regieSources.push({...ref,...(result[0].status==="fulfilled"?{data:result[0].value}:{error:sourceError(result[0].reason)})});
        row.billingSources.push({...ref,...(result[1].status==="fulfilled"?{data:result[1].value}:{error:sourceError(result[1].reason)})});
      });
      await Promise.all([localPromise,remotePromise]);
      // Multiple WW projects may belong to one member: write once per owner to
      // prevent concurrent read/modify/write operations from losing reports.
      await D.mapLimit([...byId.values()],4,async row=>{
        const loaded=row.regieSources.filter(source=>source.data),reports=loaded.flatMap(source=>(source.data.reports||[]).map(report=>({...report,projectNumber:source.projectNumber})));
        if(!loaded.length)return;
        try{
          const base=`/admin/api/job/${encodeURIComponent(row.jobId)}/documentation`;
          const saved=await json(base+"/regie-report-sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({reports})});
          row.syncedReports=saved.count||0;
          const docs=await json(base);row.documents=(docs.items||[]).map(doc=>({...doc,jobId:row.jobId}));
        }catch(error){row.errors.push("Regieberichte speichern: "+sourceError(error));for(const source of loaded)source.error=sourceError(error)}
      });
      const rows=[...byId.values()],billingRows=rows.flatMap(row=>row.billingSources.filter(source=>source.data).map(source=>({...source,billing:source.data.billing}))),billing=D.combineBilling(billingRows);
      const missingBilling=rows.flatMap(row=>row.billingSources.filter(source=>source.error||source.data?.cached));
      billing.partial=missingBilling.length>0;billing.error=missingBilling.length?`${refs.length-missingBilling.length}/${refs.length} WinWorker-Akten aktuell; fehlende Abgleiche siehe Einzelakten.`:"";
      const result={jobId:String(job.jobId),job:D.view(job,jobs),rows,refs,billing,documents:rows.flatMap(row=>row.documents),days:rows.flatMap(row=>row.days),regies:rows.flatMap(row=>row.regies)};
      loaded.set(String(job.jobId),result);
      document.dispatchEvent(new CustomEvent("krista:collection-data-loaded",{detail:result}));return result;
    })().finally(()=>{entry.pending=false});
    return entry.promise;
  }
  function performance(jobId){
    const data=loaded.get(String(jobId)),B=window.KristaRegieBilling;if(!data||!B?.calculatePerformance)return null;
    const values=data.rows.map(row=>{
      const c=row.job.calculation||{},reports=B.dedupeReports(row.documents.filter(doc=>doc.type==="regie_report"));
      const billing=D.combineBilling(row.billingSources.filter(source=>source.data).map(source=>({...source,billing:source.data.billing}))),invoices=billing.invoices.filter(invoice=>invoice.status==="issued");
      const live=window.BaustellenLiveHours?.summarySingle?.(row.jobId,jobId);
      return {...B.calculatePerformance({actualHours:live?.total??c.actualHours,regieHours:Math.max(D.num(c.actualRegieHours),reports.reduce((sum,r)=>sum+D.num(r.totalHours),0)),
        contractAmount:c.contractAmount??row.job.contractAmount,plannedRegieAmount:c.regieBudgetAmount,actualRegieAmount:reports.reduce((sum,r)=>sum+D.num(r.totalNet||D.num(r.laborCost)+D.num(r.materialCost)),0),
        partialInvoiceNet:invoices.filter(invoice=>invoice.kind==="TR").reduce((sum,r)=>sum+D.num(r.net),0),hasClosingInvoice:invoices.some(invoice=>invoice.kind==="SR")}),closed:invoices.some(invoice=>invoice.kind==="SR")};
    });
    const sum={hourlyRate:85,hasClosingInvoice:values.length>0&&values.every(value=>value.closed),partial:data.billing.partial};
    for(const key of ["actualHours","regieHours","orderHours","contractAmount","plannedRegieAmount","actualRegieAmount","orderPerformance","performanceLimit","billablePerformance","partialInvoiceNet","amountToInvoice"])sum[key]=values.reduce((total,value)=>total+D.num(value[key]),0);
    return sum;
  }
  function clear(){requests.clear();collections.clear();unavailable.clear()}
  window.BaustellenSources={ww,load:loadCollection,clear,performance};
})();
