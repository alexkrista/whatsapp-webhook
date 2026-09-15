"use strict";
(function(){
  const B=window.KristaRegieBilling,esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function open(p,options={}){
    const dialog=document.createElement('dialog');dialog.className='krb-review';
    dialog.style.cssText='width:min(680px,calc(100% - 32px));max-height:90vh;overflow:auto;border:1px solid #c5d3be;border-radius:18px;padding:24px;background:#fffefa;color:#263b2d';
    const choices=p.aggregated?p.rows.filter(row=>row.complete&&!row.hasClosingInvoice):[p];
    dialog.innerHTML='<form method="dialog"><button style="float:right" aria-label="Schließen">×</button></form><h2>Abrechnung prüfen</h2>'+
      (p.aggregated?'<label>Einzelakte <select data-job>'+choices.map((row,i)=>'<option value="'+i+'">'+esc(row.jobId+' · '+row.jobName)+'</option>').join('')+'</select></label>':'<p>'+esc(p.jobId+' · '+p.jobName)+'</p>')+
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:18px 0"><label>Rechnungsart<select data-kind><option value="TR">Teilrechnung</option><option value="RE">Rechnung</option><option value="SR">Schlussrechnung · 100 %</option></select></label><label>Fertigstellung Fixauftrag %<input data-percent type="number" min="0" max="100" step="0.01"></label><label>Regie jetzt netto €<input data-regie type="number" min="0" step="0.01"></label></div><label>Korrektur / Notiz<textarea data-note rows="2" maxlength="2000" style="width:100%"></textarea></label><div data-result style="margin:16px 0;line-height:1.7"></div><p data-error role="alert" style="color:#a33"></p><button type="button" data-download>Vorschlag herunterladen</button> <a data-open target="_blank" rel="noopener">Als Rechnungsentwurf öffnen</a><p style="font-size:12px;color:#68736a">Der Vorschlag öffnet die Rechnungserstellung am Firmen-PC. Dort kannst du Positionen prüfen und den Entwurf speichern. Der Hinweis auf Regieberichte und Aufstellung im Kundenportal wird automatisch mitgenommen.</p>';
    dialog.querySelectorAll('input,select,textarea').forEach(el=>el.style.cssText+='display:block;width:100%;box-sizing:border-box;padding:10px;margin-top:5px;border:1px solid #c5d3be;border-radius:8px;font:inherit');
    const get=name=>dialog.querySelector('[data-'+name+']');let baseline,proposal;
    function reset(){baseline=choices[Number(get('job')?.value||0)];if(!baseline)return;get('percent').value=Number(baseline.completionPercent).toFixed(2);get('regie').value=Number(baseline.regieToInvoice).toFixed(2);get('note').value='';update();}
    function update(){
      proposal=null;get('open').removeAttribute('href');get('download').disabled=true;
      if(!baseline){get('error').textContent='Keine offene Einzelakte mit vollständigem Datenstand.';return;}
      const kind=get('kind').value;get('percent').disabled=kind==='SR';
      if(kind==='SR')get('percent').value='100';
      try{
        if(get('percent').value.trim()===''||get('regie').value.trim()==='')throw new Error('Fertigstellung und Regiebetrag eingeben.');
        proposal=B.prepareInvoiceProposal(baseline,{kind,completionPercent:get('percent').value,regieToInvoice:get('regie').value,reason:get('note').value});
        get('result').innerHTML='<div>'+esc(proposal.completionPercent.toLocaleString('de-AT'))+' % × '+B.formatMoney(baseline.fixedContractAmount)+' − '+B.formatMoney(baseline.fixedPartialInvoiceNet)+' geschriebene Fix-TR = <strong>'+B.formatMoney(proposal.fixedToInvoice)+'</strong></div><div>+ '+B.formatMoney(proposal.regieToInvoice)+' Regie jetzt</div><div><strong>'+esc(kind)+' netto: '+B.formatMoney(proposal.amountToInvoice)+'</strong></div>'+(proposal.changed?'<small>Berechneter Vorschlag: '+B.formatMoney(baseline.amountToInvoice)+' · Korrektur wird mitgeführt.</small>':'');
        const url=new URL('http://127.0.0.1:5051/outgoing/invoices');url.searchParams.set('project',baseline.jobId);url.searchParams.set('action',kind);
        url.hash='krb='+encodeURIComponent(JSON.stringify(proposal));
        get('open').href=url.href;get('open').textContent=kind+'-Entwurf öffnen';get('download').disabled=false;get('error').textContent='';
      }catch(error){get('result').textContent='';get('error').textContent=error.message;}
    }
    get('job')?.addEventListener('change',reset);
    get('kind').addEventListener('change',()=>{if(get('kind').value==='TR'&&baseline)get('percent').value=Number(baseline.completionPercent).toFixed(2);update()});
    for(const key of ['percent','regie','note'])get(key).addEventListener('input',update);
    get('download').onclick=()=>{if(!proposal)return;const url=URL.createObjectURL(new Blob(['\uFEFF'+B.proposalText(proposal)],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=proposal.kind+'-Vorschlag_'+proposal.jobId+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)};
    get('open').addEventListener('click',e=>{if(!proposal)e.preventDefault()});
    dialog.addEventListener('close',()=>dialog.remove());document.body.appendChild(dialog);if(['TR','RE','SR'].includes(String(options.kind||'').toUpperCase()))get('kind').value=String(options.kind).toUpperCase();reset();dialog.showModal();
  }
  window.KristaInvoiceReview={open};
})();
