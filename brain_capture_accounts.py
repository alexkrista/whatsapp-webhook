# coding: utf-8
"""KRISTINE Rechnungserfassung: Sachkonten laut Liste vom 24.08.2026.

Es werden ausschließlich die NICHT durchgestrichenen Konten aus der vom Benutzer
bereitgestellten Sachkontenliste angeboten. Bestehende Kontierungslogik bleibt
unverändert; gespeichert wird weiterhin nur die Kontonummer im Feld `account`.
"""
from __future__ import annotations

import json

_RAW = """400|Maschinen und maschinelle Anlagen
630|Fahrzeuge
660|Betriebsausstattung, Werkzeuge
1300|Roh- Hilfs- und Betriebsstoffe
2314|Depot OMV
2315|Depot Eidg. Steuerverwaltung
2317|Depot Opel e-Vivaro FK 202 GM
2318|VZ Leasing Peugeot E-Expert
2500|Vorsteuer
2501|Vorsteuer aus innergemeinsch. Erwerb
2502|Vorsteuer aus Sonst.Leistg.ausl.Unternehm.§19(
2504|Vorsteuer Generalunternehmer
2506|Vorsteuer § 19/1d
2515|Nicht fällige Vorsteuer
2570|Vorsteuer Schweiz
2605|Nicht fällige Vorsteuer
2700|Kassa
2830|Sparkasse 03101-506735
2871|Hypo AT82 5800 0104 9932 3013
2881|Revolut LT92 3250 0067 6551 9202
3065|Rechts- und Beratungskosten
3290|Anzahlungen von Kunden 0 %
3500|Umsatzsteuer
3502|Umsatzsteuer § 19(1), Art.19(1)3
3504|Umsatzsteuer Generalunternehmer
3515|Nicht fällige Umsatzsteuer
3525|Umsatzsteuer Bauleistungen
3527|UST Verrechnung Schweiz
3528|UST Verrechnung Deutschland
3570|Umsatzsteuer Schweiz
3571|Erwerbsteuer
4000|Erlöse
4030|Erlöse Getränkeautomat
4300|Sonstige Erträge
4440|Sonstige Erträge 0%
4442|Förderung E-Auto
4443|Lehrlingsförderungen
4600|Anlagenverkäufe
4610|Anlagenverkäufe 0%
4815|Versicherungsvergütungen
5000|Waren
5010|Handelswaren
5400|Verbrauchsmaterial
5480|Verbrauchsmaterial
5600|Heizmaterial
5630|Wasser, Abwasser und Müll
5631|Schrott
5640|Gas
5650|Strom
5770|Fremdleistung
6000|Löhne und Gehälter
6005|FAB
6080|Erstattungen AUVA
6340|Urlaubsentgelt BUAK
6360|Sachbezüge Personal
6410|BMVG-Beitrag
6490|BUAK - Vorschreibung
6500|Gesetzlicher Sozialaufwand
6600|Dienstgeberbeitrag
6601|Lohnabgaben aus Vorjahren
6610|Dienstgeberzuschlag
6620|Kommunalsteuer
6720|Sonstiger Personalaufwand
6725|Fortbildungen
7030|Geringwertige Wirtschaftsgüter
7070|Pflichtbeiträge
7090|Sonstige Abgaben
7180|Sonstige Abgaben
7215|Instandhaltung Gebäude
7225|Instandhaltung Einrichtung
7320|Aufwand PKW
7321|Aufwand Anhängewagen
7325|Aufwand LKW
7330|Kilometergelder
7369|Reisespesen Unternehmer
7370|Postgebühren
7375|Telefon
7400|Miete und Pacht 20 %
7450|Geschäftsführung GmbH
7486|Leasing Renault Kangoo FK 214 GR - Elektroauto
7488|Leasing Opel e-Vivaro FK 202 GM
7489|Leasing Jobrad
7490|Leasing Suzuki Jimny FK 721 HC
7491|Leasing FK 170 IT E-Auto
7600|Büroaufwand
7650|Werbeaufwand
7700|Betriebliche Versicherungen
7750|Rechts- und Beratungskosten
7770|Fachliteratur, Seminare
7790|Bankspesen
7800|Schadensfälle
7813|Kursdifferenzen
7826|Skontoaufwand Ausland Schweiz 8,0 %
7850|Nicht abzugsfähiger Aufwand
8122|Zinserträge
8280|Zinsen
8500|Kapitalertragsteuer"""
ACCOUNTS = [
    {"number": line.split("|", 1)[0], "name": line.split("|", 1)[1]}
    for line in _RAW.splitlines()
    if "|" in line
]


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaCaptureAccountsV1" in page:
        ns["MOBILE_PAGE"] = page
        return

    options_json = json.dumps(ACCOUNTS, ensure_ascii=False)
    script = f"""
<script id="kristaCaptureAccountsV1">
(function(){{
  const accounts={options_json};
  const byNumber=new Map(accounts.map(x=>[String(x.number),x]));

  function esc(s){{return String(s??'').replace(/&/g,'&amp;').replace(/\"/g,'&quot;')}}
  function ensureList(){{
    let list=document.getElementById('kristaSachkontenList');
    if(!list){{
      list=document.createElement('datalist');
      list.id='kristaSachkontenList';
      list.innerHTML=accounts.map(x=>'<option value="'+esc(x.number)+'" label="'+esc(x.name)+'"></option>').join('');
      document.body.appendChild(list);
    }}
    return list;
  }}

  function attachAccounts(){{
    ensureList();
    const host=document.getElementById('captureAllocations');
    if(!host)return;
    host.querySelectorAll('[data-field="account"]').forEach(input=>{{
      if(input.dataset.kristaAccounts==='1')return;
      input.dataset.kristaAccounts='1';
      input.setAttribute('list','kristaSachkontenList');
      input.setAttribute('autocomplete','off');
      input.setAttribute('inputmode','numeric');
      input.placeholder='Kontonummer wählen';
      const label=input.parentElement?.querySelector('.formlabel');
      if(label&&label.textContent!=='Kontonummer / Konto')label.textContent='Kontonummer / Konto';
      const sync=()=>{{
        const item=byNumber.get(String(input.value||'').trim());
        input.title=item?item.number+' · '+item.name:'';
      }};
      input.addEventListener('input',sync);
      input.addEventListener('change',sync);
      sync();
    }});
  }}

  function start(){{
    attachAccounts();
    const host=document.getElementById('captureAllocations');
    if(host)new MutationObserver(attachAccounts).observe(host,{{childList:true,subtree:false}});
  }}

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{{once:true}});
  else start();
}})();
</script>
"""
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print(f"✅ Sachkonten: {len(ACCOUNTS)} nicht durchgestrichene Konten als Auswahl aktiv")
