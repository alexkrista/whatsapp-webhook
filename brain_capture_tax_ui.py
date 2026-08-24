# coding: utf-8
"""KRISTINE Capture UI: MwSt je Kontierungszeile, ruhige saubere Kontierungszeilen."""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaCaptureTaxUiV1" in page:
        return

    css = r'''
<style id="kristaCaptureTaxUiCss">
#captureAllocations{
  display:grid!important;
  gap:0!important;
}
.capture-allocation{
  margin:0!important;
  padding:10px 0!important;
  border-top:1px solid #2c313a!important;
  align-items:end!important;
  column-gap:8px!important;
  row-gap:8px!important;
}
.capture-allocation:last-child{
  border-bottom:1px solid #2c313a!important;
}
.capture-allocation > div{
  min-width:0!important;
  align-self:stretch!important;
  display:flex!important;
  flex-direction:column!important;
  justify-content:flex-end!important;
}
.capture-allocation .formlabel{
  min-height:18px!important;
  height:18px!important;
  margin:0 0 5px 3px!important;
  display:flex!important;
  align-items:center!important;
  white-space:nowrap!important;
  line-height:18px!important;
}
.capture-allocation input,
.capture-allocation select,
.capture-allocation .remove{
  height:42px!important;
  min-height:42px!important;
  box-sizing:border-box!important;
}
.capture-tax-allocation-hint{
  margin:8px 0 2px!important;
  color:#8f98a5!important;
  font-size:11px!important;
  line-height:1.35!important;
}
</style>
'''

    script = r'''
<script id="kristaCaptureTaxUiV1">
(function(){
  const num=v=>{const n=Number(String(v??'').replace(',','.'));return Number.isFinite(n)?n:0};

  function hideInvoiceVat(){
    const vat=document.getElementById('captureVat');
    const wrap=vat?.parentElement;
    if(!vat||!wrap)return;
    wrap.hidden=true;
    wrap.style.display='none';
    wrap.classList.remove('capture-money-row','capture-span-1','capture-span-2','capture-span-3','full');
  }

  function syncHiddenVat(){
    const net=document.getElementById('captureNet');
    const gross=document.getElementById('captureGross');
    const vat=document.getElementById('captureVat');
    if(!net||!gross||!vat)return;
    if(String(net.value||'').trim()===''||String(gross.value||'').trim()==='')return;
    vat.value=(Math.round((num(gross.value)-num(net.value))*100)/100).toFixed(2);
  }

  function polishAllocations(){
    const host=document.getElementById('captureAllocations');
    if(!host)return;
    host.querySelectorAll('.capture-allocation').forEach(row=>{
      const vatInput=row.querySelector('[data-field="vatRate"]');
      const vatLabel=vatInput?.parentElement?.querySelector('.formlabel');
      if(vatLabel)vatLabel.textContent='USt %';
      const netInput=row.querySelector('[data-field="netAmount"]');
      const netLabel=netInput?.parentElement?.querySelector('.formlabel');
      if(netLabel)netLabel.textContent='Netto';
    });

    let hint=document.getElementById('captureTaxAllocationHint');
    if(!hint){
      hint=document.createElement('div');
      hint.id='captureTaxAllocationHint';
      hint.className='capture-tax-allocation-hint';
      host.insertAdjacentElement('afterend',hint);
    }
    hint.textContent='MwSt gehört je Kontierungszeile zur Netto-Aufteilung. Standard meist ein Satz; bei gemischten Sätzen weitere Zeile verwenden.';
  }

  function hook(){
    hideInvoiceVat();
    polishAllocations();
    syncHiddenVat();

    const net=document.getElementById('captureNet');
    const gross=document.getElementById('captureGross');
    net?.addEventListener('input',syncHiddenVat);
    net?.addEventListener('change',syncHiddenVat);
    gross?.addEventListener('input',syncHiddenVat);
    gross?.addEventListener('change',syncHiddenVat);

    const host=document.getElementById('captureAllocations');
    if(host){
      new MutationObserver(()=>polishAllocations()).observe(host,{childList:true,subtree:true});
      host.addEventListener('input',e=>{if(e.target?.matches?.('[data-field="netAmount"],[data-field="vatRate"]'))syncHiddenVat()});
      host.addEventListener('change',e=>{if(e.target?.matches?.('[data-field="netAmount"],[data-field="vatRate"]'))syncHiddenVat()});
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hook,{once:true});
  else hook();
  setTimeout(()=>{hideInvoiceVat();polishAllocations();syncHiddenVat()},350);
})();
</script>
'''

    page = page.replace("</head>", css + "\n</head>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Capture Tax UI: USt oben verborgen · MwSt je Kontierungszeile · Zeilen sauber")
