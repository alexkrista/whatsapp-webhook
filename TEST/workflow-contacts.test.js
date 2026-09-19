"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAddress,
  structuredAddress,
  projectContactsFromMaster,
  portalRecipientOptions,
} = require("../workflow-contacts");

test("Baustellenadresse wird in echte Stammdatenfelder zerlegt", () => {
  assert.deepEqual(parseAddress("Im Tobel 14, 6820 Frastanz"), {
    street: "Im Tobel",
    houseNumber: "14",
    postalCode: "6820",
    city: "Frastanz",
    addressExtra: "",
    formatted: "Im Tobel 14, 6820 Frastanz",
  });
});

test("Adresszusatz bleibt Zusatz und die komplette Adresse wird nicht Beschreibung", () => {
  const address = structuredAddress({ address: "Reichsstraße 3a, 6800 Feldkirch, Top 4" });
  assert.equal(address.street, "Reichsstraße");
  assert.equal(address.houseNumber, "3a");
  assert.equal(address.postalCode, "6800");
  assert.equal(address.city, "Feldkirch");
  assert.equal(address.addressExtra, "Top 4");
});

test("Kundenname wird als Bauherrschaft statt als Beschreibung übernommen", () => {
  const contacts = projectContactsFromMaster({ role: "customer", name: "Egon Beispiel", phone: "+43 1", email: "egon@example.at" });
  assert.equal(contacts.owner.customer, "Egon Beispiel");
  assert.equal(contacts.owner.phoneOwnerMan, "+43 1");
  assert.equal(contacts.owner.email, "egon@example.at");
  assert.equal(portalRecipientOptions({ projectContacts: contacts })[0].name, "Egon Beispiel");
});

test("Bauherr, Bauleitung und Architekt werden als getrennte Empfänger angeboten", () => {
  const options = portalRecipientOptions({
    projectContacts: {
      owner: { customer: "Familie Beispiel", email: "bauherr@example.at" },
      siteManager: { firstName: "Berta", lastName: "Bauleitung", email: "bauleitung@example.at" },
      architect: { company: "Architekturbüro Form", email: "architektur@example.at" },
    },
  });
  assert.deepEqual(options.map(row => row.id), ["owner", "siteManager", "architect"]);
});
