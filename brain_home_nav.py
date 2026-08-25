# coding: utf-8
"""The Brain Startnavigation: klare 2x2 Navigation + kombinierte Rechnung/Material-Suche."""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page:
        return

    import re
    page = re.sub(r'<script\s+id="kristaBrainHomeNavV[12]">.*?</script>', '', page, flags=re.I | re.S)

    css = r'''
.brain-home-nav-rows{display:grid;gap:10px;margin-bottom:2px}
.brain-home-nav-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.brain-home-nav-row>*{margin:0!important}
.brain-combo-material-force{margin-left:8px!important;padding:6px 9px!important;font-size:11px!important}
@media(max-width:700px){.brain-home-nav-row>*{flex:1 1 auto}.brain-combo-material-force{margin:7px 0 0!important;width:100%}}
'''

    script = r'''
<script id="kristaBrainHomeNavV2">
(function(){
  function text(el){return String(el?.textContent||'').replace(/\s+/g,' ').trim()}
  function find(label){return [...document.querySelectorAll('button,a')].find(el=>text(el).includes(label))||null}
  function commonAncestor(nodes){
    if(!nodes.length)return null;
    let node=nodes[0].parentElement;
    while(node){if(nodes.every(x=>node.contains(x)))return node;node=node.parentElement}
    return null;
  }
  function activateCombo(){
    try{modeMaterial?.classList.add('active')}catch(_){}
    try{modeIncoming?.classList.remove('active')}catch(_){}
  }
  function prepareIncoming(){
    if(typeof setSearchMode==='function')setSearchMode('incoming');
    activateCombo();
    if(typeof q!=='undefined'){
      q.placeholder='Lieferant, Adresse oder Material …';
      q.focus();
    }
    if(typeof meta!=='undefined')meta.textContent='Lieferant/Adresse suchen – ohne Treffer sucht The Brain automatisch im Material.';
  }
  function showMaterial(term){
    term=String(term||'').trim();if(term.length<2)return;
    if(typeof setSearchMode==='function')setSearchMode('material');
    activateCombo();
    try{mainSearchRow.hidden=false}catch(_){}
    try{q.value=term;q.placeholder='Lieferant, Adresse oder Material …'}catch(_){}
    try{
      const searchCard=materialSection?.querySelector('.card');
      if(searchCard)searchCard.hidden=true;
      materialQ.value=term;
      meta.textContent='Materialsuche über alle Eingangsrechnungen';
      runGlobalMaterialSearch();
    }catch(error){console.error('Kombinierte Materialsuche:',error)}
  }
  async function combinedSearch(term){
    term=String(term||'').trim();
    if(term.length<2){if(typeof meta!=='undefined')meta.innerHTML='<span class="error">Bitte mindestens 2 Zeichen eingeben.</span>';return}
    try{
      if(typeof meta!=='undefined')meta.textContent='Suche Lieferant / Adresse …';
      const r=await fetch('/incoming/address-search?q='+encodeURIComponent(term),{cache:'no-store'}),data=await r.json();
      if(!r.ok||!data.ok)throw new Error(data.error||'Adresssuche fehlgeschlagen');
      const rows=data.addresses||[];
      if(rows.length){
        if(typeof setSearchMode==='function')setSearchMode('incoming');activateCombo();
        incomingCandidates=rows;renderSupplierCandidates();
        meta.innerHTML=`${rows.length} Adresse(n) gefunden · richtige auswählen <button id="brainForceMaterial" type="button" class="brain-combo-material-force">🔎 „${String(term).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}“ als Material suchen</button>`;
        document.getElementById('brainForceMaterial')?.addEventListener('click',()=>showMaterial(term));
      }else{
        showMaterial(term);
      }
    }catch(error){
      if(typeof meta!=='undefined')meta.innerHTML='<span class="error">Suche fehlgeschlagen: '+String(error.message||error)+'</span>';
    }
  }
  function install(){
    if(document.getElementById('brainHomeNavRows'))return;
    const project=find('Projekte / Firmenwissen');
    const incoming=find('Eingangsrechnungen');
    const material=[...document.querySelectorAll('button,a')].find(el=>/^\s*[^A-Za-z0-9]*Material\s*$/.test(text(el)))||find('Material');
    const paint=find('Farben & Lager');
    const capture=find('Erfassen');
    if(!project||!material||!capture)return;

    if(paint)paint.remove();
    if(incoming)incoming.remove();
    material.textContent='🧾 Eingangsrechnungen / Material';

    // WICHTIG: Den originalen Erfassen-Button nicht aus seinem ursprünglichen
    // Container verschieben. Die Brain-Basisseite nutzt dort teils delegierte
    // Click-Handler. Ein Verschieben in unsere 2x2-Navigation trennt diese Logik.
    // Deshalb bleibt das Original unsichtbar an Ort und Stelle; oben zeigen wir
    // nur einen Stellvertreter, der den echten Original-Click auslöst.
    const captureOriginal=capture;
    const captureNav=captureOriginal.cloneNode(true);
    captureNav.id='modeCaptureHome';
    captureNav.removeAttribute('onclick');
    captureNav.textContent='📥 Erfassen';
    captureOriginal.style.display='none';

    const nodes=[project,material,captureOriginal];
    const host=commonAncestor(nodes);
    if(!host)return;

    const wrapper=document.createElement('div');wrapper.id='brainHomeNavRows';wrapper.className='brain-home-nav-rows';
    const top=document.createElement('div');top.className='brain-home-nav-row';
    const bottom=document.createElement('div');bottom.className='brain-home-nav-row';
    const first=nodes.map(n=>({n,idx:[...host.children].indexOf(n)})).filter(x=>x.idx>=0).sort((a,b)=>a.idx-b.idx)[0]?.n;
    if(first&&first.parentElement===host)host.insertBefore(wrapper,first);else host.insertBefore(wrapper,host.firstChild);
    wrapper.append(top,bottom);
    top.append(project,material);
    bottom.append(captureNav);

    captureNav.addEventListener('click',e=>{
      e.preventDefault();
      e.stopPropagation();
      captureOriginal.click();
    });

    const op=captureNav.cloneNode(true);
    op.id='modePayments';op.classList.remove('active');op.removeAttribute('onclick');op.textContent='💶 OP';
    op.addEventListener('click',e=>{e.preventDefault();window.location.href='/incoming/payments'});
    bottom.appendChild(op);

    material.onclick=e=>{e.preventDefault();prepareIncoming()};
    if(typeof go!=='undefined')go.onclick=()=>{
      if(searchMode==='incoming'||searchMode==='material')combinedSearch(q.value);
      else if(typeof runSearch==='function')runSearch(q.value,false);
    };
    try{q.addEventListener('keydown',e=>{if(e.key==='Enter'&&(searchMode==='incoming'||searchMode==='material')){e.preventDefault();e.stopImmediatePropagation();combinedSearch(q.value)}},true)}catch(_){}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain Startnavigation V2: Projekte + Rechnungen/Material / Erfassen + OP")
