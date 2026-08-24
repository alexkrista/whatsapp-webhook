# coding: utf-8
"""KRISTINE Capture UI: 🎯-Fences, Layout-Lernen, Dubletten-Dialog und 3-Spalten-Maske."""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaCaptureLearningV1" in page:
        return

    css = r'''
<style id="kristaCaptureLearningCss">
.capture-form-two{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:9px 11px!important}
.capture-form-two .full{grid-column:1/-1}
.capture-form-two .capture-span-2{grid-column:span 2!important}
.capture-form-two .capture-span-3{grid-column:1/-1!important}
.capture-form-two .capture-span-1{grid-column:span 1!important}
.capture-form-two textarea{min-height:64px!important}
.formlabel.capture-learn-label{display:flex;align-items:center;justify-content:space-between;gap:6px}
.capture-fence-btn{flex:0 0 auto;width:27px;height:24px;min-height:24px!important;padding:0!important;border-radius:7px!important;border:1px solid #495563!important;background:#202832!important;color:#dce5ee!important;font-size:13px!important;line-height:1!important}
.capture-fence-btn.saved{background:#173824!important;border-color:#4a8b60!important;color:#bfe6cb!important}
.capture-fence-btn.active{outline:2px solid #e7ba59!important;background:#4a3814!important}
.capture-fence-overlay{position:absolute;z-index:25;cursor:crosshair;background:transparent;touch-action:none}
.capture-fence-overlay[hidden]{display:none!important}
.capture-fence-selection{position:absolute;border:2px solid #e7ba59;background:rgba(231,186,89,.16);box-shadow:0 0 0 1px rgba(0,0,0,.55);pointer-events:none}
.capture-learn-hint{margin:8px 0 0;padding:8px 10px;border:1px solid #384653;border-radius:9px;background:#111820;color:#aeb9c5;font-size:11px}
.capture-learn-hint.good{border-color:#3e7952;background:#13251a;color:#bfe3c9}
.capture-learn-hint.warn{border-color:#795e2d;background:#281f10;color:#efd394}
.capture-duplicate-panel{margin:12px 0;padding:12px;border:1px solid #795e2d;border-radius:12px;background:#281f10}
.capture-duplicate-panel[hidden]{display:none!important}
.capture-duplicate-panel.hard{border-color:#974744;background:#321817}
.capture-duplicate-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px}
.capture-duplicate-head strong{font-size:14px}
.capture-duplicate-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border-top:1px solid rgba(255,255,255,.11);padding:9px 0}
.capture-duplicate-item:first-of-type{border-top:0}
.capture-duplicate-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.capture-duplicate-actions button,.capture-duplicate-actions a{min-height:32px;padding:6px 9px;border-radius:8px;border:1px solid #596573;background:#252e38;color:#fff;text-decoration:none;font-size:11px;font-weight:850}
.capture-duplicate-actions .new{background:#2d7047;border-color:#438b5c}
.capture-duplicate-actions .replace{background:#7a5423;border-color:#a97634}
.capture-money-row{background:#11161b;border:1px solid #303943;border-radius:11px;padding:8px}
@media(max-width:1120px){.capture-form-two{grid-template-columns:repeat(2,minmax(0,1fr))!important}.capture-form-two .capture-span-2{grid-column:1/-1!important}.capture-form-two .capture-span-3{grid-column:1/-1!important}}
@media(max-width:650px){.capture-form-two{grid-template-columns:1fr!important}.capture-form-two .full,.capture-form-two .capture-span-2,.capture-form-two .capture-span-3,.capture-form-two .capture-span-1{grid-column:auto!important}.capture-duplicate-item{grid-template-columns:1fr}.capture-duplicate-actions{justify-content:flex-start}}
</style>
'''

    script = r'''
<script id="kristaCaptureLearningV1">
(function(){
  const fields={
    invoiceNumber:['captureInvoiceNumber','Rechnungsnummer'],
    invoiceDate:['captureInvoiceDate','Rechnungsdatum'],
    dueDate:['captureNetDueDate','Nettofälligkeit'],
    skontoPercent:['captureSkontoPercent','Skonto %'],
    skontoDueDate:['captureSkontoDueDate','Skonto fällig'],
    currency:['captureCurrency','Währung'],
    customerNumber:['captureExternalCustomerNo','Unsere Kundennr.'],
    paymentTerms:['capturePaymentTerms','Zahlungsbedingung'],
    invoiceIban:['captureInvoiceIban','IBAN'],
    netAmount:['captureNet','Netto'],
    vatAmount:['captureVat','USt'],
    grossAmount:['captureGross','Brutto']
  };
  const touched=new Set(),buttons=new Map();
  let activeField='',drag=null,fences=new Map(),dupState={items:[],hard:false,key:''},dupAck='',allowSaveOnce=false,dupTimer=0,lastSupplier='';
  const image=()=>document.getElementById('capturePdfPageImage');
  const shell=()=>image()?.parentElement;
  const supplier=()=>{try{return captureSelectedSupplier||null}catch(_){return null}};
  const area=()=>{try{return captureArea||'live'}catch(_){return 'live'}};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=(n,c='EUR')=>{try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0))}catch(_){return Number(n||0).toFixed(2)+' '+c}};

  function tuneThreeColumns(){
    const grid=document.querySelector('.capture-form-two');if(!grid)return;
    ['capturePaymentTerms','captureMasterIban','captureInvoiceIban','captureBookingText','captureNote'].forEach(id=>{
      const wrap=document.getElementById(id)?.parentElement;if(wrap)wrap.classList.remove('full');
    });
    document.getElementById('capturePaymentTerms')?.parentElement?.classList.add('capture-span-2');
    document.getElementById('captureBookingText')?.parentElement?.classList.add('capture-span-2');
    document.getElementById('captureNote')?.parentElement?.classList.add('capture-span-2');
    document.getElementById('captureBankWarning')?.classList.add('capture-span-3');
    document.getElementById('captureFxPanel')?.classList.add('capture-span-3');
    ['captureNet','captureVat','captureGross'].forEach(id=>document.getElementById(id)?.parentElement?.classList.add('capture-money-row'));
  }

  function preview(){
    const im=image();if(!im?.src)return null;
    try{const u=new URL(im.src,location.origin),token=u.searchParams.get('token'),page=Number(u.searchParams.get('page')||1);return token?{token,page}:null}catch(_){return null}
  }
  function inputFor(field){const id=fields[field]?.[0];return id?document.getElementById(id):null}
  function setValue(field,value,force=false){
    const el=inputFor(field);if(!el||value===null||value===undefined||value==='')return;
    if(!force&&touched.has(field))return;
    if(el.tagName==='SELECT'){
      const v=String(value),hit=[...el.options].find(o=>o.value===v||o.textContent===v);if(hit)el.value=hit.value;
    }else if(['netAmount','vatAmount','grossAmount','skontoPercent'].includes(field)){
      el.value=Number(value).toFixed(2);
    }else el.value=String(value);
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }

  function installButtons(){
    Object.entries(fields).forEach(([key,[id,label]])=>{
      const el=document.getElementById(id);if(!el||buttons.has(key))return;
      const wrap=el.parentElement,labelEl=wrap?.querySelector(':scope > .formlabel');if(!labelEl)return;
      labelEl.classList.add('capture-learn-label');
      const b=document.createElement('button');b.type='button';b.className='capture-fence-btn';b.dataset.fenceField=key;b.title=label+' im PDF markieren';b.textContent='🎯';
      b.onclick=e=>{e.preventDefault();chooseFenceAction(key)};
      labelEl.appendChild(b);buttons.set(key,b);
      el.addEventListener('input',()=>{if(!activeField)touched.add(key)});
      el.addEventListener('change',()=>{if(!activeField)touched.add(key)});
    });
  }
  function syncButtons(){buttons.forEach((b,key)=>{b.classList.toggle('saved',fences.has(key));b.textContent=fences.has(key)?'🎯✓':'🎯';b.classList.toggle('active',activeField===key)})}

  async function chooseFenceAction(field){
    if(!supplier()?.addressId)return alert('Bitte zuerst den Lieferanten auswählen.');
    if(!preview())return alert('Bitte zuerst eine Rechnung laden.');
    if(fences.has(field)){
      const choice=prompt(fields[field][1]+' ist für diesen Lieferanten bereits gelernt.\n\n1 = neu markieren\n2 = Fence löschen\n0 = abbrechen','1');
      if(choice==='2')return deleteFence(field);
      if(choice!=='1')return;
    }
    startFence(field);
  }

  function ensureOverlay(){
    let ov=document.getElementById('captureFenceOverlay'),sh=shell(),im=image();if(!sh||!im)return null;
    if(!ov){
      ov=document.createElement('div');ov.id='captureFenceOverlay';ov.className='capture-fence-overlay';ov.hidden=true;
      ov.innerHTML='<div id="captureFenceSelection" class="capture-fence-selection" hidden></div>';sh.appendChild(ov);
      ov.addEventListener('pointerdown',e=>{
        if(!activeField)return;e.preventDefault();const r=ov.getBoundingClientRect();
        drag={x:Math.max(0,Math.min(r.width,e.clientX-r.left)),y:Math.max(0,Math.min(r.height,e.clientY-r.top))};
        const s=document.getElementById('captureFenceSelection');s.hidden=false;s.style.left=drag.x+'px';s.style.top=drag.y+'px';s.style.width='0';s.style.height='0';ov.setPointerCapture?.(e.pointerId)
      });
      ov.addEventListener('pointermove',e=>{
        if(!drag)return;const r=ov.getBoundingClientRect(),x=Math.max(0,Math.min(r.width,e.clientX-r.left)),y=Math.max(0,Math.min(r.height,e.clientY-r.top)),s=document.getElementById('captureFenceSelection');
        s.style.left=Math.min(drag.x,x)+'px';s.style.top=Math.min(drag.y,y)+'px';s.style.width=Math.abs(x-drag.x)+'px';s.style.height=Math.abs(y-drag.y)+'px'
      });
      ov.addEventListener('pointerup',finishFence);
    }
    positionOverlay();return ov;
  }
  function positionOverlay(){const ov=document.getElementById('captureFenceOverlay'),im=image();if(!ov||!im)return;ov.style.left=im.offsetLeft+'px';ov.style.top=im.offsetTop+'px';ov.style.width=im.clientWidth+'px';ov.style.height=im.clientHeight+'px'}
  function hintBox(){let h=document.getElementById('captureLearningHint');if(h)return h;h=document.createElement('div');h.id='captureLearningHint';h.className='capture-learn-hint';const tools=document.getElementById('captureSuperTools'),sh=shell();if(tools)tools.insertAdjacentElement('afterend',h);else sh?.insertAdjacentElement('beforebegin',h);return h}
  function startFence(field){activeField=field;syncButtons();const ov=ensureOverlay();if(!ov)return;ov.hidden=false;positionOverlay();const h=hintBox();h.className='capture-learn-hint warn';h.textContent='🎯 '+fields[field][1]+': Rahmen direkt um den Wert ziehen. ESC bricht ab.'}
  function cancelFence(){activeField='';drag=null;const ov=document.getElementById('captureFenceOverlay'),s=document.getElementById('captureFenceSelection');if(ov)ov.hidden=true;if(s)s.hidden=true;syncButtons()}

  async function finishFence(e){
    if(!drag||!activeField)return;
    const ov=document.getElementById('captureFenceOverlay'),r=ov.getBoundingClientRect(),x=Math.max(0,Math.min(r.width,e.clientX-r.left)),y=Math.max(0,Math.min(r.height,e.clientY-r.top)),
      x0=Math.min(drag.x,x)/r.width,y0=Math.min(drag.y,y)/r.height,x1=Math.max(drag.x,x)/r.width,y1=Math.max(drag.y,y)/r.height,field=activeField,p=preview();
    drag=null;
    if(Math.abs(x1-x0)<.008||Math.abs(y1-y0)<.006)return cancelFence();
    if(!confirm('Diesen Bereich als „'+fields[field][1]+'“ für '+(supplier()?.name||'diesen Lieferanten')+' merken?'))return cancelFence();
    try{
      const q=await fetch('/incoming/capture/fence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        area:area(),addressId:supplier().addressId,fieldKey:field,previewToken:p.token,page:p.page,x0,y0,x1,y1,
        createdBy:(document.getElementById('captureCreatedBy')?.value||'Dunja')
      })}),d=await q.json();
      if(!q.ok||!d.ok)throw Error(d.error||'Fence konnte nicht gespeichert werden');
      fences.set(field,{field_key:field,x0,y0,x1,y1,page_no:p.page});setValue(field,d.value,true);
      const h=hintBox();h.className='capture-learn-hint good';h.textContent='✓ '+fields[field][1]+' für '+(supplier()?.name||'Lieferant')+' gelernt'+(d.sampleText?' · gelesen: '+d.sampleText:'');
      cancelFence();scheduleDuplicate()
    }catch(err){cancelFence();alert(err.message||err)}
  }

  async function deleteFence(field){
    if(!confirm('Fence „'+fields[field][1]+'“ für '+(supplier()?.name||'diesen Lieferanten')+' löschen?'))return;
    const q=await fetch('/incoming/capture/fence?area='+encodeURIComponent(area())+'&addressId='+encodeURIComponent(supplier().addressId)+'&fieldKey='+encodeURIComponent(field),{method:'DELETE'}),d=await q.json();
    if(!q.ok||!d.ok)return alert(d.error||'Löschen fehlgeschlagen');
    fences.delete(field);syncButtons();const h=hintBox();h.className='capture-learn-hint';h.textContent='Fence gelöscht. Manuelle Eingabe bleibt immer möglich.'
  }

  async function loadAndApply(){
    const s=supplier(),p=preview();if(!s?.addressId||!p)return;
    const identity=area()+'|'+s.addressId+'|'+p.token;
    if(identity===lastSupplier)return;lastSupplier=identity;
    try{
      const q=await fetch('/incoming/capture/fences/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({area:area(),addressId:s.addressId,previewToken:p.token})}),d=await q.json();
      if(!q.ok||!d.ok)throw Error(d.error||'Vorlage konnte nicht geladen werden');
      fences=new Map((d.items||[]).map(x=>[x.fieldKey,x]));syncButtons();
      (d.items||[]).forEach(x=>{if(Number(x.layoutScore||0)>=.25)setValue(x.fieldKey,x.value,false)});
      const h=hintBox();
      if(d.count){h.className='capture-learn-hint '+(d.warning?'warn':'good');h.textContent=d.warning?('⚠ '+d.warning):('🎯 '+d.count+' gelernte Felder für '+(s.name||'Lieferant')+' angewendet · Layout '+Math.round(Number(d.layoutScore||1)*100)+' %')}
      else{h.className='capture-learn-hint';h.textContent='Noch keine 🎯-Vorlage für '+(s.name||'diesen Lieferanten')+'. Bei einem Feld auf 🎯 klicken und im PDF markieren.'}
    }catch(err){console.warn('Fence apply',err)}
    finally{scheduleDuplicate()}
  }

  function duplicateKey(){
    const s=supplier(),num=document.getElementById('captureInvoiceNumber')?.value||'',dt=document.getElementById('captureInvoiceDate')?.value||'',g=document.getElementById('captureGross')?.value||'';
    return [s?.addressId||'',num,dt,g].join('|')
  }
  function duplicateHost(){
    let p=document.getElementById('captureDuplicatePanel');if(p)return p;
    p=document.createElement('div');p.id='captureDuplicatePanel';p.className='capture-duplicate-panel';p.hidden=true;
    const save=document.getElementById('captureSave'),card=save?.closest('.card');
    if(card)card.insertBefore(p,card.firstChild);else save?.parentElement?.insertBefore(p,save);
    return p
  }
  function openHref(path){return path?('/pdf?path='+encodeURIComponent(path)):'#'}
  function renderDuplicates(items,hard){
    const p=duplicateHost();dupState={items:items||[],hard:Boolean(hard),key:duplicateKey()};
    if(!items?.length){p.hidden=true;p.innerHTML='';return}
    p.hidden=false;p.classList.toggle('hard',Boolean(hard));
    const firstHard=items.some(x=>x.hard);
    p.innerHTML=`<div class="capture-duplicate-head"><div><strong>${firstHard?'⛔ Rechnung vermutlich bereits vorhanden':'⚠ Diese Rechnung könnte bereits vorhanden sein'}</strong><div class="sub">${firstHard?'Bitte vorhandenen Beleg öffnen/prüfen oder – sofern erlaubt – das PDF ersetzen.':'Lieferant + Betrag + ähnliches Datum passen zu einem bestehenden Beleg.'}</div></div></div>${items.map((x,i)=>`<div class="capture-duplicate-item"><div><strong>${esc(x.docId||x.invoiceNumber||'Vorhandene Rechnung')}</strong> · ${esc(x.supplier||'')}<div class="sub">${esc(x.invoiceDate||'')} · ${esc(x.invoiceNumber||'')} · ${esc(money(x.amount,x.currency))} · ${esc((x.reasons||[]).join(' · '))}</div></div><div class="capture-duplicate-actions">${x.path?`<a href="${openHref(x.path)}" target="_blank" rel="noopener">Vorhandene öffnen</a>`:''}${x.hard&&x.replaceAllowed?`<button type="button" class="replace" data-dup-replace="${i}">PDF ersetzen</button>`:''}<button type="button" data-dup-correct="1">Erfassung korrigieren</button>${!x.hard?`<button type="button" class="new" data-dup-new="1">Ist neue Rechnung</button>`:''}</div></div>`).join('')}`;
    p.querySelectorAll('[data-dup-correct]').forEach(b=>b.onclick=()=>{document.getElementById('captureInvoiceNumber')?.focus();document.getElementById('captureInvoiceNumber')?.scrollIntoView({behavior:'smooth',block:'center'})});
    p.querySelectorAll('[data-dup-new]').forEach(b=>b.onclick=()=>{dupAck=duplicateKey();p.hidden=true;if(typeof setCaptureMessage==='function')setCaptureMessage('✓ Dublettenverdacht geprüft · als neue Rechnung bestätigt','success')});
    p.querySelectorAll('[data-dup-replace]').forEach(b=>b.onclick=()=>replaceDuplicate(items[Number(b.dataset.dupReplace)]))
  }
  async function replaceDuplicate(x){
    const file=document.getElementById('captureFile')?.files?.[0];if(!file)return alert('Aktuelle PDF fehlt.');
    if(!confirm('PDF von '+(x.docId||x.invoiceNumber)+' wirklich durch die aktuell geladene PDF ersetzen?\n\nNur das PDF wird ersetzt; die vorhandenen Rechnungsdaten bleiben zur Kontrolle bestehen.'))return;
    const fd=new FormData();fd.append('source',x.source);fd.append('id',String(x.id));fd.append('file',file);
    const q=await fetch('/incoming/capture/duplicate-replace',{method:'POST',body:fd}),d=await q.json();
    if(!q.ok||!d.ok)return alert(d.error||'PDF konnte nicht ersetzt werden');
    alert(d.message||'PDF ersetzt');
    try{resetCaptureForm();await Promise.all([loadCaptureDashboard(),loadCaptureRecent()])}catch(_){}
  }
  async function runDuplicate(force=false){
    const key=duplicateKey();
    if(!supplier()?.addressId||(!document.getElementById('captureInvoiceNumber')?.value&&!document.getElementById('captureGross')?.value)){renderDuplicates([],false);return {clear:true}}
    if(!force&&dupState.key===key)return {clear:!dupState.items.length,hard:dupState.hard,items:dupState.items};
    try{
      const body={area:area(),supplier:supplier(),invoiceNumber:document.getElementById('captureInvoiceNumber')?.value||'',invoiceDate:document.getElementById('captureInvoiceDate')?.value||'',grossAmount:document.getElementById('captureGross')?.value||'',fileSha256:(typeof captureAnalysis!=='undefined'&&captureAnalysis?.sha256)||''};
      const q=await fetch('/incoming/capture/duplicate-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),d=await q.json();
      if(!q.ok||!d.ok)throw Error(d.error||'Dublettenprüfung fehlgeschlagen');
      renderDuplicates(d.items||[],d.hard);return {clear:!(d.items||[]).length,hard:Boolean(d.hard),items:d.items||[]}
    }catch(err){console.warn('Dublettenprüfung',err);return {clear:true,error:err}}
  }
  function scheduleDuplicate(){clearTimeout(dupTimer);dupTimer=setTimeout(()=>runDuplicate(false),450)}

  function hookEvents(){
    Object.entries(fields).forEach(([key,[id]])=>{
      const el=document.getElementById(id);if(!el)return;
      el.addEventListener('input',()=>{dupAck='';scheduleDuplicate()});
      el.addEventListener('change',()=>{dupAck='';scheduleDuplicate()})
    });
    const supplierBox=document.getElementById('captureSelectedSupplier');
    if(supplierBox)new MutationObserver(()=>{lastSupplier='';setTimeout(loadAndApply,90)}).observe(supplierBox,{childList:true,subtree:true,characterData:true});
    const im=image();if(im)im.addEventListener('load',()=>{positionOverlay();lastSupplier='';setTimeout(loadAndApply,60)});
    window.addEventListener('resize',positionOverlay);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&activeField)cancelFence()});
    const save=document.getElementById('captureSave');
    save?.addEventListener('click',async e=>{
      if(allowSaveOnce){allowSaveOnce=false;return}
      if(String(save.textContent||'').includes('Änderungen'))return;
      e.preventDefault();e.stopImmediatePropagation();
      const check=await runDuplicate(true),key=duplicateKey();
      if(check.hard){duplicateHost().scrollIntoView({behavior:'smooth',block:'center'});return}
      if(check.items?.length&&dupAck!==key){duplicateHost().scrollIntoView({behavior:'smooth',block:'center'});return}
      allowSaveOnce=true;save.click()
    },true);
  }

  function boot(){
    tuneThreeColumns();installButtons();hookEvents();
    setTimeout(()=>{tuneThreeColumns();installButtons();loadAndApply();scheduleDuplicate()},300)
  }
  boot();
})();
</script>
'''
    page = page.replace("</head>", css + "\n</head>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Capture Learning UI: 3 Spalten · 🎯 je Feld · Dubletten-Dialog")
