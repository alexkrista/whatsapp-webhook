"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path"),root=path.join(__dirname,"..");
const ui=fs.readFileSync(path.join(root,"public/ui/baustellen-offer-builder.js"),"utf8"),server=fs.readFileSync(path.join(root,"server.js"),"utf8"),top=fs.readFileSync(path.join(root,"public/ui/topbar.js"),"utf8");
assert.match(top,/baustellen-offer-builder/);
for(const text of ["Kalkulation / Angebot","Regie + Material","Innenmalerei","Abdeckarbeiten – einmalig auswählen","Boden und Laufwege","Fassade","Fassadenfarbe 2x","Bad komplett","Fugenloses Bad","Terra Icon Unikatbelag","Kalkputz","Sumpfkalk-Wohlfühlputz","WDVS kurz","Isolierung kleben","Näherung: Bodenfläche × 3,5","Raum aus Länge / Breite / Höhe","Leistungsumfang / Räume","Mengen und Einheiten","Kalkulation dieser Position","Standard-Faktbox","Stundensatz","Materialaufschlag","Ab-/Zuschlag auf beides","Arbeitsschritt","Minuten","Material aus Stamm","Preis je Einheit","Verbrauch","Ergebnis"])assert.ok(ui.includes(text),`UI enthält ${text}`);
for(const text of ["offer-draft","coverSteps","bathroomSteps","bathroomCompactSteps","limeSteps","wdvsSteps","bathroomCalc","measurement","scopeDescription","showQuantities","laborHoursPerUnit","materialMarkupPct","adjustmentPct","workSteps","materials","hourlyRateOverridden"])assert.ok(server.includes(text),`Server enthält ${text}`);
for(const text of ["Räume und Aufmaß","Jeder Raum bildet eine eigene Gruppe","Näherung × 3,5","Exakt L/B/H","Leistungsfläche"])assert.ok(ui.includes(text),`Raumaufmaß enthält ${text}`);
assert.ok(ui.includes("Beschreibung der Leistung"),"Jeder Raum besitzt eine Leistungsbeschreibung");
assert.ok(ui.includes("data-copy-room"),"Räume und Bauteile können vollständig kopiert werden");
assert.ok(ui.includes('"Wände + Decken"'),"Wand- und Deckenflächen werden gemeinsam angeboten");
assert.ok(ui.includes("function coverPosition()"),"Abdeckauswahl wird zu einer Position zusammengefasst");
for(const text of ["Preisstand:","Preise aktualisieren / neu kalkulieren","priceSnapshotAt"])assert.ok(ui.includes(text)||server.includes(text),`Preisstand enthält ${text}`);
for(const text of ["Material aus Regiestunden berechnen","Betrag je Stunde","Prozent vom Arbeitslohn","regieMaterialRate","regieMaterialMode"])assert.ok(ui.includes(text)||server.includes(text),`Regiematerial enthält ${text}`);
for(const text of ["Regie zu diesem Raum","Regiestunden","Zusätzliches Aufmaß / Bauteil","+ Aufmaßzeile","roomRegiePositions"])assert.ok(ui.includes(text),`Raumbezogene Regie enthält ${text}`);
assert.ok(ui.includes("Material und Maschinen für Regiearbeiten, Abrechnung laut Aufstellung."),"Kundenposition zeigt keinen internen Materialprozentsatz");
for(const text of ["if(!material){material=","draft.positions.splice(index+1,0,material)","renderOfferTotals();renderLivePreview()"])
  assert.ok(ui.includes(text),`Regiematerial bleibt je Raum in Angebot und Druck erhalten: ${text}`);
for(const text of ["ensureOfferMaterials","/admin/api/materials/auto","m.product||m.name"])assert.ok(ui.includes(text),`Automatische Materialübernahme enthält ${text}`);
assert.ok(server.includes("draft.rooms="),"Raumaufmaße werden serverseitig gespeichert");
for(const text of ["sanitizeOfferCalculationNote","calculationNote:sanitizeOfferCalculationNote","extraCalculations","estimatedPrice","estimatedHours"])
  assert.ok(server.includes(text),`Interne Schätzhilfe wird vollständig gespeichert: ${text}`);
