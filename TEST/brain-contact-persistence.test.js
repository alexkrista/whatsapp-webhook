"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "archive-connector.py"), "utf8");

assert.match(source, /let activeContactContext=null,contactDirty=false,contactSaving=false/);
assert.match(source, /contactForm\?\.addEventListener\('input',\(\)=>\{contactDirty=true\}\)/);
assert.match(source, /async function persistActiveContact\(\{closeAfter=false\}=\{\}\)/);
assert.match(source, /if\(contactDirty&&String\(contactPhone\.value\|\|''\)\.trim\(\)\)\{if\(!await persistActiveContact\(\{closeAfter:true\}\)\)return\}/);
assert.match(source, /document\.getElementById\('contactClose'\)\?\.addEventListener\('click',closeContacts\)/);
assert.match(source, /contactForm\?\.addEventListener\('submit',async e=>\{e\.preventDefault\(\);await persistActiveContact\(\)\}\)/);
assert.match(source, /fetch\('\/contacts',\{method:'POST'/);
assert.match(source, /contactDirty=false/);

const browserBlock = source.match(/(let activeContactContext=null[\s\S]*?)(?=\r?\nlet pdfState=)/)?.[1];
assert.ok(browserBlock, "contact browser code not found");
assert.doesNotThrow(() => new Function(browserBlock));

console.log("brain contact persistence tests passed");
