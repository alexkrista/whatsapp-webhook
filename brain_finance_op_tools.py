# coding: utf-8
"""OP-Werkzeuge: Sortierung, Gruppierung, Skontoanzeige und Ausdrucke.

Die bestehende Zahlungslogik bleibt unangetastet. Dieses Modul arbeitet nur auf
der HTML-Oberflaeche und nutzt weiterhin /incoming/payment-open-items als einzige
Datenquelle. Checkboxen und SEPA-Vorbereitung der bestehenden Seite bleiben damit
voll funktionsfaehig.
"""


def install(ns):
    app = ns.get("app")
    if app is None or getattr(app, "_krista_op_tools", False):
        return

    from flask import request

    css = r'''
<style id="kristaOpToolsCss">
.op-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px;padding:10px;border:1px solid var(--line);border-radius:11px;background:#11161b}.op-tools label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}.op-tools select,.op-tools button{min-height:36px}.op-tools .print{font-weight:850}.op-supplier-group{margin:8px 0 15px;border:1px solid #303943;border-radius:11px;overflow:hidden}.op-supplier-head{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:9px 11px;background:#11161b}.op-supplier-head strong{font-size:13px}.op-supplier-head span{color:var(--muted);font-size:11px}.op-skonto{margin-top:4px;color:#8ed2a2;font-size:11px;line-height:1.25}.op-skonto.expired{color:var(--muted)}.op-skonto.soon{color:var(--warn)}
#opPrintReport{display:none}
@media print{
 body>*{display:none!important}#opPrintReport{display:block!important;color:#111;background:#fff;font-family:Arial,sans-serif;padding:8mm}.op-print-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;border-bottom:2px solid #111;padding-bottom:4mm;margin-bottom:4mm}.op-print-head h1{margin:0;font-size:20pt}.op-print-head .meta{text-align:right;font-size:9pt}.op-print-summary{display:flex;gap:8mm;flex-wrap:wrap;margin:0 0 4mm;font-size:10pt}.op-print-summary strong{font-size:12pt}.op-print-table{width:100%;border-collapse:collapse;font-size:8.5pt}.op-print-table th{padding:2mm 1.5mm;text-align:left;border-bottom:1px solid #333}.op-print-table td{padding:2mm 1.5mm;border-bottom:1px solid #ddd;vertical-align:top}.op-print-table .money{text-align:right;white-space:nowrap}.op-print-group td{padding-top:4mm;font-size:10pt;font-weight:700;border-bottom:1px solid #777}.op-print-subtotal td{font-weight:700;border-top:1px solid #777}.op-print-skonto{font-size:7.5pt;color:#333}.op-print-footer{margin-top:4mm;font-size:8pt;color:#555}
}
@media(max-width:760px){.op-tools{align-items:stretch}.op-tools label{width:100%;justify-content:space-between}.op-tools select{flex:1}.op-tools button{flex:1}}
</style>
'''

    script = r'''
<div id="opPrintReport"></div>
<script id="kristaOpToolsJs">
(function(){
  const money=(n,c='EUR')=>{try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0))}catch(_){return Number(n||0).toFixed(2)+' '+c}};
  const date=s=>{const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]+'.'+m[1]:(s||'–')};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key=x=>String(x?.source||'')+'|'+String(x?.id||'');
  const today=()=>{const d=new Date(),off=d.getTimezoneOffset();return new Date(d.getTime()-off*60000).toISOString().slice(0,10)};
  const daysTo=s=>{if(!s)return null;const a=new Date(today()+'T12:00:00'),b=new Date(String(s).slice(0,10)+'T12:00:00');if(Number.isNaN(b.getTime()))return null;return Math.round((b-a)/86400000)};
  let data={items:[],directDebit:[],unclassified:[]},payNodes=[],busy=false,refreshTimer=0,muteUntil=0;

  function total(rows){const by={};(rows||[]).forEach(x=>{const c=x.currency||'EUR';by[c]=(by[c]||0)+Number(x.paymentAmount??x.amount??0)});return Object.entries(by).map(([c,n])=>money(n,c)).join(' · ')||money(0)}
  function sortRows(rows,mode){rows=[...(rows||[])];const due=x=>String(x.dueDate||x.expectedDebitDate||x.invoiceDate||'9999-12-31'),supplier=x=>String(x.supplier||'').toLocaleLowerCase('de');if(mode==='amount_desc')rows.sort((a,b)=>Number(b.paymentAmount??b.amount??0)-Number(a.paymentAmount??a.amount??0)||due(a).localeCompare(due(b)));else if(mode==='amount_asc')rows.sort((a,b)=>Number(a.paymentAmount??a.amount??0)-Number(b.paymentAmount??b.amount??0)||due(a).localeCompare(due(b)));else if(mode==='supplier')rows.sort((a,b)=>supplier(a).localeCompare(supplier(b),'de')||due(a).localeCompare(due(b)));else rows.sort((a,b)=>due(a).localeCompare(due(b))||supplier(a).localeCompare(supplier(b),'de')||Number(a.amount||0)-Number(b.amount||0));return rows}

  function skontoHtml(x){if(!x?.skontoEnabled)return '';const p=Number(x.skontoPercent||0),disc=Number(x.skontoAmount!=null?x.skontoAmount:(p?Number(x.amount||0)*p/100:0)),pay=Math.max(0,Number(x.amount||0)-disc),d=daysTo(x.skontoDueDate);let dayText='';let cls='';if(d!=null){if(d<0){dayText=' · abgelaufen';cls=' expired'}else if(d===0){dayText=' · heute';cls=' soon'}else{dayText=' · noch '+d+' Tag'+(d===1?'':'e');if(d<=3)cls=' soon'}}const pct=p?String(p).replace('.',',')+' % · ':'';const until=x.skontoDueDate?' · bis '+date(x.skontoDueDate):'';return `<div class="op-skonto${cls}">Skonto ${esc(pct)}${esc(money(disc,x.currency))} · Zahlbetrag ${esc(money(pay,x.currency))}${esc(until+dayText)}</div>`}

  function installTools(){
    const section=document.getElementById('rows')?.closest('section.card');if(!section||document.getElementById('opTools'))return;
    const tools=document.createElement('div');tools.id='opTools';tools.className='op-tools';tools.innerHTML=`<label>Sortierung <select id="opSort"><option value="due">Fälligkeit · älteste zuerst</option><option value="amount_desc">Betrag · hoch → niedrig</option><option value="amount_asc">Betrag · niedrig → hoch</option><option value="supplier">Lieferant · A–Z</option></select></label><label>Ansicht <select id="opView"><option value="list">Liste</option><option value="supplier">Nach Lieferant gruppiert</option></select></label><button class="print" type="button" id="opPrintDue">🖨 OP · Fälligkeit</button><button class="print" type="button" id="opPrintSupplier">🖨 OP · Lieferanten</button><button class="print" type="button" id="opPrintDebit">🖨 Einzüge</button>`;
    const title=section.querySelector('.section-title');if(title)title.insertAdjacentElement('afterend',tools);else section.prepend(tools);
    document.getElementById('opSort').onchange=applyPayView;document.getElementById('opView').onchange=applyPayView;
    document.getElementById('opPrintDue').onclick=()=>printReport('pay_due');document.getElementById('opPrintSupplier').onclick=()=>printReport('pay_supplier');document.getElementById('opPrintDebit').onclick=()=>printReport('debit');
  }

  function collectPayNodes(){const box=document.getElementById('rows');if(!box)return;const found=[...box.querySelectorAll('.row')].filter(n=>n.querySelector('input[data-s]'));if(found.length)payNodes=found}
  function decoratePayNodes(){const map=new Map((data.items||[]).map(x=>[key(x),x]));payNodes.forEach(node=>{const cb=node.querySelector('input[data-s]'),x=map.get(String(cb?.dataset.s||''));if(!x)return;node.dataset.opKey=key(x);const amountCell=[...node.children][4];if(amountCell&&!amountCell.querySelector('.op-skonto'))amountCell.insertAdjacentHTML('beforeend',skontoHtml(x))})}

  function applyPayView(){if(busy)return;const box=document.getElementById('rows');if(!box||!payNodes.length)return;busy=true;muteUntil=Date.now()+400;try{const map=new Map((data.items||[]).map(x=>[key(x),x])),mode=document.getElementById('opSort')?.value||'due',view=document.getElementById('opView')?.value||'list';const ordered=sortRows(payNodes.map(n=>map.get(n.dataset.opKey)).filter(Boolean),mode);box.innerHTML='';if(view==='supplier'){const groups=new Map();ordered.forEach(x=>{const k=String(x.supplier||'Ohne Lieferant');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)});for(const [supplier,items] of groups){const wrap=document.createElement('div');wrap.className='op-supplier-group';wrap.innerHTML=`<div class="op-supplier-head"><strong>${esc(supplier)}</strong><span>${items.length} Rechnung(en) · ${esc(total(items))}</span></div>`;items.forEach(x=>{const node=payNodes.find(n=>n.dataset.opKey===key(x));if(node)wrap.appendChild(node)});box.appendChild(wrap)}}else ordered.forEach(x=>{const node=payNodes.find(n=>n.dataset.opKey===key(x));if(node)box.appendChild(node)})}finally{busy=false}}

  function debitStatus(x){if(x.legacyReviewPending)return `<span class="dd-review"><button type="button" data-dd-legacy="paid" data-source="${esc(x.source)}" data-id="${esc(x.id)}">✓ Eingezogen</button><button type="button" data-dd-legacy="open" data-source="${esc(x.source)}" data-id="${esc(x.id)}">Noch nicht</button></span>`;if(x.approvalStatus==='blocked')return '<span class="dd-blocked">⛔ gesperrt · Einzug beobachten</span>';if(x.approvalStatus==='pending')return '<span class="dd-warn">⏳ Freigabe offen · wartet auf CAMT</span>';return '<span class="dd-wait">↙ erwartet · wartet auf CAMT</span>'}
  function renderDebits(){const box=document.getElementById('directDebitRows'),meta=document.getElementById('directDebitMeta');if(!box||!meta)return;muteUntil=Math.max(muteUntil,Date.now()+400);const rows=sortRows(data.directDebit||[],'due');meta.innerHTML=`<strong>${rows.length} erwartete Einzüge</strong>${rows.length?' · '+esc(total(rows)):''} · älteste Fälligkeit zuerst`;if(!rows.length){box.innerHTML='<div class="empty">Keine erwarteten Einzüge.</div>';return}const groups=new Map();rows.forEach(x=>{const k=String(x.supplier||'Ohne Lieferant');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)});box.innerHTML=[...groups.entries()].map(([supplier,items])=>`<div class="dd-group"><div class="dd-head"><strong>${esc(supplier)}</strong><span>${items.length} Rechnung(en) · ${esc(total(items))}</span></div>${items.map(x=>`<div class="dd-row"><div><strong>${esc(date(x.expectedDebitDate||x.dueDate))}</strong><div class="sub">erwarteter Einzug</div></div><div><div>${esc(x.invoiceNumber||'–')}</div><div class="sub">${esc(x.source||'')}</div></div><div class="amount">${esc(money(x.amount,x.currency))}</div><div>${debitStatus(x)}</div><div class="sub">${x.wwStatusRaw?'WW: '+esc(x.wwStatusRaw):''}</div><div>${x.path?`<a class="pdf" href="/pdf?path=${encodeURIComponent(x.path)}" target="_blank">PDF</a>`:'–'}</div></div>`).join('')}</div>`).join('')}

  function statusText(x){if(x.paymentStatus==='sepa_submitted')return 'SEPA übergeben';if(x.approvalStatus==='approved')return 'freigegeben';if(x.approvalStatus==='reduced')return 'gekürzt';if(x.approvalStatus==='blocked')return 'gesperrt';if(x.approvalStatus==='pending')return 'Freigabe offen';return x.source==='WinWorker'?'Altbestand':String(x.paymentStatus||'offen')}
  function skontoText(x){if(!x.skontoEnabled)return '';const p=Number(x.skontoPercent||0),disc=Number(x.skontoAmount!=null?x.skontoAmount:(p?Number(x.amount||0)*p/100:0)),d=daysTo(x.skontoDueDate);let t=(p?String(p).replace('.',',')+' % · ':'')+money(disc,x.currency);if(x.skontoDueDate)t+=' · bis '+date(x.skontoDueDate);if(d!=null)t+=d<0?' · abgelaufen':d===0?' · heute':' · '+d+' Tage';return t}
  function printTable(rows,grouped,title){const sorted=sortRows(rows,grouped?'supplier':'due');let body='';if(grouped){const groups=new Map();sorted.forEach(x=>{const k=String(x.supplier||'Ohne Lieferant');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)});for(const [supplier,items] of groups){body+=`<tr class="op-print-group"><td colspan="6">${esc(supplier)} · ${esc(total(items))}</td></tr>`;for(const x of items)body+=printRow(x);body+=`<tr class="op-print-subtotal"><td colspan="4">Zwischensumme ${esc(supplier)}</td><td class="money">${esc(total(items))}</td><td></td></tr>`}}else body=sorted.map(printRow).join('');return `<h2>${esc(title)}</h2><table class="op-print-table"><thead><tr><th>Fällig</th><th>Lieferant</th><th>Rechnung</th><th>Skonto</th><th class="money">Betrag</th><th>Status</th></tr></thead><tbody>${body}</tbody></table>`}
  function printRow(x){return `<tr><td>${esc(date(x.expectedDebitDate||x.dueDate||x.invoiceDate))}</td><td>${esc(x.supplier||'–')}</td><td>${esc(x.invoiceNumber||'–')}</td><td><span class="op-print-skonto">${esc(skontoText(x)||'–')}</span></td><td class="money">${esc(money(x.paymentAmount??x.amount,x.currency))}</td><td>${esc(x.paymentMethod==='direct_debit'?'Einzug erwartet':statusText(x))}</td></tr>`}
  function printReport(kind){const report=document.getElementById('opPrintReport');if(!report)return;const now=new Intl.DateTimeFormat('de-AT',{dateStyle:'short',timeStyle:'short'}).format(new Date());let title='OP aktuell',rows=[],grouped=false;if(kind==='pay_supplier'){title='Zu zahlende Rechnungen · nach Lieferant';rows=data.items||[];grouped=true}else if(kind==='debit'){title='Erwartete Einzüge';rows=data.directDebit||[];grouped=true}else{title='Zu zahlende Rechnungen · nach Fälligkeit';rows=data.items||[]};report.innerHTML=`<div class="op-print-head"><div><div>KRISTINE · The Brain</div><h1>${esc(title)}</h1></div><div class="meta">Stand ${esc(now)}<br>${rows.length} Position(en)</div></div><div class="op-print-summary"><div>Gesamt<br><strong>${esc(total(rows))}</strong></div></div>${printTable(rows,grouped,title)}<div class="op-print-footer">KRISTINE · automatisch aus dem aktuellen OP-Stand erzeugt</div>`;setTimeout(()=>window.print(),30)}

  async function refresh(){if(busy)return;try{const r=await fetch('/incoming/payment-open-items',{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'OP konnte nicht geladen werden');data=d;collectPayNodes();decoratePayNodes();applyPayView();renderDebits()}catch(e){console.error('OP-Werkzeuge:',e)}}
  function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,120)}

  function init(){installTools();const pay=document.getElementById('rows'),dd=document.getElementById('directDebitRows');if(pay)new MutationObserver(()=>{if(!busy&&Date.now()>=muteUntil)scheduleRefresh()}).observe(pay,{childList:true,subtree:true});if(dd)new MutationObserver(()=>{if(!busy&&Date.now()>=muteUntil)scheduleRefresh()}).observe(dd,{childList:true,subtree:true});setTimeout(refresh,180)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
</script>
'''

    @app.after_request
    def krista_op_tools(response):
        try:
            if request.path != "/incoming/payments":
                return response
            content_type = str(response.headers.get("Content-Type") or "").lower()
            if "text/html" not in content_type:
                return response
            html = response.get_data(as_text=True)
            if "kristaOpToolsJs" in html:
                return response
            if "</head>" in html:
                html = html.replace("</head>", css + "</head>", 1)
            if "</body>" in html:
                html = html.replace("</body>", script + "</body>", 1)
            response.set_data(html)
            response.headers["Content-Type"] = "text/html; charset=utf-8"
            return response
        except Exception as exc:
            print("⚠ OP-Werkzeuge konnten nicht eingesetzt werden:", exc)
            return response

    app._krista_op_tools = True
    print("✅ OP-Werkzeuge: Sortierung · Lieferantengruppen · Skonto · Ausdrucke")
