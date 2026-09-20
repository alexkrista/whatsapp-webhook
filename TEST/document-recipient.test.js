"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveDocumentRecipient, createJobDocumentPdfRenderer } = require("../document-recipient");

const meta = owner => ({
  contactName:owner.customer || "",
  customerMaster:{ name:owner.customer || "", street:"Masterweg", houseNumber:"9", postalCode:"6800", city:"Feldkirch" },
  projectContacts:{ owner },
});

test("PDF-Empfänger werden aus strukturierten Privat- und Firmendaten eindeutig gebildet", () => {
  const cases = [
    ["Bauherrin", { ownerRole:"Bauherrschaft", customer:"Eva Muster", womanFirstName:"Eva", womanLastName:"Muster" }, ["Frau Eva Muster"]],
    ["Bauherr", { ownerRole:"Bauherrschaft", customer:"Max Muster", manFirstName:"Max", manLastName:"Muster" }, ["Herr Max Muster"]],
    ["Paar", { ownerRole:"Bauherrschaft", customer:"Familie Muster", womanFirstName:"Eva", womanLastName:"Muster", manFirstName:"Max", manLastName:"Muster" }, ["Frau Eva Muster", "Herr Max Muster"]],
    ["Dubletten", { ownerRole:"Bauherrschaft", customer:"Brigitte Baldauf", womanFirstName:"Brigitte", womanLastName:"Baldauf", manFirstName:"Brigitte", manLastName:"Baldauf" }, ["Frau Brigitte Baldauf"]],
    ["singuläre Rolle", { ownerRole:"Bauherr", customer:"Max Muster", womanLastName:"Max Muster", manLastName:"Max Muster" }, ["Herr Max Muster"]],
    ["mehrdeutige Altdaten", { ownerRole:"Bauherrschaft", customer:"Egon Muster", womanLastName:"Egon Muster", manLastName:"Egon Muster" }, ["Egon Muster"]],
    ["Firma", { ownerRole:"Firma", customer:"Beispiel GmbH" }, ["Firma Beispiel GmbH"]],
    ["Firma ohne Doppelpräfix", { ownerRole:"Firma", customer:"Firma Kugelfink" }, ["Firma Kugelfink"]],
    ["Firma mit Bauherrin", { ownerRole:"Firma", customer:"Beispiel GmbH", womanFirstName:"Eva", womanLastName:"Muster" }, ["Firma Beispiel GmbH", "z. H. Frau Eva Muster"]],
    ["Firma mit Bauherr", { ownerRole:"Firma", customer:"Beispiel GmbH", manFirstName:"Max", manLastName:"Muster" }, ["Firma Beispiel GmbH", "z. H. Herr Max Muster"]],
    ["Firmenname ist keine Person", { ownerRole:"Firma", customer:"Beispiel GmbH", womanLastName:"Beispiel GmbH", manLastName:"Beispiel GmbH" }, ["Firma Beispiel GmbH"]],
    ["Sonderzeichen bleiben Text", { ownerRole:"Firma", customer:"<b>Alpha</b> & Co" }, ["Firma <b>Alpha</b> & Co"]],
  ];
  for (const [label, owner, expected] of cases) {
    assert.deepEqual(resolveDocumentRecipient(meta(owner)).nameLines, expected, label);
  }
});

test("PDF-Empfängeradresse bevorzugt Wohnadresse und ergänzt strukturierte Stammdaten", () => {
  const result = resolveDocumentRecipient({
    customerMaster:{ name:"Eva Muster", address:"Altweg 1, 9999 Altort", street:"Masterweg", houseNumber:"9", postalCode:"6800", city:"Feldkirch", country:"Österreich" },
    projectContacts:{ owner:{ ownerRole:"Bauherrin", customer:"Eva Muster", residentialStreet:"Wohnweg", residentialHouseNumber:"7" } },
  });
  assert.deepEqual(result.nameLines, ["Frau Eva Muster"]);
  assert.deepEqual(result.addressLines, ["Wohnweg 7", "6800 Feldkirch", "Österreich"]);
  assert.throws(() => resolveDocumentRecipient({}), error => error.code === "DOCUMENT_RECIPIENT_INVALID" && /Empfänger/.test(error.message));
  assert.throws(() => resolveDocumentRecipient(meta({ ownerRole:"Firma", customer:"Firma" })), /Firmennamen/);
});

test("Server-Renderer nutzt für finale PDFs nur die explizite Baustelle und liest Stammdaten frisch", async () => {
  const records = {
    "26101":meta({ ownerRole:"Firma", customer:"Beispiel GmbH" }),
    "26102":meta({ ownerRole:"Bauherr", customer:"Max Muster" }),
  };
  const reads = [], renders = [];
  const render = createJobDocumentPdfRenderer({
    renderPdf:async (html, options) => { renders.push({ html, options }); return options; },
    readJobMeta:async id => { reads.push(id); return records[id]; },
    isSafeJobId:id => /^[A-Za-z0-9_-]+$/.test(id),
    jobExists:async id => Object.hasOwn(records, id),
  });

  const final = await render("<p>Projekt: 26102</p>", { jobId:"26101" });
  assert.deepEqual(reads, ["26101"]);
  assert.deepEqual(final.recipient.nameLines, ["Firma Beispiel GmbH"]);
  assert.equal(final.requireRecipient, true);

  const preview = await render("<p>Vorschau</p>", { inferRecipientJobId:true });
  assert.equal(typeof preview.resolveRecipient, "function");
  assert.equal(await preview.resolveRecipient("../26101"), null);
  assert.equal(await preview.resolveRecipient("99999"), null);
  assert.deepEqual((await preview.resolveRecipient("26102")).nameLines, ["Herr Max Muster"]);
  records["26102"] = meta({ ownerRole:"Bauherr", customer:"Peter Neu" });
  assert.deepEqual((await preview.resolveRecipient("26102")).nameLines, ["Herr Peter Neu"]);
  await assert.rejects(() => render("", { jobId:"../26101" }), /Ungültige Baustellennummer/);
  assert.equal(renders[0].html, "<p>Projekt: 26102</p>");
});

test("Angebotsroute erzwingt die Baustellen-ID; freigegebene Upload-PDF bleibt unverändert", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(source, /renderJobDocumentPdf\(req\.body,\{jobId\}\)/);
  assert.match(source, /const pdf=originalPdf,storedName=/);
  assert.doesNotMatch(source, /renderJobDocumentPdf\(originalPdf/);
});
