# coding: utf-8
"""The Brain Startnavigation: klare 2x2 Navigation + kombinierte Rechnung/Material-Suche."""


def install(ns):
    import brain_service_runtime
    brain_service_runtime.install(ns)
    import brain_konfipay
    brain_konfipay.install(ns)
    import brain_revolut_connection
    brain_revolut_connection.install(ns)
    import brain_cash_book
    brain_cash_book.install(ns)
    import brain_invoice_book
    brain_invoice_book.install(ns)

    page = str(ns.get("MOBILE_PAGE") or "")
    if not page:
        return

    # Lokales Werkzeug zum Pruefen und Aufteilen von SEPA-Sammlern.
    from pathlib import Path
    from flask import send_file, request, jsonify
    app = ns["app"]
    ns["MOBILE_ALLOWED_PATHS"].add("/sepa-split")
    ns["MOBILE_ALLOWED_PATHS"].update({"/incoming/payment-batch/excel-template", "/incoming/payment-batch/excel"})
    if "brain_sepa_split" not in app.view_functions:
        def brain_sepa_split():
            return send_file(Path(__file__).resolve().parent / "public" / "sepa-split.html", mimetype="text/html")
        app.add_url_rule("/sepa-split", "brain_sepa_split", brain_sepa_split, methods=["GET"])
    if "brain_payment_excel_template" not in app.view_functions:
        def brain_payment_excel_template():
            return send_file(Path(__file__).resolve().parent / "public" / "SEPA_Sammler_Vorlage.xlsx",
                             mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             as_attachment=True,download_name="SEPA_Sammler_Vorlage.xlsx")
        app.add_url_rule("/incoming/payment-batch/excel-template", "brain_payment_excel_template", brain_payment_excel_template, methods=["GET"])
    if "brain_payment_excel_import" not in app.view_functions:
        def brain_payment_excel_import():
            try:
                from brain_payment_excel import convert
                upload=request.files.get("file")
                if not upload or not upload.filename.lower().endswith(".xlsx"):
                    return jsonify(ok=False,error="Bitte eine Excel-Vorlage (.xlsx) auswählen."),400
                raw=upload.stream.read(2_000_001)
                return jsonify(ok=True,**convert(raw))
            except ValueError as exc:return jsonify(ok=False,error=str(exc)),400
        app.add_url_rule("/incoming/payment-batch/excel", "brain_payment_excel_import", brain_payment_excel_import, methods=["POST"])

    import re
    page = re.sub(r'<script\s+id="kristaBrainHomeNavV[123]">.*?</script>', '', page, flags=re.I | re.S)

    css = r'''
.wrap{max-width:1180px}
.brain-home-nav-rows{display:grid;gap:12px;margin-bottom:2px;width:100%}
.brain-home-section{display:grid;gap:9px;padding:13px;border:1px solid var(--line);border-radius:16px;background:rgba(10,12,15,.34)}
.brain-home-section-title{margin:0;color:var(--muted);font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}
.brain-home-nav-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.brain-home-nav-row>*{margin:0!important}
.brain-home-nav-row .mode.active{background:#25332b!important;color:var(--text)!important;border-color:#496653!important;box-shadow:inset 3px 0 0 #86c89a}
.brain-home-knowledge .searchrow{margin-top:2px}
.brain-home-knowledge>.meta{margin-top:0}
.brain-combo-material-force{margin-left:8px!important;padding:6px 9px!important;font-size:11px!important}
@media(max-width:700px){.wrap{max-width:100%}.brain-home-section{padding:11px}.brain-home-nav-row>*{flex:1 1 auto}.brain-combo-material-force{margin:7px 0 0!important;width:100%}}
'''

    script = r'''
<script id="kristaBrainHomeNavV3">
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
    function section(title,extra=''){
      const box=document.createElement('section');box.className='brain-home-section '+extra;
      const heading=document.createElement('h2');heading.className='brain-home-section-title';heading.textContent=title;
      const row=document.createElement('div');row.className='brain-home-nav-row';box.append(heading,row);wrapper.append(box);return {box,row};
    }
    const first=nodes.map(n=>({n,idx:[...host.children].indexOf(n)})).filter(x=>x.idx>=0).sort((a,b)=>a.idx-b.idx)[0]?.n;
    if(first&&first.parentElement===host)host.insertBefore(wrapper,first);else host.insertBefore(wrapper,host.firstChild);
    const knowledge=section('Wissen & Suche','brain-home-knowledge');
    const invoices=section('Rechnungen bearbeiten','brain-home-invoices');
    const accounts=section('Konten & Kassa','brain-home-accounts');
    knowledge.row.append(material,project);
    invoices.row.append(captureNav);
    const searchRow=document.getElementById('mainSearchRow'),searchMeta=document.getElementById('meta'),searchLoader=document.getElementById('loader');
    if(searchRow)knowledge.box.append(searchRow);
    if(searchMeta)knowledge.box.append(searchMeta);
    if(searchLoader)knowledge.box.append(searchLoader);

    // Der native Brain-Endpunkt öffnet die Erfassung bereits selbst im capture-Modus.
    // Deshalb hier bewusst keine Abhängigkeit mehr von setSearchMode oder dem
    // versteckten Originalbutton: echte Navigation ist der robusteste Einstieg.
    captureNav.addEventListener('click',e=>{
      e.preventDefault();
      e.stopPropagation();
      window.location.href='/incoming-capture';
    });

    const op=captureNav.cloneNode(true);
    op.id='modePayments';op.classList.remove('active');op.removeAttribute('onclick');op.textContent='💶 Kreditoren-OP';
    op.addEventListener('click',e=>{e.preventDefault();window.location.href='/incoming/payments'});
    invoices.row.appendChild(op);

    const bank=captureNav.cloneNode(true);
    bank.id='modeBank';bank.classList.remove('active');bank.removeAttribute('onclick');bank.textContent='🏦 Bank';
    bank.addEventListener('click',e=>{e.preventDefault();window.location.href='/konfipay'});
    accounts.row.appendChild(bank);

    const revolut=captureNav.cloneNode(true);
    revolut.id='modeRevolut';revolut.classList.remove('active');revolut.removeAttribute('onclick');revolut.textContent='💳 Revolut Business';
    revolut.addEventListener('click',e=>{e.preventDefault();window.location.href='/incoming/revolut'});
    accounts.row.appendChild(revolut);

    const personal=revolut.cloneNode(true);
    personal.id='modeRevolutPersonal';personal.textContent='💳 Revolut';
    personal.addEventListener('click',e=>{e.preventDefault();window.location.href='/incoming/revolut-personal'});
    accounts.row.appendChild(personal);

    const kassa=captureNav.cloneNode(true);
    kassa.id='modeKassa';kassa.classList.remove('active');kassa.removeAttribute('onclick');kassa.textContent='💶 KASSA';
    kassa.addEventListener('click',e=>{e.preventDefault();window.location.href='/incoming/kassa'});
    accounts.row.appendChild(kassa);

    const invoiceBook=captureNav.cloneNode(true);
    invoiceBook.id='modeInvoiceBook';invoiceBook.classList.remove('active');invoiceBook.removeAttribute('onclick');invoiceBook.textContent='📚 RECHNUNGSBUCH';
    invoiceBook.addEventListener('click',e=>{e.preventDefault();window.location.href='/incoming/invoice-book'});
    invoices.row.appendChild(invoiceBook);

    const debtor=captureNav.cloneNode(true);
    debtor.id='modeDebtorOp';debtor.classList.remove('active');debtor.removeAttribute('onclick');debtor.textContent='💳 Debitoren-OP';
    debtor.addEventListener('click',e=>{e.preventDefault();window.location.href='/outgoing/open-items'});
    invoices.row.insertBefore(debtor,invoiceBook);

    const outgoing=captureNav.cloneNode(true);
    outgoing.id='modeOutgoing';outgoing.classList.remove('active');outgoing.removeAttribute('onclick');outgoing.textContent='🧾 Ausgangsrechnungen';
    outgoing.addEventListener('click',e=>{e.preventDefault();window.location.href='/outgoing/invoices'});
    knowledge.row.insertBefore(outgoing,project);

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
    print("Brain navigation V3: Wissen & Suche | Rechnungen | Konten & Kassa")
