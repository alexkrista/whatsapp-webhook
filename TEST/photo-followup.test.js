"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { saveJobPhoto, listJobMedia } = require("../media-migration");

async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "krista-photo-followup-"));
  try {
    const jobId = "26001";
    const jobDir = path.join(dataDir, jobId);
    const originalMeta = { jobId, name: "Geschlossene Testbaustelle", status: "Geschlossen", archived: true };
    await fsp.mkdir(jobDir, { recursive: true });
    await fsp.writeFile(path.join(jobDir, ".meta.json"), JSON.stringify(originalMeta), "utf8");

    const result = await saveJobPhoto({
      dataDir,
      jobId,
      raw: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      filename: "Fassade fertig.jpg",
      mimeType: "image/jpeg",
      employeeId: "alex",
      employeeName: "Alexander Krista",
      caption: "Schöne Abschlussaufnahme",
      source: "KRISTINE",
    });

    assert.equal(result.jobId, jobId);
    assert.equal(result.lateUpload, true);
    assert.equal(result.content, "Schöne Abschlussaufnahme");
    assert.equal(fs.existsSync(path.join(dataDir, ...result.file.split("/"))), true);

    const metaAfter = JSON.parse(await fsp.readFile(path.join(jobDir, ".meta.json"), "utf8"));
    assert.deepEqual(metaAfter, originalMeta, "Foto-Nachreichung darf Status und Archivierung nicht verändern");

    const reviewRows = JSON.parse(await fsp.readFile(path.join(dataDir, "_kristine", "day-review-entries.json"), "utf8"));
    assert.equal(reviewRows.length, 1);
    assert.equal(reviewRows[0].jobId, jobId);

    const media = await listJobMedia({ dataDir, jobId });
    assert.equal(media.length, 1);
    assert.equal(media[0].content, "Schöne Abschlussaufnahme");

    await assert.rejects(
      saveJobPhoto({ dataDir, jobId: "99999", raw: Buffer.from("x"), filename: "x.jpg", mimeType: "image/jpeg" }),
      /nicht gefunden/
    );

    const client = await fsp.readFile(path.join(__dirname, "..", "public", "ui", "krista-photo-followup.js"), "utf8");
    assert.match(client, /slice\(0, 10\)/, "zeigt die letzten zehn Baustellen");
    assert.match(client, /admin\/api\/jobs/, "durchsucht alle Baustellen");
    assert.match(client, /capture=\\?"environment\\?"|capture=environment/, "bietet die Handykamera an");
    assert.match(client, /addEventListener\(\"paste\"/, "unterstützt Einfügen vom PC");
    assert.match(client, /addEventListener\(\"drop\"/, "unterstützt Drag & Drop");

    for (const page of ["kristine-go.html", "kristine.html", "baustellen.html"]) {
      const html = await fsp.readFile(path.join(__dirname, "..", "public", page), "utf8");
      assert.match(html, /krista-photo-followup\.js/, `${page} bindet die Foto-Nachreichung ein`);
    }
    console.log("photo-followup: ok");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
