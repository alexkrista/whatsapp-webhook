# Kontaktstamm und Baustellenzuordnungen

Migration 007 bildet neutrale Kontaktstammeinträge als Kontaktgruppen ab. Ein Quellen-Datensatz kann eine Firma, eine Einzelperson oder mehrere Personen enthalten. Gruppen, Gruppenmitglieder und Projektverweise sind getrennte Tabellen mit mandantengesicherten Fremdschlüsseln. Ein Datenbanktrigger prüft zusätzlich, dass die archivierte Baustellenquelle tatsächlich die verknüpfte Stamm-ID in der angegebenen Rolle enthält.

Der Import verwendet ausschließlich bestehende Stamm-IDs. Er übernimmt einen Eintrag mit expliziter Rolle `Firma` als Organisation. Personen werden nur aus eigenen Vornamensfeldern übernommen; gemeinsame Nachnamen allein erzeugen keine erfundenen Personen. Eigene E-Mails und Telefonnummern bleiben bei der zugehörigen Person. Die auf dem Stammeintrag gespeicherten gemeinsamen Kontaktdaten bleiben auf der Gruppe und werden nicht wahllos allen Personen zugeschrieben. Unklare Einträge bleiben vollständig erhalten und bekommen `person_or_company_details_missing` als Prüfvermerk. Gleiche Namen aus unterschiedlichen Stamm-IDs werden nicht zusammengeführt.

Die vollständige Original-Stammdatei wird einschließlich Formatierung als Quelle archiviert. Zusätzlich bekommt jeder Stammeintrag einen Quellen-Datensatz mit seinen unveränderten Feldern. Projektverweise stammen aus dem bereits geprüften Baustellen-Snapshot in SQL; sie können daher vom später weiterbearbeiteten aktiven JSON-Stand abweichen. Vor einer Anwendungsumschaltung muss erneut abgeglichen werden.

Alle Datenänderungen und Feldprüfungen laufen in einer Transaktion. Wiederholungen erzeugen keine neuen Gruppen, Personen oder Projektverweise. Geänderte Quellen, unbekannte Stamm-IDs oder veränderte Zielfelder brechen den Import ab und rollen ihn zurück. Schemaänderung und Datenimport sind getrennte Transaktionen. Bestehende JSON-Dateien und die laufende Anwendung bleiben unverändert.

## Verifizierter Live-Import am 06.10.2026

Migration 007 wurde auf kristine-postgres angewendet. Importiert und innerhalb der Transaktion feldweise geprüft: 26 Kontaktgruppen, 10 Personen, 2 Organisationen und 51 Projektzuordnungen. 18 Gruppen haben fehlende eindeutige Personen-/Firmenangaben und bleiben zur Prüfung markiert. Die vollständige Originaldatei wurde vorab auf dem persistenten Disk gesichert und danach unverändert bestätigt. Insgesamt bestehen nun 95 normalisierte Tabellen.

42 Datenbanktests bestanden; die beiden Kontakttests wurden nach Ergänzung der negativen Triggerprüfungen erneut erfolgreich ausgeführt. Nicht mit Stamm-IDs verknüpfte Projektkontakte sind noch nicht normalisiert; ihre Originalfelder bleiben im Projektarchiv erhalten. Die Anwendung wurde durch diesen Import nicht auf SQL umgestellt oder neu deployt.
