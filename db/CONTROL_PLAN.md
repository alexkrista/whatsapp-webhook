# Gemeinsame Kontrollen vor jeder SQL-Umschaltung

## 1. Sicherung und Vollständigkeit

- Wiederherstellungspunkt: `stable-2026-09-18-pre-sql`
- Anzahl Baustellen Dateiablage = Anzahl importierter Einzelbaustellen
- Anzahl Mitarbeiter und Beschäftigungszeiträume stimmt
- Anzahl Stundenbuchungen je Quelle stimmt
- Anzahl Angebote, PDFs und Kundenbestätigungen stimmt
- Für jede importierte Datei ist Hash, Änderungsdatum und Importlauf vorhanden

## 2. Mitarbeiterregeln

- Ausgeschiedene Mitarbeiter erscheinen an Tagen nach Beschäftigungsende nicht
- Noch nicht eingetretene Mitarbeiter erscheinen vor Beschäftigungsbeginn nicht
- Alte Planungsdaten dürfen keine zweite Person mit gleichem Namen erzeugen
- Beispielkontrolle: „Alain“ erscheint im aktuellen Leitstand gar nicht

## 3. Auftragsstunden

Für mindestens je drei echte Baustellen aus jedem Status vergleichen wir:

- Sollstunden Auftrag
- Sollstunden Regie
- Iststunden WW
- Iststunden KRISTINE
- bereinigte Doppelüberschneidungen
- offene Stunden nach Statusregel

Zu kontrollierende Varianten:

- Rest aktiv: Auftrag und Laufend jeweils Soll minus Ist
- Auftrag voll: Auftrag = Soll; Laufend = Soll minus Ist
- alle anderen Status = null

Nach unserer Entscheidung müssen Kontrollzentrum, Baustellenliste und
Baustellenakte exakt denselben Gesamtwert und dieselbe Herleitung anzeigen.

## 4. Sammelmappen

- Jedes Mitglied gehört höchstens zu einer Sammelmappe
- Summe der Mappe = Summe ihrer Mitglieder
- Mitglieder werden in der Portfoliosumme nicht zusätzlich gezählt
- Geschlossene/abgerechnete Mappen liefern null offene Stunden

## 5. Angebote und Kundenportal

- PDF-Hash im Portal = PDF-Hash des tatsächlich versendeten Dokuments
- Kundenbestätigung verweist auf genau diese PDF-Version
- Eine spätere Korrektur überschreibt weder Original noch Bestätigung
- Fragen, Auftrag, Zahlungsziel, Wunschtermin und Zugriffe sind zeitlich protokolliert

## 6. Freigabeschranke

SQL darf erst lesend live verwendet werden, wenn:

- keine ungeklärte Summenabweichung besteht,
- keine doppelten Quellschlüssel bestehen,
- keine verwaisten Stunden bestehen,
- Stichproben gemeinsam freigegeben sind,
- ein Rückweg zum stabilen Stand praktisch getestet wurde.
