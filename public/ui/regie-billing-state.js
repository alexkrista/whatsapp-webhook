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
    const material=report?.materialCost??report?.materialTotal;
    if(report?.laborCost!==undefined&&material!==undefined)return number(report?.laborCost)+number(material);
    return number(report?.totalNet)||number(report?.laborCost)+number(material);
  };
  const reportSort=(a,b)=>String(a?.reportDate||"").localeCompare(String(b?.reportDate||""),"de",{numeric:true})||String(a?.sheetNumber||a?.reportNumber||"").localeCompare(String(b?.sheetNumber||b?.reportNumber||""),"de",{numeric:true});
  const reportSequence=report=>{
    const sheet=String(report?.sheetNumber||"").match(/(\d+)\D*$/);
    if(sheet)return String(Number(sheet[1]));
    const label=String(report?.reportNumber||report?.name||"").trim();
    const projectNumber=String(report?.projectNumber||report?.jobId||"").replace(/\D/g,"");
    const compact=label.replace(/\D/g,"");
    if(/^\d+$/.test(label)&&projectNumber&&compact.startsWith(projectNumber)){
      const suffix=compact.slice(projectNumber.length);
      if(/^\d{1,3}$/.test(suffix))return String(Number(suffix));
    }
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

  const cents=value=>Math.round((number(value)+Number.EPSILON)*100)/100;
  const CALCULATION_VERSION="20260915-progress-4";
  function calculatePerformance(input={}){
    const actualHours=Math.max(0,number(input.actualHours)),regieHours=Math.max(0,number(input.regieHours));
    const orderHours=Math.max(0,actualHours-regieHours),fixedTargetHours=Math.max(0,number(input.fixedTargetHours));
    const plannedRegieHours=Math.max(0,number(input.plannedRegieHours)),contractAmount=Math.max(0,number(input.contractAmount));
    const plannedRegieAmount=Math.max(0,number(input.plannedRegieAmount));
    const fixedContractAmount=Math.max(0,number(input.fixedContractAmount??(contractAmount-plannedRegieAmount)));
    const actualRegieAmount=Math.max(0,number(input.actualRegieAmount));
    const partialInvoiceNet=cents(input.partialInvoiceNet),regiePartialInvoiceNet=cents(input.regiePartialInvoiceNet);
    const fixedPartialInvoiceNet=cents(input.fixedPartialInvoiceNet??(partialInvoiceNet-regiePartialInvoiceNet));
    const billedRegieAmount=Math.max(0,number(input.billedRegieAmount));
    // Linked reports have already been removed from the open report balance.
    // Only an additional Regie advance not covered by those reports is deducted again.
    const additionalRegiePartialNet=Math.max(0,cents(regiePartialInvoiceNet-number(input.linkedRegiePartialNet)));
    const regieDeductions=cents(billedRegieAmount+additionalRegiePartialNet);
    const orderProgressPercent=fixedTargetHours>0?orderHours/fixedTargetHours*100:null;
    const completionPercent=orderProgressPercent===null?(fixedContractAmount===0?0:null):Math.min(100,orderProgressPercent);
    const orderPerformance=completionPercent===null?null:cents(fixedContractAmount*completionPercent/100);
    const fixedBalance=orderPerformance===null?null:cents(orderPerformance-fixedPartialInvoiceNet),fixedToInvoice=fixedBalance===null?null:Math.max(0,fixedBalance);
    const regieBalance=cents(actualRegieAmount-regieDeductions),regieToInvoice=Math.max(0,regieBalance);
    const hasClosingInvoice=!!input.hasClosingInvoice,issues=[...(input.issues||[])];
    if(fixedContractAmount>0&&fixedTargetHours<=0)issues.push("Sollstunden ohne Regie fehlen. Der Fertigstellungsgrad ist noch nicht berechenbar.");
    if(regieHours>actualHours+.02)issues.push("Regiestunden sind höher als die Gesamtstunden. Stundenstand abgleichen.");
    if(input.partial)issues.push("Der Rechnungs- oder Berichtsdatenstand ist unvollständig.");
    const complete=hasClosingInvoice||issues.length===0;
    const amountToInvoice=hasClosingInvoice?0:complete?cents(fixedToInvoice+regieToInvoice):null;
    const result={version:CALCULATION_VERSION,actualHours,regieHours,orderHours,fixedTargetHours,plannedRegieHours,
      contractAmount,fixedContractAmount,plannedRegieAmount,actualRegieAmount,partialInvoiceNet,
      fixedPartialInvoiceNet,regiePartialInvoiceNet,linkedRegiePartialNet:cents(input.linkedRegiePartialNet),additionalRegiePartialNet,billedRegieAmount,regieDeductions,
      orderProgressPercent,completionPercent,regieProgressPercent:plannedRegieHours>0?regieHours/plannedRegieHours*100:null,
      remainingRegieHours:Math.max(0,plannedRegieHours-regieHours),regieOverrunHours:Math.max(0,regieHours-plannedRegieHours),
      orderPerformance,fixedBalance,regieBalance,fixedToInvoice:hasClosingInvoice?0:fixedToInvoice,regieToInvoice:hasClosingInvoice?0:regieToInvoice,
      billablePerformance:orderPerformance===null?null:cents(orderPerformance+actualRegieAmount),
      performanceLimit:cents(fixedContractAmount+actualRegieAmount),amountToInvoice,hasClosingInvoice,complete,partial:!!input.partial,issues:[...new Set(issues)],
      jobId:String(input.jobId||""),jobName:String(input.jobName||""),dataUpdatedAt:String(input.dataUpdatedAt||""),hoursThroughDate:String(input.hoursThroughDate||""),calculatedAt:new Date().toISOString()};
    result.warnings=[];
    if(!hasClosingInvoice&&orderProgressPercent!==null&&orderProgressPercent>=90-1e-8)
      result.warnings.push({kind:"fixed",jobId:result.jobId,title:"Fixauftrag: mindestens 90 % der Sollstunden verbraucht",text:"Stand plausibel? Dauern die Arbeiten länger als geplant? Nachauftrag nötig?"});
    if(!hasClosingInvoice&&result.regieProgressPercent!==null&&result.regieProgressPercent>=90-1e-8)
      result.warnings.push({kind:"regie",jobId:result.jobId,title:"Regie: mindestens 90 % der angebotenen Stunden verbraucht",text:`Noch ${formatHours(result.remainingRegieHours)} Regiestunden offen${result.regieOverrunHours>0?` · ${formatHours(result.regieOverrunHours)} über dem Angebot`:""}. Reicht das? Nachauftrag nötig? Kunde informiert?`});
    return result;
  }

  function issuedInvoices(invoices){
    const found=new Map();
    for(const [index,invoice] of (Array.isArray(invoices)?invoices:[]).entries()){
      if(String(invoice.status||"").toLowerCase()!=="issued")continue;
      const identity=documentKey(invoice.sourceId)||`${invoice.projectNumber||invoice.jobId||""}|${invoice.invoiceNumber||`${invoice.runId||""}:${invoice.id??index}`}`;
      found.set(identity,invoice);
    }
    return [...found.values()];
  }
  function allocatePartialInvoices(invoices,state){
    const issued=issuedInvoices(invoices),partials=issued.filter(invoice=>String(invoice.kind||"").toUpperCase()==="TR");
    let partialInvoiceNet=0,regiePartialInvoiceNet=0,linkedRegiePartialNet=0;const issues=[];
    const covered=invoice=>reportSubtotal(state.billedRows.filter(row=>documentKey(invoice.sourceId)&&documentKey(invoice.sourceId)===documentKey(row.billedDocumentId)));
    for(const invoice of partials){
      // Legacy transition invoices were written and reviewed in whole euros.
      // New invoices carry progressBilling and retain their exact cent value.
      const rawNet=number(invoice.net),net=invoice.progressBilling?rawNet:Math.round(rawNet),reports=covered(invoice),explicit=invoice.regieNet;
      if(net<0){issues.push("Eine negative Teilrechnung muss dem Fix- oder Regieanteil zugeordnet werden.");continue;}
      const regie=explicit===undefined||explicit===null?Math.min(net,reports):number(explicit);
      if(regie<0||regie>net+.02){issues.push(`Regieanteil der Teilrechnung ${invoice.invoiceNumber||""} ist nicht plausibel.`);continue;}
      partialInvoiceNet+=net;regiePartialInvoiceNet+=regie;linkedRegiePartialNet+=Math.min(regie,reports);
    }
    const unlinkedBilled=reportSubtotal(state.billedRows.filter(row=>!row.invoice));
    const fallbackRegie=Math.min(Math.max(0,partialInvoiceNet-regiePartialInvoiceNet),unlinkedBilled);
    // Alte WW-Teilrechnungen enthalten nicht immer die technische Bericht-ID.
    // In diesem Fall wird der bereits abgerechnete Berichtswert gegen den
    // vorhandenen TR-Gesamtbetrag verrechnet, statt ihn fälschlich dem Fixteil
    // zuzuschlagen oder ein zweites Mal offen zu lassen.
    regiePartialInvoiceNet+=fallbackRegie;linkedRegiePartialNet+=fallbackRegie;
    const hasClosingInvoice=issued.some(invoice=>String(invoice.kind||"").toUpperCase()==="SR"||String(invoice.kind||"").toUpperCase()==="RE"&&number(invoice.net)>Math.max(covered(invoice),number(invoice.regieNet))+.02);
    return {partialInvoiceNet:cents(partialInvoiceNet),regiePartialInvoiceNet:cents(regiePartialInvoiceNet),linkedRegiePartialNet:cents(linkedRegiePartialNet),
      fixedPartialInvoiceNet:cents(partialInvoiceNet-regiePartialInvoiceNet),hasClosingInvoice,issues};
  }
  function performanceForJob(job={},options={}){
    const c=job.calculation||{},reports=options.reports||job.regieSummary?.reports||[],billing=options.billing||{},state=summarize(reports,billing);
    const allocation=allocatePartialInvoices(billing.invoices,state),plannedRegieHours=Math.max(0,number(c.plannedRegieHours??job.plannedRegieHours));
    const reportHours=state.rows.reduce((sum,row)=>sum+row.hours,0),rawFixedTargetHours=c.fixedCalculatedHours??Math.max(0,number(c.calculatedHours)-plannedRegieHours),fixedTargetHours=number(rawFixedTargetHours)>0?Math.round(number(rawFixedTargetHours)):0,issues=[...allocation.issues];
    if(!options.reports&&!job.regieSummary?.reports&&number(job.regieSummary?.count)>0)issues.push("Regieberichte für die Abrechnung werden noch geladen.");
    if(state.unknownRows.length)issues.push(`${state.unknownRows.length} Regiebericht(e) haben noch keinen eindeutigen Abrechnungsstatus.`);
    const result=calculatePerformance({...allocation,jobId:job.jobId,jobName:job.name||job.jobName,
      actualHours:options.actualHours??c.actualHours,regieHours:options.regieHours??Math.max(number(c.actualRegieHours),reportHours),
      fixedTargetHours,plannedRegieHours,
      contractAmount:c.contractAmount??job.contractAmount,fixedContractAmount:c.kristaAmount,plannedRegieAmount:c.regieBudgetAmount,
      actualRegieAmount:state.totalAmount,billedRegieAmount:state.billedAmount,
      hasClosingInvoice:!!options.settled||allocation.hasClosingInvoice,partial:!!billing.partial,issues,dataUpdatedAt:options.dataUpdatedAt,hoursThroughDate:options.hoursThroughDate});
    result.invoiceSnapshot=invoiceSnapshot(billing.invoices);
    const visibleOpenRows=state.rows.filter(row=>!row.billed);
    result.billedRegieRange=reportRange(state.billedRows);result.openRegieRange=reportRange(visibleOpenRows);
    result.billedRegieCount=state.billedRows.length;result.openRegieCount=visibleOpenRows.length;
    result.openRegieReportIds=visibleOpenRows.map(row=>String(row.report?.id||"").trim()).filter(Boolean);
    return result;
  }
  function invoiceSnapshot(invoices){
    return issuedInvoices(invoices).map(i=>[String(i.sourceId||''),String(i.invoiceNumber||''),String(i.kind||'').toUpperCase(),cents(i.net)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  function prepareInvoiceProposal(p,options={}){
    if(!p||p.aggregated||!p.complete||p.hasClosingInvoice)throw new Error('Bitte zuerst den vollständigen Abrechnungsstand der Einzelakte laden.');
    const kind=String(options.kind||'TR').toUpperCase();
    if(!['TR','RE','SR'].includes(kind))throw new Error('TR, Rechnung oder SR auswählen.');
    const completionPercent=kind==='SR'?100:Number(options.completionPercent??p.completionPercent);
    const regieToInvoice=Number(options.regieToInvoice??p.regieToInvoice);
    if(!Number.isFinite(completionPercent)||completionPercent<0||completionPercent>100)throw new Error('Fertigstellung zwischen 0 und 100 % eingeben.');
    if(!Number.isFinite(regieToInvoice)||regieToInvoice<0||regieToInvoice>10000000)throw new Error('Regiebetrag prüfen.');
    const fixedPerformance=cents(p.fixedContractAmount*completionPercent/100),fixedBalance=cents(fixedPerformance-p.fixedPartialInvoiceNet);
    if(fixedBalance<-.01)throw new Error('Der korrigierte Fixstand liegt unter den bereits geschriebenen TR. Die Rechnungskorrektur bitte gesondert prüfen.');
    const fixedToInvoice=Math.max(0,fixedBalance),amountToInvoice=cents(fixedToInvoice+regieToInvoice);
    const changed=Math.abs(completionPercent-number(p.completionPercent))>.0001||Math.abs(regieToInvoice-number(p.regieToInvoice))>.005;
    const billsAllOpenRegie=regieToInvoice>0&&Math.abs(regieToInvoice-number(p.regieToInvoice))<=.005;
    const reportIdsToBill=billsAllOpenRegie?[...new Set((p.openRegieReportIds||[]).map(id=>String(id||'').trim()).filter(Boolean))]:[];
    return {version:CALCULATION_VERSION,kind,jobId:p.jobId,jobName:p.jobName,completionPercent,fixedPerformance,fixedToInvoice,regieToInvoice:cents(regieToInvoice),amountToInvoice,changed,reportIdsToBill,reason:String(options.reason||'').trim().slice(0,2000),customerNote:'Regieberichte und detaillierte Aufstellung sind im Kundenportal einsehbar.',reviewedAt:new Date().toISOString(),baseline:p};
  }
  function proposalText(p){
    return downloadText(p.baseline)+'\r\n\r\nGeprüfter Vorschlag: '+p.kind+'\r\nFertigstellung: '+formatPercent(p.completionPercent)+(p.kind==='SR'?' · Schlussrechnung mit 100 % Fixauftrag':'')+'\r\nFixleistung: '+formatMoney(p.fixedPerformance)+' − '+formatMoney(p.baseline.fixedPartialInvoiceNet)+' TR = '+formatMoney(p.fixedToInvoice)+'\r\nRegie jetzt: '+formatMoney(p.regieToInvoice)+'\r\nNeue Rechnung netto: '+formatMoney(p.amountToInvoice)+'\r\nKorrektur / Notiz: '+(p.reason||'keine')+'\r\nGeprüft: '+p.reviewedAt;
  }
  function refreshCalculation(host,p){
    if(!host||!p)return;
    const signature=JSON.stringify(p,(key,value)=>key==='calculatedAt'?undefined:value);
    if(host.dataset.signature===signature)return;
    const open=host.querySelector('details')?.open;
    host.dataset.signature=signature;host.innerHTML=renderCalculation(p);
    if(open&&host.querySelector('details'))host.querySelector('details').open=true;
  }
  function aggregatePerformance(values,options={}){
    const fields=["actualHours","regieHours","orderHours","fixedTargetHours","plannedRegieHours","contractAmount","fixedContractAmount","plannedRegieAmount","actualRegieAmount","partialInvoiceNet","fixedPartialInvoiceNet","regiePartialInvoiceNet","linkedRegiePartialNet","additionalRegiePartialNet","billedRegieAmount","regieDeductions","orderPerformance","fixedBalance","regieBalance","fixedToInvoice","regieToInvoice","billablePerformance","performanceLimit","amountToInvoice"];
    const sum={version:CALCULATION_VERSION,aggregated:true,rows:values,jobId:options.jobId||"",jobName:options.jobName||"",dataUpdatedAt:options.dataUpdatedAt||"",calculatedAt:new Date().toISOString(),hasClosingInvoice:values.length>0&&values.every(value=>value.hasClosingInvoice),complete:!options.partial&&values.every(value=>value.complete),partial:!!options.partial,
      warnings:values.flatMap(value=>value.warnings||[]),issues:values.flatMap(value=>value.issues.map(issue=>`${value.jobId}: ${issue}`))};
    for(const field of fields)sum[field]=values.some(value=>value[field]===null)?null:values.reduce((total,value)=>total+number(value[field]),0);
    if(!sum.complete)sum.amountToInvoice=null;
    return sum;
  }
  const escape=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const formatMoney=value=>value===null||value===undefined?"–":Number(value).toLocaleString("de-AT",{style:"currency",currency:"EUR"});
  const formatHours=value=>Number(value||0).toLocaleString("de-AT",{maximumFractionDigits:2});
  const formatPercent=value=>value===null||value===undefined?"–":Number(value).toLocaleString("de-AT",{maximumFractionDigits:2})+" %";
  const formatDate=value=>{const m=String(value||"").slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}.${m[2]}.${m[1]}`:""};
  function calculationLines(p){
    const label=p.jobId?`${p.jobId}${p.jobName?` · ${p.jobName}`:""}`:"Baustelle";
    if(p.aggregated)return [label,"Summe der Einzelprojekt-Abrechnungen",...p.rows.flatMap(row=>["",...calculationLines(row)]),"",`Gesamt noch abzurechnen: ${formatMoney(p.amountToInvoice)} netto`];
    return [label,...(p.hoursThroughDate?[`Abrechnungsstand: Stunden und Regieberichte bis ${formatDate(p.hoursThroughDate)} (abgeschlossener Vortag)`]:[]),`Fixstunden: ${formatHours(p.actualHours)} h gesamt − ${formatHours(p.regieHours)} h Regie = ${formatHours(p.orderHours)} h`,
      `Fertigstellung: ${formatHours(p.orderHours)} h ÷ ${formatHours(p.fixedTargetHours)} h Soll ohne Regie = ${formatPercent(p.orderProgressPercent)} (für den Fixpreis höchstens 100 %)`,
      `Fixleistung: ${formatPercent(p.completionPercent)} × ${formatMoney(p.fixedContractAmount)} Auftrag ohne Regie = ${formatMoney(p.orderPerformance)}`,
      `Fixauftrag: ${formatMoney(p.orderPerformance)} − ${formatMoney(p.fixedPartialInvoiceNet)} geschriebene TR (Fixanteil) = ${formatMoney(p.fixedBalance)} Saldo; jetzt abrechenbar ${formatMoney(p.fixedToInvoice)}`,
      `Regie: ${formatMoney(p.actualRegieAmount)} Berichtswerte − ${formatMoney(p.billedRegieAmount)} bereits verrechnete Berichte − ${formatMoney(p.additionalRegiePartialNet)} weitere Regie-TR = ${formatMoney(p.regieBalance)} Saldo; jetzt abrechenbar ${formatMoney(p.regieToInvoice)}`,
      `Geschriebene TR insgesamt: ${formatMoney(p.partialInvoiceNet)} = ${formatMoney(p.fixedPartialInvoiceNet)} Fixanteil + ${formatMoney(p.regiePartialInvoiceNet)} Regieanteil`,
      `Davon bereits über Berichte berücksichtigt: ${formatMoney(p.linkedRegiePartialNet)} Regie-TR (kein zweiter Abzug)`,
      `Noch abzurechnen: ${formatMoney(p.fixedToInvoice)} Fixauftrag + ${formatMoney(p.regieToInvoice)} Regie = ${formatMoney(p.amountToInvoice)} netto`,
      `Regiestunden: ${formatHours(p.regieHours)} h geleistet / ${formatHours(p.plannedRegieHours)} h angeboten · ${formatHours(p.remainingRegieHours)} h übrig`,
      ...(p.hasClosingInvoice?["Abgeschlossen / Schlussrechnung vorhanden: kein weiterer Abrechnungsvorschlag."]:[]),
      ...(p.warnings||[]).map(w=>`Hinweis: ${w.title}. ${w.text}`),...(p.issues||[]).map(issue=>`Prüfen: ${issue}`)];
  }
  function renderWarnings(p){
    if(!p)return "";
    return [...(p.warnings||[]).map(w=>`<div class="krb-warning"><strong>${escape(w.jobId&&p.aggregated?w.jobId+" · ":"")}${escape(w.title)}</strong><div>${escape(w.text)}</div></div>`),...(p.issues||[]).map(issue=>`<div class="krb-warning">${escape(issue)}</div>`)].join("");
  }
  function compactCalculation(p){
    if(!p)return "Berechnung wird geladen.";
    if(!p.complete)return "Daten / Rechnungszuordnung prüfen · siehe Rechenweg";
    if(p.hasClosingInvoice)return "Abgeschlossen / Schlussrechnung vorhanden";
    if(!p.aggregated&&p.fixedBalance>=0)return `${formatPercent(p.completionPercent)} × ${formatMoney(p.fixedContractAmount)} − ${formatMoney(p.fixedPartialInvoiceNet)} Fix-TR + ${formatMoney(p.regieToInvoice)} offene Regie = ${formatMoney(p.amountToInvoice)}`;
    return `${formatMoney(p.fixedToInvoice)} Fixauftrag nach TR + ${formatMoney(p.regieToInvoice)} Regie nach Abrechnung = ${formatMoney(p.amountToInvoice)}`;
  }
  function renderCalculation(p){
    if(!p)return "";installCalculationUi();
    const range=(value,count)=>value?` ${escape(value)}`:count?` · ${count} Bericht(e)`:"";
    const summary=p.aggregated?"":`<div class="krb-summary"><div><span>Leistungsstand lt. Auftrag</span><small>${escape(p.completionPercent===null||p.completionPercent===undefined?"–":Math.round(p.completionPercent)+" %")} von ${escape(formatMoney(p.fixedContractAmount))}${p.hoursThroughDate?` · bis ${escape(formatDate(p.hoursThroughDate))}`:""}</small><strong>${escape(formatMoney(p.orderPerformance))}</strong></div><div><span>Regie abgerechnet${range(p.billedRegieRange,p.billedRegieCount)}</span><strong>${escape(formatMoney(p.billedRegieAmount))}</strong></div><div><span>Regie offen${range(p.openRegieRange,p.openRegieCount)}</span><strong>${escape(formatMoney(p.regieToInvoice))}</strong></div><div class="total"><span>Leistungssumme gesamt</span><strong>${escape(formatMoney(p.billablePerformance))}</strong></div><div><span>Bereits geschrieben</span><strong>− ${escape(formatMoney(p.partialInvoiceNet))}</strong></div><div class="pay"><span>Jetzt abzurechnen</span><strong>${escape(formatMoney(p.amountToInvoice))} netto</strong></div></div>`;
    const actions=p.complete&&!p.hasClosingInvoice?(p.aggregated?`<button type="button" data-krb-review="${escape(JSON.stringify(p))}">Einzelakte zur Abrechnung wählen</button>`:`<div class="krb-actions"><button type="button" class="primary" data-krb-review="${escape(JSON.stringify(p))}" data-krb-kind="TR">Teilrechnung vorbereiten</button><button type="button" data-krb-review="${escape(JSON.stringify(p))}" data-krb-kind="RE">Rechnung vorbereiten</button><button type="button" data-krb-review="${escape(JSON.stringify(p))}">Prüfen / Schlussrechnung</button></div>`):"";
    return `<div class="krb-calculation">${summary}<small>${escape(compactCalculation(p))}</small><details><summary>Rechenweg · Fixauftrag und Regie</summary><div class="krb-lines">${calculationLines(p).map(line=>`<div>${escape(line)||"&nbsp;"}</div>`).join("")}</div><button type="button" data-krb-download="${escape(JSON.stringify(p))}">Rechenweg herunterladen (.txt)</button><small>Berechnet: ${escape(new Date(p.calculatedAt).toLocaleString("de-AT"))}${p.dataUpdatedAt?` · Datenstand: ${escape(new Date(p.dataUpdatedAt).toLocaleString("de-AT"))}`:""}</small></details>${renderWarnings(p)}${actions}</div>`;
  }
  function downloadText(p){
    return ["KRISTINE · Abrechnung nach Leistungsstand (netto)",`Berechnet: ${p.calculatedAt}`,p.dataUpdatedAt?`Datenstand: ${p.dataUpdatedAt}`:"Datenstand: aktuell in der Akte angezeigte Stunden, Berichte und Rechnungen", "",...calculationLines(p),"","Geschriebene Teilrechnungen zählen unabhängig vom Zahlungseingang. Entwürfe werden nicht abgezogen.","Die Fertigstellung wird aus dem Stundenverbrauch geschätzt und muss fachlich geprüft werden."].join("\r\n");
  }
  function installCalculationUi(){
    if(typeof document==="undefined"||document.getElementById("krbCalculationCss"))return;
    const style=document.createElement("style");style.id="krbCalculationCss";style.textContent=".krb-calculation{margin:12px 0;font-variant-numeric:tabular-nums}.krb-calculation>small,.krb-calculation details>small{display:block;color:#68736a;font-size:12px;line-height:1.5}.krb-calculation summary{cursor:pointer;font-weight:700;padding:10px 0;color:#315e3e}.krb-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid #d6dfcf;border-radius:12px;overflow:hidden;margin-bottom:12px}.krb-summary>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 14px;padding:11px 13px;border-bottom:1px solid #e5e9e1}.krb-summary>div:nth-child(odd){border-right:1px solid #e5e9e1}.krb-summary span{font-weight:700}.krb-summary small{grid-column:1;color:#68736a}.krb-summary strong{grid-column:2;grid-row:1/3;align-self:center}.krb-summary .total,.krb-summary .pay{background:#f1f7ee}.krb-summary .pay strong{color:#276a3b;font-size:1.08em}.krb-lines{font-size:13px;line-height:1.7;background:#f5f8f2;border:1px solid #d6dfcf;border-radius:9px;padding:14px;overflow-wrap:anywhere}.krb-warning{background:#fff5de;border:1px solid #e5c987;border-radius:8px;margin:9px 0;padding:11px 14px;font-size:13px;color:#76551b}.krb-actions{display:flex;gap:8px;flex-wrap:wrap}.krb-calculation button{margin:10px 0;border:1px solid #c5d3be;border-radius:8px;padding:8px 12px;background:white;color:#315e3e;font:inherit;font-weight:700;cursor:pointer}.krb-calculation button.primary{background:#367b49;color:white;border-color:#367b49}@media(max-width:650px){.krb-summary{grid-template-columns:1fr}.krb-summary>div:nth-child(odd){border-right:0}}";document.head.appendChild(style);
    document.addEventListener("click",async event=>{const review=event.target.closest?.("[data-krb-review]");if(review){const p=JSON.parse(review.dataset.krbReview),kind=review.dataset.krbKind||"";if(!window.KristaInvoiceReview){review.disabled=true;try{await new Promise((resolve,reject)=>{const script=document.createElement("script");script.src="/public/ui/progress-invoice-review.js?v=20260915-progress-2";script.onload=resolve;script.onerror=reject;document.head.appendChild(script)})}catch{review.disabled=false;review.textContent="Nicht geladen · erneut versuchen";return}review.disabled=false}window.KristaInvoiceReview.open(p,{kind});return}const button=event.target.closest?.("[data-krb-download]");if(!button)return;const value=JSON.parse(button.dataset.krbDownload),blob=new Blob(["\uFEFF"+downloadText(value)],{type:"text/plain;charset=utf-8"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`Rechenweg_${String(value.jobId||"Baustelle").replace(/[^a-zA-Z0-9_-]/g,"_")}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000)});
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
      const invoice=invoiceBySourceId.get(billedKey)||null,manualStatus=String(report?.billingStatus||"").toLowerCase();
      const invoiceUnissued=invoice&&["draft","cancelled"].includes(String(invoice.status||"").toLowerCase()),automaticBilled=!invoiceUnissued&&Boolean(billedKey);
      const billed=manualStatus==="billed"||(manualStatus!=="open"&&automaticBilled),open=!billed;
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
      openAmount:reportSubtotal(openRows),
      openHours:openRows.reduce((sum,row)=>sum+row.hours,0),
      billedAmount:reportSubtotal(billedRows),
      billedHours:billedRows.reduce((sum,row)=>sum+row.hours,0),
      unknownAmount:reportSubtotal(unknownRows),
      totalAmount:reportSubtotal(rows),
    };
  }

  function reportSubtotal(rows){
    let labor=0,material=0,other=0;
    for(const row of rows||[]){
      const report=row.report||row,materialValue=report?.materialCost??report?.materialTotal;
      if(report?.laborCost!==undefined&&materialValue!==undefined){labor+=number(report.laborCost);material+=number(materialValue)}
      else other+=number(row.amount??reportAmount(report));
    }
    return cents(labor+Math.round(material)+other);
  }

  function reportRange(rows){
    const values=[...new Set((rows||[]).map(row=>reportSequence(row.report||row)).filter(Boolean).map(Number).filter(Number.isFinite))].sort((a,b)=>a-b);
    if(!values.length)return "";
    const parts=[];let start=values[0],last=values[0];
    for(const value of values.slice(1)){if(value===last+1){last=value;continue}parts.push(start===last?String(start):`${start}–${last}`);start=last=value}
    parts.push(start===last?String(start):`${start}–${last}`);return parts.join(", ");
  }

  return {formatMoney,invoiceSnapshot,prepareInvoiceProposal,proposalText,refreshCalculation,summarize,calculatePerformance,performanceForJob,aggregatePerformance,allocatePartialInvoices,issuedInvoices,renderCalculation,renderWarnings,compactCalculation,calculationLines,downloadText,CALCULATION_VERSION,dedupeReports,reportDedupeKey,documentKey,reportAmount,reportRange};
});
