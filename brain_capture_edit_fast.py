# coding: utf-8
"""KRISTINE Eingangsrechnungen: gespeicherte Belege sofort bearbeiten.

Beim Oeffnen einer bereits erfassten Rechnung waren alle relevanten Lieferanten-
und Rechnungsdaten bereits im lokalen KRISTINE-Datensatz vorhanden. Trotzdem rief
die UI erneut selectCaptureSupplier() auf und wartete damit auf den kompletten
WinWorker-Lieferantenkontext. Das ist fuer Bearbeiten unnoetig und konnte den
sichtbaren Lade-Spinner lange laufen lassen.

Dieser kleine Patch laesst den gespeicherten Lieferanten direkt aus den vorhandenen
Daten in die Maske einsetzen. Eine manuelle Lieferantenaenderung nutzt weiterhin
die normale Lieferantensuche und -kontextlogik.
"""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaCaptureEditV1" not in page:
        return

    old = "if(typeof selectCaptureSupplier==='function')await selectCaptureSupplier(captureSelectedSupplier);else captureSelectedSupplierBox.innerHTML='<div class=\"card capture-selected\"><strong>'+esc(captureSelectedSupplier.name)+'</strong></div>';"
    new = "captureSelectedSupplierBox.innerHTML='<div class=\"card capture-selected\"><strong>'+esc(captureSelectedSupplier.name||'Lieferant')+'</strong>'+(captureSelectedSupplier.address?'<div class=\"sub\">'+esc(captureSelectedSupplier.address)+'</div>':'')+'<div class=\"sub\">Lieferantennr. '+esc(captureSelectedSupplier.supplierNumber||'–')+'</div></div>';"

    if old in page:
        page = page.replace(old, new, 1)
        ns["MOBILE_PAGE"] = page
        print("✅ Eingangsrechnung Bearbeiten: gespeicherten Lieferanten sofort laden · kein WW-Warteweg")
    else:
        ns["MOBILE_PAGE"] = page
        print("⚠ Eingangsrechnung Bearbeiten Fast-Patch: Zielstelle nicht gefunden")
