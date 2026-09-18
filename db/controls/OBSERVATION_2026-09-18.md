# Kontrollbefund 18.09.2026, ca. 18:26 Uhr

Reine Live-Sichtkontrolle, keine Datenänderung.

## Stabiler Stand

- Live-Commit: `dc101d9`
- Wiederherstellungspunkt: `stable-2026-09-18-pre-sql`
- KRISTINE Leitstand lädt.
- Der ausgeschiedene/für den Tag unzulässige Mitarbeiter „Alain“ erscheint
  nicht im Leitstand.

## Abweichung offene Auftragsstunden

| Sicht | Angezeigter Wert |
|---|---:|
| KRISTINE Baustellenliste | 940,4 h |
| KRISTOWER | 2.372,2 h |

Die 940,4 h sind mit den sichtbaren Einzelzeilen schlüssig, wenn für `Auftrag`
und `Laufend` jeweils `max(Soll - Ist, 0)` verwendet wird. Kleine Abweichungen
in der manuellen Addition entstehen durch die auf eine Dezimalstelle gerundete
Anzeige; intern liegen genauere Werte vor.

## Nachgewiesene veraltete Tower-Werte

- Sammelmappe 25018: Baustellenliste `494 h / 510 h`; daraus folgen etwa
  `16 h` Rest. KRISTOWER meldet dennoch `510 h Reststunden`.
- Baustelle 26082: Baustellenliste `533,5 h / 1.001 h`; daraus folgen etwa
  `467,5 h` Rest. KRISTOWER meldet `575,4 h Reststunden`.

## Schlussfolgerung

KRISTOWER und Baustellenliste benutzen unterschiedliche Stundenquellen bzw.
Berechnungswege. Die Tower-Kennzahl darf nicht als geprüfte Wahrheit in SQL
übernommen werden. Der Schattenimport muss Rohwerte je Quelle speichern und
beide Rechenwege im Kontrollbericht gegenüberstellen.
