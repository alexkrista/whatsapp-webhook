# coding: utf-8
"""KRISTINE Eingangsrechnungen: stabiler Arbeitsmodus.

Ziel: Die Seite muss im Alltag benutzbar bleiben. Deshalb werden auf
/incoming-capture nur die Browser-Erweiterungen entfernt, die zuletzt in den
Scroll-/Klickpfad eingegriffen haben. Die bewährten Kernfunktionen bleiben aktiv:
- Rechnung per Drag & Drop / Datei laden
- Rechnungseingang oben bearbeiten
- bereits erfasste TEST-/Echtbelege unten bearbeiten
- Kontierung / Zahlungslogik / Speichern

Vorläufig aus: Spezial-PDF-Viewer, Fence-UI und die Scroll-Experimente. Außerdem
wird nur der FRONTEND-Teil des Stability-Hotfixes entfernt, weil dessen
Capture-Click-Listener den Bearbeiten-Button bereits vor dem eigentlichen onclick
deaktivieren konnte. Die serverseitige Entkopplung der Lieferantensuche bleibt.
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

            # Nur die zuletzt problematischen Browser-Hooks entfernen.
            # GlobalDrop und CaptureEdit bleiben absichtlich drin.
            script_ids = (
                "kristaBrainViewerReliableV10",
                "kristaCaptureLearningV1",
                "kristaCaptureScrollIsolationV1",
                "kristaCaptureStabilityV1",
            )
            style_ids = (
                "kristaCaptureLearningCss",
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
<style id="kristaCaptureWorkMode01411">
body.capture-wide{scroll-behavior:auto!important}
body.capture-wide .capture-workbench{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;align-items:start!important}
body.capture-wide .capture-preview-column,
body.capture-wide .capture-editor-column{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;contain:none!important;position:static!important;top:auto!important}
body.capture-wide .capture-preview-card{min-height:0!important;height:auto!important}
body.capture-wide .capture-pdf-shell{min-height:260px!important;max-height:none!important;overflow:hidden!important;contain:none!important}
body.capture-wide .capture-pdf-empty{min-height:260px!important}
/* Zurueck auf den einfachen, bewaehrten iframe-PDF-Viewer. */
#capturePdfPreview{display:block!important;visibility:visible!important;width:100%!important;height:620px!important;min-height:520px!important;position:static!important;pointer-events:auto!important;border:0!important;background:#fff!important}
#capturePdfPreview[hidden]{display:none!important}
#capturePdfPageImage,#capturePdfTextLayer,#captureSuperTools,#capturePreviewLoupe,#captureFenceOverlay{display:none!important}
/* Originale Bearbeiten-Buttons und Global-Drop bleiben voll klickbar. */
#invoiceIntakeList [data-intake],#captureRecent [data-edit-invoice],#captureGlobalChoose,#captureGlobalIntakeChoose{pointer-events:auto!important;cursor:pointer!important}
#captureRecent{contain:layout paint style}
#captureRecent>.card{contain:layout paint style;box-shadow:none!important}
.capture-work-mode-tag{display:inline-flex;margin-left:8px;padding:3px 7px;border-radius:999px;border:1px solid #4d9464;background:#173421;color:#b9f3ca;font:800 10px/1.2 system-ui}
</style>
<script id="kristaCaptureWorkMode01411Js">
(function(){
  function start(){
    const b=document.getElementById('captureAreaBanner');
    if(b&&!document.getElementById('captureWorkModeTag')){
      const s=document.createElement('span');s.id='captureWorkModeTag';s.className='capture-work-mode-tag';s.textContent='Arbeitsmodus 0.14.11';b.appendChild(s);
    }
    // Nur die grosse Kostenentwicklung bleibt fuer den Arbeitsweg ausgeblendet.
    const cost=document.getElementById('captureCostSummary')?.closest('.section');
    if(cost)cost.style.display='none';
    const recent=document.getElementById('captureRecent');
    const recentSection=recent?.closest('.section');
    if(recentSection)recentSection.style.display='';
    if(recent)recent.style.display='';
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
    print("✅ Eingangsrechnungen Arbeitsmodus 0.14.11: stabil + Bearbeiten + DragDrop")