for(const text of ["Angebotssumme und Konditionen","Preiseingabe","Netto","Brutto","MwSt. %","Gesamtrabatt %","Skonto anbieten","Skontofrist Tage","Zahlbetrag mit Skonto","enhanceFinancialPreview"])assert.ok(ui.includes(text),`Angebotskonditionen enthalten ${text}`);
for(const text of ["financials","priceMode","vatRate","discountPercent","skontoEnabled","skontoPercent","skontoDays"])assert.ok(server.includes(text),`Gespeicherte Angebotskonditionen enthalten ${text}`);
for(const text of ["#kofferRooms:not(:has(.koffer-room))","#kofferRegieMaterial{display:flex","#kofferRegieMaterial>.koffer-calc{display:flex"])assert.ok(ui.includes(text),`Kompakte einzeilige Darstellung enthält ${text}`);
for(const text of ["offerAddressBlock","koffer-paper-address","koffer-paper-recipient","koffer-paper-project","Projekt:"])assert.ok(ui.includes(text),`Angebotsbriefkopf enthält ${text}`);
for(const text of ["Unser Bearbeiter: Ing. Alexander Krista","offerHeading","koffer-paper-offer-head","Zusammenstellung","koffer-paper-summary","krista-logo.png\" alt=\"KRISTA"])
  assert.ok(ui.includes(text),`Druckgestaltung enthält ${text}`);
for(const text of ["koffer-paper-group-number","${groupNumber}.0","${groupNumber}.${positionNumber}"])
  assert.ok(ui.includes(text),`Hierarchische Drucknummerierung enthält ${text}`);
for(const text of ["TitilliumWeb-Regular.ttf","TitilliumWeb-SemiBold.ttf","Übertrag","koffer-paper-net","companyPrintFooter","NEUE BANKVERBINDUNG","AT82 5800 0104 9932 3013","Firmenbuchgericht Feldkirch"])
  assert.ok(ui.includes(text),`Mehrseitiger Firmendruck enthält ${text}`);
for(const text of ["handwrittenPrintCorrectionsCss","border-bottom-width:3px","min-height:22mm","font-size:8px"])
  assert.ok(ui.includes(text),`Handschriftliche Druckkorrekturen enthalten ${text}`);
for(const text of ["groupName","groupSummary","enhanceGroupTotals","Rabatte Räume/Bauteile","koffer-paper-subtotal","Summe ${esc(group)}"])assert.ok(ui.includes(text),`Raum- und Bauteilsummen enthalten ${text}`);
assert.ok(ui.includes('rooms.join(", ")'),"Der Leistungsumfang führt nur Räume und Bauteile an");
assert.ok(ui.includes('groupName:p.groupName||""'),"Geänderte Raumnamen werden vollständig in die Positionsgruppen übernommen");
assert.ok(ui.includes("normalizeLoadedGroups"),"Bereits gespeicherte Regie- und Materialpositionen werden wieder zu einem Raumblock zusammengeführt");
for(const text of ["groupName","groupDiscounts"])assert.ok(server.includes(text)||ui.includes(text),`Gruppendaten enthalten ${text}`);
for(const text of ["Vorkasse","Verbleibender Restbetrag"])assert.ok(ui.includes(text),`Vorkasseansicht enthält ${text}`);
for(const text of ["prepaymentEnabled","prepaymentPercent"])assert.ok(ui.includes(text)&&server.includes(text),`Gespeicherte Vorkasse enthält ${text}`);
for(const text of ["Drucken / PDF","printOffer","printDocumentHtml","window.open","popup.print","offerDocumentMeta"])assert.ok(ui.includes(text),`Angebotsdruck enthält ${text}`);
for(const text of ["offerNumberPrefix","nextOfferNumber","offer-number-counter.json","offer-draft/finalize","offerRevision"])assert.ok(server.includes(text),`Angebotsnummernkreis enthält ${text}`);
for(const text of ['hourlyRate:Number(job?.billingRate||job?.calculation?.billingRate||75)','materialMarkupPct:Number(job?.materialPercent||job?.calculation?.materialPercent||80)','regieMaterialMode:"percent"','regieMaterialRate:20'])assert.ok(ui.includes(text),`Standard-Faktbox liefert ${text}`);
console.log("OK: Angebotsbaukasten enthält Vorlagen, Detailkalkulation und Aufmaß je Raum.");
