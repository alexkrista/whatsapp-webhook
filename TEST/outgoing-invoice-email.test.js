"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path"),source=fs.readFileSync(path.resolve(__dirname,"..","brain_outgoing_invoices.py"),"utf8");
for(const text of ["/send-email","Per E-Mail senden","Mit farbenfrohen Grüßen aus Frastanz","MMSt. Ing. Alexander Krista","krista_invoice_logo.png","rechnungsversand.jsonl"])assert.ok(source.includes(text),text);
assert.ok(source.includes("für die bisher erbrachten Leistungen"));
assert.match(source,/invoice\.get\("status"\).*!= "issued"/s);
assert.match(source,/mail\.add_attachment\(pdf_path\.read_bytes\(\)/);
console.log("outgoing invoice email test: ok");
