# coding: utf-8
"""KRISTINE · klare Lieferantenauswahl in der Eingangsrechnung.

Ergaenzt sichtbare Auswahlbuttons bei Treffern und einen expliziten
"Lieferant aendern"-Button am bereits ausgewaehlten Lieferanten.
"""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaSupplierChoiceV1" in page:
        return

    css = r'''
.capture-supplier-choice{cursor:pointer}
.capture-supplier-choice:hover{border-color:#6d8cad!important}
.capture-supplier-pickline{display:flex;justify-content:flex-end;margin-top:9px}
.capture-supplier-pick{background:#315d91!important;border-color:#315d91!important;color:#fff!important;font-weight:850}
.capture-selected{position:relative;padding-right:155px!important}
.capture-supplier-change{position:absolute;right:10px;top:10px;background:#fff!important;color:#111!important;border-color:#bfc4ca!important;font-weight:850;white-space:nowrap}
@media(max-width:700px){.capture-selected{padding-right:12px!important}.capture-supplier-change{position:static;margin-top:10px;width:100%}}
'''

    script = r'''
<script id="kristaSupplierChoiceV1">
(function(){
  if(typeof captureSupplierResults==='undefined'||typeof captureSelectedSupplierBox==='undefined')return;

  function changeSupplier(){
    try{captureSelectedSupplier=null}catch(_){}
    try{captureAcceptNewIban=false}catch(_){}
    captureSelectedSupplierBox.innerHTML='Noch kein Lieferant ausgewählt.';
    try{if(captureMasterIban)captureMasterIban.value=''}catch(_){}
    try{if(captureExternalCustomerNo)captureExternalCustomerNo.value=(captureAnalysis?.customerNumberExternal||'')}catch(_){}
    try{if(typeof checkCaptureBankWarning==='function')checkCaptureBankWarning()}catch(_){}
    try{
      captureSupplierQ.focus();captureSupplierQ.select();
      if(String(captureSupplierQ.value||'').trim().length>=2&&typeof searchCaptureSuppliers==='function')searchCaptureSuppliers();
    }catch(_){}
  }

  function decorateSelected(){
    const card=captureSelectedSupplierBox.querySelector('.capture-selected');
    if(!card||card.querySelector('.capture-supplier-change'))return;
    const button=document.createElement('button');
    button.type='button';button.className='capture-supplier-change';button.textContent='↻ Lieferant ändern';
    button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();changeSupplier()});
    card.appendChild(button);
  }

  function decorateResults(rows){
    captureSupplierResults.querySelectorAll('[data-capture-supplier]').forEach(card=>{
      const index=Number(card.dataset.captureSupplier);
      if(!Number.isFinite(index)||!rows[index])return;
      if(!card.querySelector('.capture-supplier-pick')){
        const line=document.createElement('div');line.className='capture-supplier-pickline';
        const button=document.createElement('button');button.type='button';button.className='capture-supplier-pick';button.textContent='Auswählen';
        button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();selectCaptureSupplier(rows[index])});
        line.appendChild(button);card.appendChild(line);
      }
    });
  }

  if(typeof renderCaptureSupplierResults==='function'){
    const originalRender=renderCaptureSupplierResults;
    renderCaptureSupplierResults=function(rows=[],suggested=false){
      const result=originalRender.apply(this,arguments);
      decorateResults(rows||[]);
      return result;
    };
  }

  if(typeof selectCaptureSupplier==='function'){
    const originalSelect=selectCaptureSupplier;
    selectCaptureSupplier=async function(supplier){
      const result=await originalSelect.apply(this,arguments);
      decorateSelected();
      return result;
    };
  }

  const observer=new MutationObserver(()=>decorateSelected());
  observer.observe(captureSelectedSupplierBox,{childList:true,subtree:true});
  decorateSelected();
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ KRISTINE Lieferantenauswahl aktiv: Auswaehlen + Lieferant aendern")
