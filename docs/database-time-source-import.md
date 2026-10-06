# Zeitquellenimport

Migration 009 und der Import übernehmen Stempelereignisse und archivierte Baustellenzeitblöcke getrennt. Diese Quellen überlappen teilweise. Sie werden nicht addiert, aus ihnen werden beim Import keine Lohnzeitsegmente abgeleitet und keine Monatsabschlüsse erstellt oder geändert.

Stempel enthalten Mitarbeiter, Baustellenverweis, Datum, Ereignistyp, gebuchte Uhrzeit und tatsächliche lokale Uhrzeit getrennt. Wo keine Herkunft belegt ist, bleibt `origin=legacy` mit Prüfvermerk. Es wird aus einer lokalen Uhrzeit kein absoluter Zeitstempel erfunden. Jede vollständige Originalzeile bleibt zusätzlich im Ereignisdetail und Quellenarchiv erhalten.

Das Baustellenzeitarchiv besteht aus Tagen und geordneten Blöcken mit Typ, lokalen Start-/Endzeiten, Tätigkeit, Abrechnungsart, unproduktiven Codes und Grund. Blöcke ohne Endzeit bleiben offen und erhalten `end_time_missing`; es wird keine Endzeit oder Dauer ergänzt. Fehlende Baustellenzuordnungen bleiben mit Original-ID und Prüfvermerk erhalten. Mitarbeiter müssen über Quellen-IDs aufgelöst sein; gleiche Namen werden nicht zusammengeführt.

Auch vollständig identische Stempelzeilen werden erhalten: Quellen-ID aus Zeilenhash plus Vorkommensnummer. Dadurch wird keine mögliche Buchung stillschweigend dedupliziert. Wiederholung desselben Snapshots erzeugt keine neuen Ereignisse oder Archivblöcke. Geänderte Dateien oder Zielfelder benötigen einen eigenen Abgleich und führen zum Rückrollen.

Die beiden vollständigen Originaldateien sowie Tagesabschlüsse, Tageskorrekturen, Freigaben und Prüfeinträge werden als exakte Quellen mit Hash archiviert. Die vier ergänzenden Quellen werden in diesem Schritt noch nicht normalisiert. Vorher werden alle sechs Dateien auf dem persistenten Disk gesichert. Alle Datensätze, Zuordnungen und Blockfelder werden in einer Transaktion geprüft. Schemaänderung und Datenimport sind getrennte Transaktionen.

Die Anwendung bleibt auf JSON. Vor Umschaltung müssen der aktuelle Berechnungsweg, Korrekturvorrang, Archivvorrang und bestehende Lohnabschlüsse abgeglichen werden. Regieberichte und finanzielle Daten sind nicht Teil dieses Imports.
