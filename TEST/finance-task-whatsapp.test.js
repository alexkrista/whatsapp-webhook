"use strict";

const assert = require("assert");
const { financeTaskWhatsAppDetail } = require("../finance-task-whatsapp");

const technical = "[FINANCE_APPROVAL]source=KRISTINE;id=kristine%3A13;doc=11502600386;invoice=090091477208;amount=1899.06;currency=EUR;decision=pending";
const visible = financeTaskWhatsAppDetail(technical);

assert.strictEqual(visible, "💶 Betrag: € 1.899,06");
assert.doesNotMatch(visible, /FINANCE_APPROVAL|source=|invoice=|decision=/);
assert.strictEqual(financeTaskWhatsAppDetail("Bitte Kunde anrufen"), "");

console.log("OK: Rechnungsfreigaben zeigen in WhatsApp nur den lesbaren Betrag.");
