# coding: utf-8
"""KRISTINE Eingangsrechnungen: Scroll-Stabilitaet.

Der Rechnungspruefplatz hatte links eine sehr grosse sticky Vorschau (mind. 720px /
PDF-Flaeche mind. 610px). Auf manchen Browser/GPU-Kombinationen kann dieses grosse
sticky Element beim Scrollen fortlaufende Repaints verursachen. Das ist besonders
unsinnig, solange noch gar keine Rechnung geladen ist.

Stabilitaet vor Komfort: Vorschau nicht mehr sticky, leere Vorschau kompakt. Sobald
ein PDF da ist, bestimmt das Bild selbst die Hoehe. Die eigentliche PDF-/OCR-Logik
bleibt unveraendert.
"""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaCaptureScrollFixV1" in page:
        return

    css = r'''
<style id="kristaCaptureScrollFixV1">
/* Keine riesige sticky Flaeche mehr: verhindert teure Repaints beim Scrollen. */
.capture-preview-column{
  position:static!important;
  top:auto!important;
  align-self:start!important;
}
.capture-preview-card{
  min-height:0!important;
}
/* Vor dem Laden keinen 610-720px leeren Viewer rendern. */
.capture-pdf-shell{
  min-height:260px!important;
}
.capture-pdf-empty{
  min-height:260px!important;
}
/* Die unteren Listen in eigene Paint-Bereiche kapseln. */
.capture-recent>.card,
.capture-cost-card{
  contain:layout paint style;
}
/* Keine Animationen am grossen Arbeitsbereich waehrend des Scrollens. */
.capture-drop{transition:none!important}
</style>
'''
    page = page.replace("</head>", css + "\n</head>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Eingangsrechnungen Scroll-Fix: sticky Vorschau entfernt · leerer Viewer kompakt")
