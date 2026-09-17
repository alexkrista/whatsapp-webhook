# coding: utf-8
"""Anklickbare Kreditoren-OP mit Mahnstufe und mitüberweisbaren Spesen."""
from __future__ import annotations


def install(ns):
    import brain_finance_runtime as runtime

    original = runtime.payments_page
    if getattr(original, "_krista_creditor_details_ui", False):
        return

    css = r'''
<style id="kristaCreditorDetailsCss">
#rows .row[data-creditor-key],#unknown .row[data-creditor-key]{cursor:pointer;transition:background .15s,border-color .15s}
#rows .row[data-creditor-key]:hover,#unknown .row[data-creditor-key]:hover{background:#182019;border-color:#4d7659}
.creditor-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}.creditor-tag{border:1px solid #65512d;background:#2a2112;color:#f2cf83;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:800}
.creditor-modal{position:fixed;inset:0;z-index:3000;background:#000b;display:none;place-items:center;padding:18px}.creditor-modal.open{display:grid}.creditor-dialog{width:min(560px,100%);background:#12171d;border:1px solid #35404b;border-radius:18px;box-shadow:0 24px 80px #000;padding:20px}.creditor-dialog h2{margin:0 0 4px}.creditor-dialog-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.creditor-dialog label{display:grid;gap:6px;color:#aeb8c2;font-size:12px;font-weight:800}.creditor-dialog input,.creditor-dialog select,.creditor-dialog textarea{width:100%;box-sizing:border-box;background:#0d1217;color:#f5f7f8;border:1px solid #37424d;border-radius:9px;padding:10px;font:inherit}.creditor-dialog textarea{min-height:85px;resize:vertical}.creditor-dialog .wide{grid-column:1/-1}.creditor-total{margin-top:14px;padding:12px;border:1px solid #35563e;border-radius:10px;background:#132018;display:flex;justify-content:space-between;gap:12px}.creditor-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}.creditor-actions button{padding:10px 15px;border-radius:9px;border:1px solid #45515d;background:#202833;color:#fff;font-weight:850}.creditor-actions .save{background:#39764d;border-color:#4d9464}.creditor-error{color:#ff9b91;min-height:20px;margin-top:8px}@media(max-width:520px){.creditor-dialog-grid{grid-template-columns:1fr}.creditor-dialog .wide{grid-column:1}}
</style>
'''
    modal = r'''
<div class="creditor-modal" id="creditorModal" aria-hidden="true"><div class="creditor-dialog" role="dialog" aria-modal="true" aria-labelledby="creditorTitle">
  <h2 id="creditorTitle">Kreditoren-OP</h2><div class="sub" id="creditorMeta"></div>
  <div class="creditor-dialog-grid">
    <label>Mahnstufe<select id="creditorDunning"><option value="0">keine</option><option value="1">Mahnstufe 1</option><option value="2">Mahnstufe 2</option><option value="3">Mahnstufe 3</option><option value="4">Mahnstufe 4</option><option value="5">Mahnstufe 5</option></select></label>
    <label>Mahnspesen €<input id="creditorFees" type="number" min="0" max="10000" step="0.01" inputmode="decimal"></label>
    <label class="wide">Notiz<textarea id="creditorNote" maxlength="1000" placeholder="z. B. Mahnung vom …"></textarea></label>
  </div>
  <div class="creditor-total"><span>Wird überwiesen</span><strong id="creditorTotal">–</strong></div>
  <div class="creditor-error" id="creditorError"></div>
  <div class="creditor-actions"><button type="button" id="creditorCancel">Abbrechen</button><button type="button" class="save" id="creditorSave">Speichern</button></div>
</div></div>
'''
    script = r'''
<script id="kristaCreditorDetailsV1">
(()=>{
 const modal=document.getElementById('creditorModal'),title=document.getElementById('creditorTitle'),meta=document.getElementById('creditorMeta'),level=document.getElementById('creditorDunning'),fees=document.getElementById('creditorFees'),note=document.getElementById('creditorNote'),total=document.getElementById('creditorTotal'),error=document.getElementById('creditorError'),save=document.getElementById('creditorSave');let items=new Map(),current=null;
 const money=(n,c='EUR')=>new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0));
 const key=x=>`${x.source}|${x.id}`;
 const tags=x=>{const a=[];if(Number(x.dunningLevel||0)>0)a.push(`<span class="creditor-tag">Mahnstufe ${Number(x.dunningLevel)}</span>`);if(Number(x.feesAmount||0)>0)a.push(`<span class="creditor-tag">Spesen ${money(x.feesAmount,x.currency)}</span>`);return a.length?`<div class="creditor-tags">${a.join('')}</div>`:''};
 function decorate(){document.querySelectorAll('#rows .row,#unknown .row').forEach(row=>{const control=row.querySelector('[data-s],[data-m]');if(!control)return;const k=control.dataset.s||control.dataset.m,x=items.get(k);if(!x)return;row.dataset.creditorKey=k;const supplier=control.matches('[data-s]')?row.children[2]:row.children[1];let old=supplier?.querySelector('.creditor-tags');if(old)old.remove();if(supplier&&tags(x))supplier.insertAdjacentHTML('beforeend',tags(x))})}
 async function refresh(){const q=await fetch('/incoming/payment-open-items',{cache:'no-store'}),d=await q.json();if(!q.ok||!d.ok)throw Error(d.error||'OP konnte nicht geladen werden');items=new Map([...(d.items||[]),...(d.unclassified||[]),...(d.submitted||[])].map(x=>[key(x),x]));decorate()}
 function updateTotal(){if(!current)return;const base=Number(current.approvedAmount??current.invoiceAmount??current.amount??0),extra=Math.max(0,Number(String(fees.value||0).replace(',','.'))||0);total.textContent=money(base+extra,current.currency)}
 function openItem(x){current=x;title.textContent=x.supplier||'Kreditoren-OP';meta.textContent=`Rechnung ${x.invoiceNumber||'–'} · Original ${money(x.invoiceAmount??x.amount,x.currency)}`;level.value=String(Math.max(0,Math.min(5,Number(x.dunningLevel||0))));fees.value=Number(x.feesAmount||0).toFixed(2);note.value=x.creditorNote||'';error.textContent='';save.disabled=['paid','sepa_submitted'].includes(String(x.paymentStatus||''));save.title=save.disabled?'Bereits bezahlt oder an SEPA übergeben':'';updateTotal();modal.classList.add('open');modal.setAttribute('aria-hidden','false')}
 function close(){modal.classList.remove('open');modal.setAttribute('aria-hidden','true');current=null}
 document.addEventListener('click',event=>{const row=event.target.closest('#rows .row[data-creditor-key],#unknown .row[data-creditor-key]');if(!row||event.target.closest('input,a,button,select'))return;const x=items.get(row.dataset.creditorKey);if(x)openItem(x)});
 fees.addEventListener('input',updateTotal);document.getElementById('creditorCancel').onclick=close;modal.addEventListener('click',e=>{if(e.target===modal)close()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('open'))close()});
 save.onclick=async()=>{if(!current)return;save.disabled=true;error.textContent='';try{const q=await fetch('/incoming/creditor-details',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:current.source,id:current.id,dunningLevel:Number(level.value||0),feesAmount:Number(String(fees.value||0).replace(',','.'))||0,note:note.value,updatedBy:'Bettina'})}),d=await q.json();if(!q.ok||!d.ok)throw Error(d.error||'Speichern fehlgeschlagen');location.reload()}catch(e){error.textContent=e.message;save.disabled=false}};
 const observer=new MutationObserver(()=>decorate());document.querySelectorAll('#rows,#unknown').forEach(x=>observer.observe(x,{childList:true,subtree:true}));refresh().catch(e=>console.error('Kreditoren-Details:',e));
})();
</script>
'''

    def payments_page_with_creditor_details():
        page = original()
        if 'id="kristaCreditorDetailsV1"' in page:
            return page
        page = page.replace("</head>", css + "\n</head>", 1)
        return page.replace("</body>", modal + script + "\n</body>", 1)

    payments_page_with_creditor_details._krista_creditor_details_ui = True
    runtime.payments_page = payments_page_with_creditor_details
    print("✅ Kreditoren-OP: anklickbar · Mahnstufe · mitüberweisbare Spesen")
