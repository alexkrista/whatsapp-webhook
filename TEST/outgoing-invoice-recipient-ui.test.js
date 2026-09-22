"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outgoing = fs.readFileSync(path.join(root, "brain_outgoing_invoices.py"), "utf8");
const hub = fs.readFileSync(path.join(root, "public", "ui", "baustellen-knowledge-hub.js"), "utf8");
const page = outgoing.match(/OUTGOING_PAGE = r'''([\s\S]*?)'''/);

assert.ok(page, "Ausgangsrechnungsseite fehlt");
const script = page[1].match(/<script>([\s\S]*?)<\/script>/);
assert.ok(script, "Ausgangsrechnungs-Skript fehlt");
assert.doesNotThrow(() => new Function(script[1]), "Ausgangsrechnungs-Skript muss gültiges JavaScript sein");

assert.match(outgoing, /id="invoiceRecipientBlock"/);
assert.match(outgoing, /Rechnungsempfänger/);
assert.match(outgoing, /Diese Anschrift wird auf die PDF gedruckt/);
assert.match(outgoing, /z\. H\. \$\{name\}/);
assert.match(outgoing, /id="editorEditRecipient"/);
assert.match(outgoing, /id="addressUpdateMaster"/);
assert.match(outgoing, /updateMaster=\$\('addressUpdateMaster'\)\.checked/);
assert.match(outgoing, /editorOpen=!!\$\('editorTitle'\)/);
assert.match(outgoing, /block\.outerHTML=invoiceRecipientBlock\(selectedRun\)/);
assert.match(outgoing, /legally relevant recipient snapshot/);

const recipientSource = script[1].match(/function recipientLines\(r\)\{[^\n]+\}/);
assert.ok(recipientSource, "Empfängerformatierung fehlt");
const recipientLines = new Function(`return (${recipientSource[0]})`)();
assert.deepEqual(recipientLines({
  customer_company: "Vplus GmbH",
  customer_name: "Street-smart Heller KG",
  customer_street: "Färbergasse 15",
  customer_postal_code: "6850",
  customer_city: "Dornbirn",
  customer_country: "Österreich",
}), ["Vplus GmbH", "z. H. Street-smart Heller KG", "Färbergasse 15", "6850 Dornbirn"]);

assert.match(hub, /isCompany=String\(owner\.ownerRole/);
assert.match(hub, /company=isCompany\?\(owner\.customer/);
assert.match(hub, /people\.join\(' und '\)/);

const contextSource = hub.match(/function invoiceProjectContext\(j\)\{[\s\S]*?\n  \}/);
assert.ok(contextSource, "Rechnungsübergabe aus der Baustelle fehlt");
const invoiceProjectContext = new Function(`return (${contextSource[0]})`)();
const context = invoiceProjectContext({
  jobId: "26097",
  name: "Regiearbeiten",
  projectContacts: { owner: {
    ownerRole: "Firma",
    customer: "Vplus GmbH",
    womanLastName: "Street-smart Heller KG",
    residentialStreet: "Färbergasse",
    residentialHouseNumber: "15",
    residentialPostalCode: "6850",
    residentialCity: "Dornbirn",
  } },
});
assert.equal(context.company, "Vplus GmbH");
assert.equal(context.customer, "Street-smart Heller KG");
assert.equal(context.street, "Färbergasse 15");

console.log("outgoing invoice recipient UI checks passed");
