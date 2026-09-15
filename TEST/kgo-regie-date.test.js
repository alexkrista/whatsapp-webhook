const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../public/kristine-go.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/kristine-go.html"), "utf8");

function functionSource(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} fehlt`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} ist unvollständig`);
}

const previousISODate = Function(`return (${functionSource("previousISODate")})`)();

test("Gestern funktioniert über Monats- und Jahresgrenzen", () => {
  assert.equal(previousISODate("2026-09-15"), "2026-09-14");
  assert.equal(previousISODate("2026-03-01"), "2026-02-28");
  assert.equal(previousISODate("2026-01-01"), "2025-12-31");
  assert.equal(previousISODate("2024-03-01"), "2024-02-29");
});

test("Regie fragt zuerst Heute oder Gestern und übergibt das Datum", () => {
  assert.match(source, /Für welchen Tag ist der Regiebericht\?/);
  assert.match(source, /Heute · \$\{shortDate\(today\)\}/);
  assert.match(source, /Gestern · \$\{shortDate\(yesterday\)\}/);
  assert.match(source, /date=\$\{encodeURIComponent\(selectedDate\)\}/);
  assert.match(html, /kristine-go\.js\?v=11/);
});
