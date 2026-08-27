# coding: utf-8
"""KRISTINE Eingangsrechnungen: stabiler Arbeitsmodus.

Der normale Rechnungspruefplatz bleibt moeglichst nahe am bewaehrten Kernstand.
Komplexe Browser-Hooks werden fuer /incoming-capture entfernt. Die originale
Capture-Logik (Datei, Bearbeiten, Kontierung, Speichern) bleibt unangetastet.

Zusaetzlich gibt es nur einen sehr kleinen seitenweiten Drop-Fallback: eine PDF
wird direkt an die vorhandene setCaptureFile()-Funktion gereicht. Keine Overlays,
keine MutationObserver, keine Capture-Phase-Klicklistener.
"""
from __future__ import annotations

import re


def install(ns):
    app = ns.get("app")
    if app is None or getattr(app, "__krista_capture_work_mode", False):
        return

    @app.after_request
    def krista_capture_work_mode(response):
        try:
            from flask import request
            if request.path != "/incoming-capture" or request.args.get("full") == "1":
                return response
            if "text/html" not in str(response.headers.get("Content-Type") or "").lower():
                return response

            html = response.get_data(as_text=True)

            # Alles entfernen, was erst spaeter in den funktionierenden Capture-Pfad
            # eingehakt wurde. Die originale Erfassung und brain_capture_edit bleiben.
            script_ids = (
                "kristaBrainViewerReliableV10",
                "kristaCaptureLearningV1",
                "kristaCaptureGlobalDropV1",
                "kristaCaptureScrollIsolationV1",
                "kristaCaptureStabilityV1",
            )
            style_ids = (
                "kristaCaptureLearningCss",
                "kristaCaptureGlobalDropCss",
                "kristaCaptureScrollFixV1",
                "kristaCaptureScrollIsolationV1",
            )
            for sid in script_ids:
                html = re.sub(
                    rf'<script\s+id=["\']{re.escape(sid)}["\'][^>]*>.*?</script>',
                    "",
                    html,
                    flags=re.I | re.S,
                )
            for sid in style_ids:
                html = re.sub(
                    rf'<style\s+id=["\']{re.escape(sid)}["\'][^>]*>.*?</style>',
                    "",
                    html,
                    flags=re.I | re.S,
                )

            override = r'''
<style id="kristaCaptureWorkMode01412">
body.capture-wide{scroll-behavior:auto!important}
body.capture-wide .capture-workbench{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;align-items:start!important}
body.capture-wide .capture-preview-column,
body.capture-wide .capture-editor-column{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;contain:none!important;position:static!important;top:auto!important}
body.capture-wide .capture-preview-card{min-height:0!important;height:auto!important}
/* Originale Drop-Zone wieder sichtbar. */
#captureDrop{display:block!important;pointer-events:auto!important}
#invoiceIntakeDrop{pointer-events:auto!important}
body.capture-wide .capture-pdf-shell{min-height:260px!important;max-height:none!important;overflow:hidden!important;contain:none!important}
body.capture-wide .capture-pdf-empty{min-height:260px!important}
#capturePdfPreview{display:block!important;visibility:visible!important;width:100%!important;height:620px!important;min-height:520px!important;position:static!important;pointer-events:auto!important;border:0!important;background:#fff!important}
#capturePdfPreview[hidden]{display:none!important}
#capturePdfPageImage,#capturePdfTextLayer,#captureSuperTools,#capturePreviewLoupe,#captureFenceOverlay{display:none!important}
#invoiceIntakeList [data-intake],#captureRecent [data-edit-invoice]{pointer-events:auto!important;cursor:pointer!important}
#captureRecent{contain:layout paint style}
#captureRecent>.card{contain:layout paint style;box-shadow:none!important}
.capture-work-mode-tag{display:inline-flex;margin-left:8px;padding:3px 7px;border-radius:999px;border:1px solid #4d9464;background:#173421;color:#b9f3ca;font:800 10px/1.2 system-ui}
</style>
<script id="kristaCaptureWorkMode01412Js">
(function(){
  function hasFiles(e){return Array.from(e.dataTransfer?.types||[]).some(x=>String(x).toLowerCase()==='files')}
  function handoff(file){
    if(!file)return false;
    if(typeof setCaptureFile==='function'){setCaptureFile(file);return true}
    const input=document.getElementById('captureFile');
    if(!input)return false;
    try{const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true}catch(_){return false}
  }
  function start(){
    const b=document.getElementById('captureAreaBanner');
    if(b&&!document.getElementById('captureWorkModeTag')){
      const s=document.createElement('span');s.id='captureWorkModeTag';s.className='capture-work-mode-tag';s.textContent='Arbeitsmodus 0.14.12';b.appendChild(s);
    }
    const cost=document.getElementById('captureCostSummary')?.closest('.section');
    if(cost)cost.style.display='none';
    const recent=document.getElementById('captureRecent');
    const recentSection=recent?.closest('.section');
    if(recentSection)recentSection.style.display='';
    if(recent)recent.style.display='';
    document.getElementById('captureLazyBottomBar')?.remove();

    // Kleiner Fallback fuer "PDF irgendwo auf der Erfassungsseite fallen lassen".
    // Drop direkt auf #captureDrop wird weiterhin vom originalen Brain-Code behandelt.
    document.addEventListener('dragover',e=>{if(hasFiles(e))e.preventDefault()},false);
    document.addEventListener('drop',e=>{
      if(!hasFiles(e))return;
      const files=[...(e.dataTransfer?.files||[])];
      if(files.length!==1)return;
      const file=files[0];
      if(!(file.type==='application/pdf'||/\.pdf$/i.test(file.name||'')))return;
      e.preventDefault();
      handoff(file);
    },false);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
</script>
'''
            html = html.replace("</body>", override + "\n</body>", 1)
            response.set_data(html)
            response.headers["Content-Type"] = "text/html; charset=utf-8"
            return response
        except Exception as exc:
            print("⚠ Eingangsrechnungen Arbeitsmodus konnte nicht angewendet werden:", exc)
            return response

    app.__krista_capture_work_mode = True
    print("✅ Eingangsrechnungen Arbeitsmodus 0.14.12: Original-Drop + Bearbeiten, neue Hooks aus")
