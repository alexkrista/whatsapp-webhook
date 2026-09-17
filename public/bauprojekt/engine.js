(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.Bauprojekt=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DAY=86400000, kinds=['FS','SS','FF','SF'];
  const filled=v=>v!==''&&v!==null&&v!==undefined;
  const round=v=>Math.round((v+Number.EPSILON)*100)/100;
  function number(v,label,min=0){if(!filled(v)||!Number.isFinite(Number(v))||Number(v)<min)throw Error(label+' fehlt oder ist ungültig.');return Number(v);}
  function date(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('Datum ungültig: '+s);const d=Date.parse(s+'T00:00:00Z');if(!Number.isFinite(d)||iso(d)!==s)throw Error('Datum ungültig: '+s);return d;}
  const iso=d=>new Date(d).toISOString().slice(0,10);
  function calendar(p){const days=p.workdays||[1,2,3,4,5];if(!Array.isArray(days)||!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6))throw Error('Mindestens einen gültigen Arbeitstag wählen.');const holiday=new Set((p.holidays||[]).map(s=>iso(date(s))));return d=>days.includes(new Date(d).getUTCDay())&&!holiday.has(iso(d));}
  function shift(d,n,working){const dir=n<0?-1:1;let count=Math.abs(n),guard=0;while(count){d+=dir*DAY;if(working(d))count--;if(++guard>20000)throw Error('Termin außerhalb des unterstützten Zeitraums.');}return d;}
  function roll(d,working,dir=1){let guard=0;while(!working(d)){d+=dir*DAY;if(++guard>20000)throw Error('Arbeitskalender ohne erreichbaren Arbeitstag.');}return d;}
  function cost(p){
    const source=p.positions||[],basis=round(source.filter(r=>/^[1-6]\./.test(r.code)&&filled(r.amount)).reduce((sum,r)=>sum+round(number(r.amount,'Bezugsbetrag')),0));
    const effective=source.map(r=>{if(!filled(r.percentOf1to6))return r;if(!/^[79]\./.test(r.code))throw Error('Prozentansatz auf Gruppen 1–6 ist nur in Gruppe 7 oder 9 zulässig.');return {...r,amount:round(basis*number(r.percentOf1to6,'Prozentansatz')/100)};});
    const rows=effective.filter(r=>filled(r.amount)).map(r=>({...r,amount:round(number(r.amount,r.name+' Kosten')),forecast:round(filled(r.forecast)?number(r.forecast,'Prognose'):number(r.amount,'Kosten')),order:filled(r.order)?round(number(r.order,'Auftrag')):null,actual:filled(r.actual)?round(number(r.actual,'Abrechnung')):null}));const groups={};rows.forEach(r=>{const k=String(r.code||'')[0];if(!/^[0-9]$/.test(k))throw Error('Kostengruppe fehlt bei '+r.name);const g=groups[k]||(groups[k]={key:k,amount:0,forecast:0,order:0,actual:0,rows:[]});for(const field of ['amount','forecast','order','actual'])g[field]=round(g[field]+(r[field]||0));g.rows.push(r);});const sum=field=>round(rows.reduce((a,r)=>a+(r[field]||0),0));const net=sum('amount'),vat=number(p.vat??0.2,'Umsatzsteuer');return {rows,groups,basis1to6:basis,net,forecast:sum('forecast'),order:sum('order'),actual:sum('actual'),vat:round(net*vat),gross:round(net*(1+vat))};}
  function duration(task,position,p){
    if(task.kind==='milestone')return {days:0,hours:0};
    if(filled(task.days))return {days:Math.ceil(number(task.days,'Dauer',1)),hours:null};
    if(!position)throw Error('Manuelle Dauer fehlt bei '+task.name);
    const amount=number(filled(position.forecast)?position.forecast:position.amount,'Kosten'),share=number(position.material??0,'Material-/Fremdkostenanteil');if(share>=1)throw Error('Material-/Fremdkostenanteil muss kleiner als 100 % sein.');
    const rate=number(position.rate,'Stundenansatz',0.01),crew=number(task.crew??position.crew,'Mannschaft',1),hoursPerDay=number(p.hoursPerDay,'Stunden je Person und Arbeitstag',0.1);
    const hours=position.method==='split'?amount*(1-share)/rate:amount/rate;
    return {days:Math.max(1,Math.ceil(hours/(crew*hoursPerDay))),hours:round(hours)};
  }
  function schedule(p){
    const costs=cost(p),positions=new Map(costs.rows.map(r=>[r.id,r])),working=calendar(p),projectStart=roll(date(p.start),working),all=p.tasks||[];
    const ids=new Set();for(const t of all){if(!t.id||ids.has(t.id))throw Error('Vorgangs-ID fehlt oder ist doppelt.');ids.add(t.id);}
    const active=all.filter(t=>t.positionId?positions.has(t.positionId):t.enabled!==false),map=new Map(active.map(t=>[t.id,t])),result=new Map(),state=new Map();
    function visit(id){if(result.has(id))return result.get(id);if(state.get(id)===1)throw Error('Zyklische Abhängigkeit bei '+id);const t=map.get(id);if(!t)throw Error('Vorgänger '+id+' fehlt oder seine Kostenposition ist leer.');state.set(id,1);
      if(t.positionId&&t.kind!=='milestone'&&!filled(t.days)&&active.filter(x=>x.positionId===t.positionId&&x.kind!=='milestone').length>1)throw Error('Bei mehreren Einsätzen die Dauer je Schritt festlegen: '+t.name);
      const d=duration(t,positions.get(t.positionId),p),ownWorking=t.calendarDays?()=>true:working;
      let start=Math.max(projectStart,t.notBefore?date(t.notBefore):projectStart);start=roll(start,ownWorking);
      const deps=t.dependencies||[];
      for(const dep of deps){if(!kinds.includes(dep.type))throw Error('Unbekannte Verknüpfung '+dep.type);const pred=visit(dep.id),lag=number(dep.lag??0,'Zeitabstand',-Infinity);if(!Number.isInteger(lag))throw Error('Zeitabstand muss ganze Tage enthalten.');let boundary;
        // Inclusive date convention: finish/start = next workday, milestones occur at start of day.
        if(dep.type==='FS')boundary=pred.days===0?pred.start:shift(pred.end,1,ownWorking);else if(dep.type==='SS')boundary=pred.start;else if(dep.type==='FF')boundary=pred.end;else boundary=pred.start;
        if(lag)boundary=dep.calendarLag?boundary+lag*DAY:shift(boundary,lag,working);
        if(dep.type==='FF'||dep.type==='SF')boundary=shift(roll(boundary,ownWorking),-Math.max(0,d.days-1),ownWorking);
        start=Math.max(start,boundary);
      }
      start=roll(start,ownWorking);const delay=number(t.delay??0,'Verschiebung');if(!Number.isInteger(delay))throw Error('Verschiebung muss ganze Arbeitstage enthalten.');start=shift(start,delay,working);
      const end=shift(start,Math.max(0,d.days-1),ownWorking),predBlocked=deps.some(x=>result.get(x.id).blocked),blocked=predBlocked||(t.gate===true&&t.released!==true);
      const base=p.baseline?.tasks?.[id],delta=base?Math.round((end-date(base.end))/DAY):0;
      const row={...t,...d,start,end,startDate:iso(start),endDate:iso(end),blocked,delta};result.set(id,row);state.set(id,2);return row;
    }
    active.forEach(t=>visit(t.id));const rows=active.map(t=>result.get(t.id)),end=rows.length?Math.max(...rows.map(t=>t.end)):projectStart;
    return {rows,end:iso(end),start:iso(projectStart),blocked:rows.filter(t=>t.blocked).length,delta:p.baseline?Math.round((end-date(p.baseline.end))/DAY):0,unplanned:costs.rows.filter(r=>!active.some(t=>t.positionId===r.id))};
  }
  function phase(t,p){return t.phase||((p.positions||[]).find(r=>r.id===t.positionId)?.code?.startsWith('7.')?'planning':'construction');}
  function planRows(p,{includeSupport=true}={}){const s=schedule(p),tasks=s.rows.filter(t=>includeSupport||phase(t,p)==='construction'),construction=tasks.filter(t=>phase(t,p)==='construction');
    const span=(id,name,members,summaryKind)=>{const start=Math.min(...members.map(t=>t.start)),end=Math.max(...members.map(t=>t.end));return {id,name,start,end,startDate:iso(start),endDate:iso(end),days:Math.round((end-start)/DAY)+1,delta:0,blocked:members.some(t=>t.blocked),members,summaryKind};};
    const rows=[];if(construction.length)rows.push(span('@construction','Gesamte Bauzeit',construction,'project'));const done=new Set();for(const t of tasks){if(t.positionId&&!done.has(t.positionId)){done.add(t.positionId);const siblings=tasks.filter(x=>x.positionId===t.positionId);if(siblings.length>1)rows.push(span('@group:'+t.positionId,(p.positions.find(r=>r.id===t.positionId)?.name||t.name)+' – Einsätze gesamt',siblings,'group'));}rows.push(t);}return {...s,rows,taskRows:tasks};
  }
  function baseline(p){const s=schedule(p);return {createdAt:new Date().toISOString(),end:s.end,tasks:Object.fromEntries(s.rows.map(t=>[t.id,{start:t.startDate,end:t.endDate}]))};}
  function tenderTotal(lines){return round((lines||[]).reduce((a,l)=>a+round(number(l.quantity,'Menge')*number(l.unitPrice,'Einheitspreis')),0));}
  function validate(p){if(!p||p.schemaVersion!==1||typeof p.name!=='string'||!p.name.trim())throw Error('Projektname oder Datenversion fehlt.');if(!Array.isArray(p.positions)||p.positions.length>1500||!Array.isArray(p.tasks)||p.tasks.length>1500)throw Error('Ungültige Projektgröße.');const ids=new Set();p.positions.forEach(r=>{if(!r.id||ids.has(r.id))throw Error('Positions-ID fehlt oder ist doppelt.');ids.add(r.id);});cost(p);schedule(p);return p;}
  return {filled,round,date,iso,calendar,shift,roll,cost,duration,schedule,phase,planRows,baseline,tenderTotal,validate};
});
