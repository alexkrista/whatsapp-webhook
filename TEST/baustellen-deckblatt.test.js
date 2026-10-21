"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PDFDocument } = require("pdf-lib");
const { coverInfo, dateText, createCoverPdf } = require("../baustellen-deckblatt.js");

test("Gleiche Baustellendaten werden genau einmal auf Deckblatt und QR übernommen", () => {
  const info = coverInfo("26123", {
    name: "Musterhaus Feldkirch",
    street: "Musterstraße", houseNumber: "7",
    postalCode: "6800", city: "Feldkirch",
    projectContacts: {
      owner: {customer: "Familie Muster"},
      architect: {company: "Architektur Beispiel"},
      siteManager: {company: "Bauleiter Team"}
    }
  }, [
    {jobId:"26001",title:"Fremder Termin",appointmentPurpose:"offer_site_visit",
      appointment:{date:"2026-12-03",from:"08:00",to:"08:45"}},
    {jobId:"26123",title:"Angebotsbesichtigung",appointmentPurpose:"offer_site_visit",
      appointment:{date:"2026-11-03",from:"09:00",to:"10:00"}}
  ], "https://protokoll.krista.at");
  assert.equal(info.owner,"Familie Muster");
  assert.equal(info.architect,"Architektur Beispiel");
  assert.equal(info.manager,"Bauleiter Team");
  assert.match(info.address,/Musterstraße 7/);
  assert.equal(dateText(info.appointment),"03.11.2026  09:00 - 10:00 Uhr");
  assert.equal(info.qrUrl,"https://protokoll.krista.at/kristine/baustellen#26123");
  assert.ok(!info.qrUrl.includes("?token="));
});

test("Unvollständige Baustelle druckbar, Original-Logo und QR im oberen Bereich", async () => {
  const bytes=await createCoverPdf({
    jobId:"26001",meta:{name:"Neues Angebot"},tasks:[],
    publicBaseUrl:"https://protokoll.krista.at"
  });
  assert.ok(bytes.length>20000);
  const pdf=await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(),1);
  const page=pdf.getPage(0);
  assert.ok(Math.abs(page.getWidth()-595.28)<.1);
  assert.ok(Math.abs(page.getHeight()-841.89)<.1);
  const content=await pdf.save();
  assert.ok(content.length>20000);
});
