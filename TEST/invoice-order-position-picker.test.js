const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "brain_outgoing_invoices.py"), "utf8");
const page = source.match(/OUTGOING_PAGE = r'''([\s\S]*?)'''/);
assert.ok(page, "Ausgangsrechnungs-Seite ist auffindbar");
for (const script of [...page[1].matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])) {
  new Function(script);
}

for (const text of [
  'offer-draft',
  'order-calculation',
  'order-lines-v2',
  'orderPositions',
  'position.get("isAlternative") is True',
  'offer_draft.get("groupDiscounts")',
  'Auftragspositionen auswählen',
  'Nur angehakte Positionen werden oberhalb der Regie übernommen',
  'Ausgewählte oberhalb der Regie übernehmen',
  'WinWorker oder KRISTINE',
  'mountOrderPositionPicker();mountInvoiceLiveTotals()',
]) {
  assert.ok(source.includes(text), `Rechnungseditor enthält ${text}`);
}

assert.ok(
  source.includes("appendEditorLine({description:p.description,quantity:p.quantity,unit:p.unit,unitPrice:p.unitPrice,discountPercent:p.discountPercent||0})"),
  "Ausgewählte Auftragspositionen werden mit Menge, Einheit, Preis und Rabatt übernommen",
);
assert.ok(
  source.includes("for(const line of existing)") && source.indexOf("for(const checkbox of selected)") < source.indexOf("for(const line of existing)"),
  "Auftragspositionen werden vor den bestehenden Regiezeilen eingesetzt",
);
assert.ok(
  source.includes("querySelector('[data-del]')?.click()"),
  "Übernommene Positionen verwenden weiterhin die normale Löschfunktion des Editors",
);

console.log("invoice order position picker checks passed");
