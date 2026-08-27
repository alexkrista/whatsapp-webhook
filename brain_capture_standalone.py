# coding: utf-8
"""KRISTINE Rechnungseingang als eigenstaendige Browser-Seite.

Warum:
Der Rechnungseingang war historisch Teil von MOBILE_PAGE. Immer mehr Erweiterungen
haben dieselbe HTML-Zeichenkette und dieselben globalen Browser-Events gepatcht.
Dadurch konnten voneinander unabhaengige Funktionen (Viewer, Scroll, Fence,
Stability, Global-Drop, Bearbeiten) sich gegenseitig beeinflussen.

Dieses Modul friert fuer /incoming-capture einen eigenen Seitenstand ein, bevor die
restlichen Brain-UI-Patches auf MOBILE_PAGE loslaufen. Server-Endpunkte und Datenbank
bleiben dieselben. Nur die Browser-Oberflaeche ist ab hier isoliert.
"""
from __future__ import annotations

import re


def _remove_tag_block(page: str, tag: str, element_id: str) -> str:
    return re.sub(
        rf'<{tag}\s+id=["\']{re.escape(element_id)}["\'][^>]*>.*?</{tag}>',
        '',
        page,
        flags=re.I | re.S,
    )


def _clean_snapshot(page: str) -> str:
    """Nur bekannte spaete/teure Browser-Hooks aus dem eingefrorenen Stand ziehen."""
    for script_id in (
        'kristaBrainCaptureViewerV2',
        'kristaBrainViewerReliableV10',
        'kristaCaptureLearningV1',
        'kristaCaptureGlobalDropV1',
        'kristaCaptureScrollIsolationV1',
        'kristaCaptureStabilityV1',
    ):
        page = _remove_tag_block(page, 'script', script_id)
    for style_id in (
        'kristaCaptureLearningCss',
        'kristaCaptureGlobalDropCss',
        'kristaCaptureScrollFixV1',
        'kristaCaptureScrollIsolationV1',
    ):
        page = _remove_tag_block(page, 'style', style_id)

    # Linie-2-Superviewer-Toolbar entfernen; der native iframe bleibt bestehen.
    page = re.sub(
        r'<div\s+id=["\']captureSuperTools["\'][^>]*>.*?</div>',
        '',
        page,
        flags=re.I | re.S,
    )
    return page


def _inject_shell(page: str) -> str:
    css = r'''
<style id="kristaCaptureStandaloneCss">
body.capture-wide{scroll-behavior:auto!important}
body.capture-wide .capture-preview-column{position:static!important;top:auto!important}
body.capture-wide .capture-workbench{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;align-items:start!important}
#capturePdfPreview{display:block!important;visibility:visible!important;width:100%!important;height:640px!important;min-height:520px!important;position:static!important;border:0!important;background:#fff!important}
#capturePdfPreview[hidden]{display:none!important}
#capturePdfPageImage,#capturePdfTextLayer,#captureSuperTools,#capturePreviewLoupe,#captureFenceOverlay{display:none!important}
.capture-standalone-badge{display:inline-flex;margin-left:8px;padding:3px 7px;border:1px solid #4d9464;border-radius:999px;background:#173421;color:#b9f3ca;font:800 10px/1.2 system-ui}
</style>
'''
    script = r'''
<script id="kristaCaptureStandaloneJs">
(function(){
  function setFile(file){
    if(!file)return;
    if(typeof setCaptureFile==='function'){setCaptureFile(file);return;}
    const input=document.getElementById('captureFile');if(!input)return;
    try{const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))}catch(_){input.click()}
  }
  function hasFiles(e){return Array.from(e.dataTransfer?.types||[]).includes('Files')}
  function start(){
    document.body.classList.add('capture-wide');
    try{if(typeof setSearchMode==='function')setSearchMode('capture')}catch(_){}
    const banner=document.getElementById('captureAreaBanner');
    if(banner&&!document.getElementById('captureStandaloneBadge')){
      const b=document.createElement('span');b.id='captureStandaloneBadge';b.className='capture-standalone-badge';b.textContent='eigenes Modul 0.14.15';banner.appendChild(b);
    }
  }
  document.addEventListener('dragover',e=>{
    if(!hasFiles(e))return;
    // Der Rechnungseingang oben darf seine eigene Mehrdatei-Logik behalten.
    if(e.target?.closest?.('#invoiceIntakeDrop'))return;
    e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='copy';
  },true);
  document.addEventListener('drop',e=>{
    if(!hasFiles(e)||e.target?.closest?.('#invoiceIntakeDrop'))return;
    const files=[...(e.dataTransfer?.files||[])];
    if(files.length!==1)return;
    const file=files[0];
    if(!(file.type==='application/pdf'||/\.pdf$/i.test(file.name||'')))return;
    e.preventDefault();e.stopImmediatePropagation();setFile(file);
  },true);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
</script>
'''
    page = page.replace('</head>', css + '\n</head>', 1)
    page = page.replace('</body>', script + '\n</body>', 1)
    # Bearbeiten soll nie weich animiert scrollen; das vermeidet unnoetige Paints.
    page = page.replace("scrollIntoView({behavior:'smooth',block:'start'})", "scrollIntoView({behavior:'auto',block:'start'})")
    return page


def install(ns):
    app = ns.get('app')
    base_page = str(ns.get('MOBILE_PAGE') or '')
    if app is None or not base_page or getattr(app, '__krista_capture_standalone', False):
        return

    # Eigene lokale Kopie: spaetere ns['MOBILE_PAGE']-Patches koennen diese Seite
    # nicht mehr veraendern.
    local = dict(ns)
    local['MOBILE_PAGE'] = _clean_snapshot(base_page)

    # Nur bewaehrte Kern-Erweiterungen bewusst in den eigenstaendigen Pruefplatz
    # uebernehmen. Die problematischen Viewer/Fence/Scroll/Stability-Hooks bleiben
    # draussen. Die Installer registrieren gleichzeitig ihre vorhandenen APIs.
    from brain_capture_edit import install as edit_install
    from brain_capture_edit_fast import install as edit_fast_install
    from brain_currency_payment_v2 import install as currency_install
    from brain_invoice_intake import install as intake_install
    from brain_capture_duplicate_guard import install as duplicate_install
    from brain_capture_tax_ui import install as tax_install
    from brain_capture_accounts import install as accounts_install
    from brain_test_promote import install as promote_install

    edit_install(local)
    edit_fast_install(local)
    currency_install(local)
    intake_install(local)
    duplicate_install(local)
    tax_install(local)
    accounts_install(local)
    promote_install(local)

    snapshot = _inject_shell(_clean_snapshot(str(local.get('MOBILE_PAGE') or '')))
    app.__krista_capture_standalone_page = snapshot

    # before_request ist absichtlich die Trennwand: /incoming-capture bekommt den
    # eingefrorenen Snapshot. Alle anderen Brain-Seiten verwenden weiter MOBILE_PAGE.
    @app.before_request
    def krista_capture_standalone_page():
        from flask import request, render_template_string
        if request.path != '/incoming-capture':
            return None
        return render_template_string(app.__krista_capture_standalone_page)

    app.__krista_capture_standalone = True
    print('✅ Rechnungseingang eigenes Modul 0.14.15 · MOBILE_PAGE-Patchkette isoliert')
