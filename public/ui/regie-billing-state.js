"use strict";

(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.KristaRegieBilling=api;
})(typeof window!=="undefined"?window:globalThis,function(){
  const number=value=>{const result=Number(value);return Number.isFinite(result)?result:0};
  const documentKey=value=>{
    const key=String(value||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
    return key&&!/^0+$/.test(key)?key:"";
  };
  const reportAmount=report=>{
    const total=number(report?.totalNet);
    if(total>0)return total;
    return number(report?.laborCost)+number(report?.materialCost??report?.materialTotal);
  };
  const reportSort=(a,b)=>String(a?.reportDate||"").localeCompare(String(b?.reportDate||""),"de",{numeric:true})||String(a?.sheetNumber||a?.reportNumber||"").localeCompare(String(b?.sheetNumber||b?.reportNumber||""),"de",{numeric:true});
  const reportSequence=report=>{
    const sheet=String(report?.sheetNumber||"").match(/(\d+)\D*$/);
    if(sheet)return String(Number(sheet[1]));
    const label=String(report?.reportNumber||report?.name||"").trim();
    const slash=label.match(/\/(\d+)\D*$/);
    if(slash)return String(Number(slash[1]));
    const match=label.match(/(?:^|\D)(\d{1,3})\D*$/);
    return match?String(Number(match[1])):"";
  };
  const reportDedupeKey=report=>{
    const date=String(report?.reportDate||"").slice(0,10),sequence=reportSequence(report);
    const scope=String(report?.projectNumber||report?.jobId||"");
    if(date&&sequence)return `report:${scope}|${date}|${sequence}`;
    const sourceId=documentKey(report?.sourceId??report?.source_id);
    return sourceId?`source:${sourceId}`:`row:${scope}|${date}|${String(report?.reportNumber||report?.name||"").trim().toLowerCase()}`;
  };

  function dedupeReports(reports){
    const unique=new Map();
    for(const report of Array.isArray(reports)?reports:[]){
      const key=reportDedupeKey(report),previous=unique.get(key);
      if(!previous){unique.set(key,{...report,sourceCopies:[String(report?.source||"").toUpperCase()].filter(Boolean)});continue}
      const previousIsWw=String(previous?.source||"").toUpperCase()==="WW",currentIsWw=String(report?.source||"").toUpperCase()==="WW";
      const ww=currentIsWw?report:previousIsWw?previous:null,pdf=currentIsWw?previous:report;
      const preferred=ww||previous;
      unique.set(key,{
        ...pdf,...preferred,
        url:pdf?.url||preferred?.url||"",
        pdfUrl:pdf?.url||pdf?.pdfUrl||preferred?.pdfUrl||"",
        hasPdfCopy:Boolean(pdf?.url||pdf?.pdfUrl||previous?.hasPdfCopy||report?.hasPdfCopy),
        sourceCopies:[...new Set([...(previous?.sourceCopies||[]),String(previous?.source||"").toUpperCase(),String(report?.source||"").toUpperCase()].filter(Boolean))],
      });
    }
    return [...unique.values()].sort(reportSort);
  }

  function calculatePerformance(input={}){
    const actualHours=Math.max(0,number(input.actualHours));
    const regieHours=Math.min(actualHours,Math.max(0,number(input.regieHours)));
    const orderHours=Math.max(0,actualHours-regieHours);
    const hourlyRate=85;
    const productivityFactor=.9;
    const contractAmount=Math.max(0,number(input.contractAmount));
    const plannedRegieAmount=Math.max(0,number(input.plannedRegieAmount));
    const actualRegieAmount=Math.max(0,number(input.actualRegieAmount));
    const excessRegieAmount=Math.max(0,actualRegieAmount-plannedRegieAmount);
    const orderPerformance=orderHours*hourlyRate*productivityFactor;
    const performanceBeforeCap=orderPerformance+actualRegieAmount;
    const performanceLimit=contractAmount>0?contractAmount*1.1+excessRegieAmount:performanceBeforeCap;
    const billablePerformance=Math.min(performanceBeforeCap,performanceLimit);
    const partialInvoiceNet=Math.max(0,number(input.partialInvoiceNet));
    const amountToInvoice=input.hasClosingInvoice?0:Math.max(0,billablePerformance-partialInvoiceNet);
    return {actualHours,regieHours,orderHours,hourlyRate,productivityFactor,contractAmount,plannedRegieAmount,actualRegieAmount,excessRegieAmount,orderPerformance,performanceBeforeCap,performanceLimit,billablePerformance,partialInvoiceNet,amountToInvoice};
  }

  function summarize(reports,billing={}){
    const invoices=Array.isArray(billing?.invoices)?billing.invoices:[];
    const invoiceBySourceId=new Map();
    for(const invoice of invoices){
      const key=documentKey(invoice?.sourceId??invoice?.source_id);
      if(key)invoiceBySourceId.set(key,invoice);
    }
    const rows=dedupeReports(reports).map(report=>{
      const billedDocumentId=String(report?.billedDocumentId||"").trim(),billedKey=documentKey(billedDocumentId);
      const invoice=invoiceBySourceId.get(billedKey)||null,source=String(report?.source||"").toUpperCase(),manualStatus=String(report?.billingStatus||"").toLowerCase();
      const billed=Boolean(billedKey)||(source==="KGO"&&manualStatus==="billed"),open=!billed&&(source==="WW"||(source==="KGO"&&manualStatus==="open"));
      return {report,billed,open,unknown:!billed&&!open,billedDocumentId,invoice,amount:reportAmount(report),hours:number(report?.totalHours)};
    });
    const openRows=rows.filter(row=>row.open),billedRows=rows.filter(row=>row.billed),unknownRows=rows.filter(row=>row.unknown);
    let openSeen=false,hasGap=false,lastContinuousBilled=null;
    for(const row of rows.filter(row=>!row.unknown)){
      if(row.billed){if(openSeen)hasGap=true;else lastContinuousBilled=row;}
      else openSeen=true;
    }
    return {
      rows,openRows,billedRows,unknownRows,hasGap,
      billedThrough:hasGap?null:lastContinuousBilled,
      openAmount:openRows.reduce((sum,row)=>sum+row.amount,0),
      openHours:openRows.reduce((sum,row)=>sum+row.hours,0),
      billedAmount:billedRows.reduce((sum,row)=>sum+row.amount,0),
      billedHours:billedRows.reduce((sum,row)=>sum+row.hours,0),
      unknownAmount:unknownRows.reduce((sum,row)=>sum+row.amount,0),
      totalAmount:rows.reduce((sum,row)=>sum+row.amount,0),
    };
  }

  return {summarize,calculatePerformance,dedupeReports,reportDedupeKey,documentKey,reportAmount};
});
