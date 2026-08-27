# coding: utf-8
"""KRISTINE Eingangsrechnungen: stabiler Arbeitsmodus.

Der Arbeitsmodus laesst die Kern-Erfassung und alle vorhandenen Test-/Echtbelege
voll benutzbar, verzichtet auf /incoming-capture aber vorlaeufig auf die
komplexesten Browser-Erweiterungen, die den Scroll-Absturz ausloesen koennten.

Wichtig: Testbelege werden NICHT ausgeblendet. "Zuletzt erfasst" bleibt sichtbar
und damit auch die bestehende Bearbeiten-Funktion. Nur die grosse Kostenentwicklung
wird fuer den normalen Erfassungsablauf ausgeblendet.
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
            # Nur komplexe Browser-Hooks entfernen. Server-/Datenlogik,
            # Rechnungseingang, Bearbeiten und Testbelege bleiben unveraendert aktiv.
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

            # Die beiden vorhandenen Bearbeiten-Funktionen sind absichtlich lokal
            # gekapselt. Fuer den stabilen Arbeitsmodus stellen wir nur diese zwei
            # Funktionen nach aussen, damit ein einziger robuster Event-Handler die
            # Klicks uebernimmt. Daten-/Speicherlogik bleibt unveraendert.
            html = html.replace(
                "  function stopEdit(reset=true){",
                "  window.kristaCaptureStartEdit=startEdit;\n  function stopEdit(reset=true){",
                1,
            )
            html = html.replace(
                "  drop.onclick=()=>input.click();",
                "  window.kristaOpenInvoiceIntake=openItem;\n  drop.onclick=()=>input.click();",
                1,
            )

            override = r'''
<style id="kristaCaptureWorkMode0149">
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
#invoiceIntakeList [data-intake],#captureRecent [data-edit-invoice]{pointer-events:auto!important;position:relative!important;z-index:20!important;cursor:pointer!important}
/* Test-/Echtbelege unten bleiben sichtbar und editierbar, aber separat gekapselt. */
#captureRecent{contain:layout paint style}
#captureRecent>.card{contain:layout paint style;box-shadow:none!important}
</style>
<script id="kristaCaptureWorkMode0149Js">
(function(){
  function workbench(){return document.querySelector('.capture-workbench')}
  function start(){
    const b=document.getElementById('captureAreaBanner');
    if(b&&!document.getElementById('captureWorkModeTag')){
      const s=document.createElement('span');s.id='captureWorkModeTag';s.className='capture-work-mode-tag';s.textContent='Arbeitsmodus 0.14.9';b.appendChild(s);
    }

    // Nur die grosse Kostenentwicklung aus dem normalen Arbeitsweg nehmen.
    const cost=document.getElementById('captureCostSummary')?.closest('.section');
    if(cost)cost.style.display='none';

    // Zuletzt erfasst inklusive TEST-Belegen und Bearbeiten MUSS sichtbar bleiben.
    const recent=document.getElementById('captureRecent');
    const recentSection=recent?.closest('.section');
    if(recentSection)recentSection.style.display='';
    if(recent)recent.style.display='';
    document.getElementById('captureLazyBottomBar')?.remove();

    // Ein robuster Klickweg fuer beide Bearbeiten-Schaltflaechen. Damit kann kein
    // anderer Capture-Listener den Button vor seinem eigenen onclick deaktivieren.
    document.addEventListener('click',e=>{
      const intake=e.target?.closest?.('#invoiceIntakeList [data-intake]');
      if(intake&&typeof window.kristaOpenInvoiceIntake==='function'){
        e.preventDefault();e.stopImmediatePropagation();
        const old=intake.textContent;intake.disabled=true;intake.textContent='PDF wird geladen …';
        Promise.resolve(window.kristaOpenInvoiceIntake(intake.dataset.intake,intake.dataset.name,intake.dataset.stamp))
          .then(()=>setTimeout(()=>workbench()?.scrollIntoView({behavior:'auto',block:'start'}),60))
          .catch(err=>alert(err?.message||String(err)))
          .finally(()=>{if(document.body.contains(intake)){intake.disabled=false;intake.textContent=old}});
        return;
      }
      const edit=e.target?.closest?.('#captureRecent [data-edit-invoice]');
      if(edit&&typeof window.kristaCaptureStartEdit==='function'){
        e.preventDefault();e.stopImmediatePropagation();
        const id=Number(edit.dataset.editInvoice||0);if(!id)return;
        const old=edit.textContent;edit.disabled=true;edit.textContent='Öffne …';
        Promise.resolve(window.kristaCaptureStartEdit(id))
          .then(()=>setTimeout(()=>workbench()?.scrollIntoView({behavior:'auto',block:'start'}),40))
          .catch(err=>alert(err?.message||String(err)))
          .finally(()=>{if(document.body.contains(edit)){edit.disabled=false;edit.textContent=old}});
      }
    },true);

    document.getElementById('captureFile')?.addEventListener('change',()=>{
      setTimeout(()=>workbench()?.scrollIntoView({behavior:'auto',block:'start'}),100);
    },true);
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
    print("✅ Eingangsrechnungen Arbeitsmodus 0.14.9 aktiv · Bearbeiten-Klicks robust")
