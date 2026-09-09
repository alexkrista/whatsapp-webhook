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

  function summarize(reports,billing={}){
    const invoices=Array.isArray(billing?.invoices)?billing.invoices:[];
    const invoiceBySourceId=new Map();
    for(const invoice of invoices){
      const key=documentKey(invoice?.sourceId??invoice?.source_id);
      if(key)invoiceBySourceId.set(key,invoice);
    }
    const rows=(Array.isArray(reports)?reports:[]).slice().sort(reportSort).map(report=>{
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

  return {summarize,documentKey,reportAmount};
});
