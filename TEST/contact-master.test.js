"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { candidatesFromMeta, mergeCandidates, searchContacts, createContactMasterStore } = require("../contact-master");

test("Projektkontakte werden strukturiert als dauerhaftes KRISTINE-Wissen gesammelt", () => {
  const meta = {
    wwAddressId: "4711",
    wwCustomerNumber: "10815",
    projectContacts: {
      owner: {
        customer: "Familie Beispiel",
        ownerRole: "Familie",
        womanFirstName: "Erika",
        womanLastName: "Beispiel",
        womanEmail: "erika@example.at",
        residentialStreet: "Dorfstraße",
        residentialHouseNumber: "7",
        residentialPostalCode: "6820",
        residentialCity: "Frastanz",
      },
      siteManager: {
        company: "Planbüro Klar",
        firstName: "Max",
        lastName: "Planer",
        email: "max@planung.at",
        street: "Marktgasse",
        houseNumber: "2",
        postalCode: "6800",
        city: "Feldkirch",
      },
      architect: {},
    },
  };
  const merged = mergeCandidates([], candidatesFromMeta("26100", meta), "2026-09-18T20:00:00.000Z");
  assert.equal(merged.contacts.length, 2);
  const owner = merged.contacts.find(row => row.roles.includes("owner"));
  assert.equal(owner.wwAddressId, "4711");
  assert.equal(owner.address, "Dorfstraße, 7, 6820 Frastanz");
  assert.equal(owner.roleData.owner.womanFirstName, "Erika");
  const found = searchContacts(merged.contacts, "Beispiel 6820", "owner");
  assert.equal(found.length, 1);
  assert.equal(found[0].id, merged.ids.owner);
  assert.equal(searchContacts(merged.contacts, "", "siteManager").length, 1);
});

test("derselbe Kontakt wird ergänzt statt für Bauleitung und Architekt dupliziert", () => {
  const first = mergeCandidates([], candidatesFromMeta("26100", {
    projectContacts: { owner: {}, siteManager: { company: "Planbüro Klar", firstName: "Max", lastName: "Planer", email: "max@planung.at" }, architect: {} },
  }), "2026-09-18T20:00:00.000Z");
  const second = mergeCandidates(first.contacts, candidatesFromMeta("26101", {
    projectContacts: { owner: {}, siteManager: {}, architect: { company: "Planbüro Klar", firstName: "Max", lastName: "Planer", email: "max@planung.at", phone: "+43 664 123" } },
  }), "2026-09-18T21:00:00.000Z");
  assert.equal(second.contacts.length, 1);
  assert.deepEqual(second.contacts[0].roles.sort(), ["architect", "siteManager"]);
  assert.deepEqual(second.contacts[0].projectIds, ["26100", "26101"]);
  assert.equal(second.contacts[0].phone, "+43 664 123");
  assert.equal(second.ids.architect, first.ids.siteManager);
});

test("Kontaktstamm wird dauerhaft geschrieben und anschließend durchsuchbar", async t => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "krista-contact-master-"));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const store = createContactMasterStore({ dataDir, readJobMeta: async () => ({}), isJobId: () => true });
  const ids = await store.captureJob("26102", {
    projectContacts: { owner: {}, siteManager: {}, architect: { company: "Atelier Wissen", firstName: "Mia", lastName: "Plan", email: "mia@wissen.at" } },
  });
  assert.ok(ids.architect);
  const rows = await store.search("Atelier Wissen", "architect", 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].roleData.architect.firstName, "Mia");
  const stored = JSON.parse(await fsp.readFile(path.join(dataDir, "_kristine", "contact-master.json"), "utf8"));
  assert.equal(stored.length, 1);
});

test("Firmendaten samt UID und Quelle werden im Kontaktstamm wiederverwendet",()=>{
  const first=mergeCandidates([],candidatesFromMeta("26101",{projectContacts:{owner:{ownerRole:"Firma",customer:"Beispiel GmbH",uid:"ATU12345678",sourceUrl:"https://example.at/impressum",womanEmail:"person@example.at",wwAddressId:"4711"}}}));
  const found=searchContacts(first.contacts,"Beispiel","owner")[0];
  assert.equal(found.roleData.owner.uid,"ATU12345678");assert.equal(found.roleData.owner.sourceUrl,"https://example.at/impressum");assert.equal(found.roleData.owner.manLastName,"");
  const next=mergeCandidates(first.contacts,candidatesFromMeta("26102",{projectContacts:{owner:{...found.roleData.owner,womanEmail:"neu@example.at"}}}));
  assert.equal(next.contacts.length,1);assert.equal(next.contacts[0].email,"neu@example.at");assert.equal(next.contacts[0].wwAddressId,"4711");
});
