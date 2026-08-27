# coding: utf-8
"""KRISTINE Eingangsrechnungen: stabiler Arbeitsmodus.

Solange der Browser auf /incoming-capture beim blossen Scrollen abstuerzt, wird
fuer genau diese Seite bewusst auf die komplexesten UI-Erweiterungen verzichtet.
Die Kern-Erfassung, Rechnungseingang, Zahlungslogik und Kontierung bleiben aktiv.
Viewer-Hotfix, Fence-UI, globaler Drop und die beiden spekulativen Scroll-Hotfixes
werden aus der ausgelieferten HTML-Seite entfernt. Damit haben wir einen sauberen,
arbeitsfaehigen Referenzstand und koennen die Erweiterungen spaeter einzeln wieder
zuschalten.
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
            # Komplexe UI-Hooks fuer den Arbeitsmodus entfernen. Server-/Datenlogik
            # bleibt aktiv; nur die Browser-Schicht wird fuer Stabilitaet vereinfacht.
            script_ids = (
                "kristaBrainViewerReliableV10",
                "kristaCaptureLearningV1",
                "kristaCaptureGlobalDropV1",
                "kristaCaptureScrollIsolationV1",
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
<style id="kristaCaptureWorkMode0147">
body.capture-wide{scroll-behavior:auto!important}
body.capture-wide .capture-workbench{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;align-items:start!important}
body.capture-wide .capture-preview-column,
body.capture-wide .capture-editor-column{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;contain:none!important;position:static!important;top:auto!important}
body.capture-wide .capture-preview-card{min-height:0!important;height:auto!important}
body.capture-wide .capture-pdf-shell{min-height:260px!important;max-height:none!important;overflow:hidden!important;contain:none!important}
body.capture-wide .capture-pdf-empty{min-height:260px!important}
#capturePdfPreview{display:block!important;visibility:visible!important;width:100%!important;height:620px!important;min-height:520px!important;position:static!important;pointer-events:auto!important;border:0!important;background:#fff!important}
#capturePdfPreview[hidden]{display:none!important}
#capturePdfPageImage,#capturePdfTextLayer,#captureSuperTools,#capturePreviewLoupe,#captureFenceOverlay{display:none!important}
.capture-work-mode-tag{display:inline-flex;margin-left:8px;padding:3px 7px;border-radius:999px;border:1px solid #4d9464;background:#173421;color:#b9f3ca;font:800 10px/1.2 system-ui}
</style>
<script id="kristaCaptureWorkMode0147Js">
(function(){
  function start(){
    const b=document.getElementById('captureAreaBanner');
    if(b&&!document.getElementById('captureWorkModeTag')){
      const s=document.createElement('span');s.id='captureWorkModeTag';s.className='capture-work-mode-tag';s.textContent='Arbeitsmodus 0.14.7';b.appendChild(s);
    }
    // Die beiden grossen Auswertungsbereiche brauchen wir fuer die Erfassung nicht.
    // Sie bleiben aus dem sichtbaren Scrollpfad, die Daten-Endpunkte selbst bleiben intakt.
    const cost=document.getElementById('captureCostSummary')?.closest('.section');
    const recent=document.getElementById('captureRecent')?.closest('.section');
    if(cost)cost.style.display='none';
    if(recent)recent.style.display='none';
    document.getElementById('captureLazyBottomBar')?.remove();
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
    print("✅ Eingangsrechnungen Arbeitsmodus 0.14.7 aktiv · komplexe Browser-Hooks aus")
