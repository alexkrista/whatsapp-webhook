"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isTestRecipient } = require("../task-digest");

test("Mock-Mitarbeiter werden nicht als echte WhatsApp-Empfänger behandelt", () => {
  assert.equal(isTestRecipient(
    { id: "edmund-mock-mreyk5vk-k27g", name: "Edmund Mock", phone: "0043 650 000000" },
    "edmund-mock-mreyk5vk-k27g",
    "Edmund Mock",
  ), true);
  assert.equal(isTestRecipient(
    { id: "max-mustermann", name: "Max Mustermann", phone: "0043 650 123456" },
    "max-mustermann",
    "Max Mustermann",
  ), false);
});

test("Explizit markierte Testdatensätze werden unterdrückt", () => {
  assert.equal(isTestRecipient({ id: "probe", name: "Probe", isTest: true }, "probe", "Probe"), true);
});
