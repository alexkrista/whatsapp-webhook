"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { listJobMedia } = require("../media-migration");

test("listJobMedia zeigt zentral gespeicherte KGO-Fotos der Baustelle", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "kristine-media-"));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const relativeFile = "_kristine/media/2026-09-02/employee-1/1788331200_photo.jpg";
  await fsp.mkdir(path.join(dataDir, "_kristine", "media", "2026-09-02", "employee-1"), { recursive: true });
  await fsp.writeFile(path.join(dataDir, ...relativeFile.split("/")), "photo");
  await fsp.writeFile(path.join(dataDir, "_kristine", "day-review-entries.json"), JSON.stringify([
    {
      id: "kgo-photo-1",
      jobId: "26083",
      date: "2026-09-02",
      at: "09:15",
      employeeId: "employee-1",
      employeeName: "Max Muster",
      file: relativeFile,
      source: "photo",
      content: "Fortschritt",
    },
    {
      id: "other-job-photo",
      jobId: "99999",
      date: "2026-09-02",
      file: relativeFile,
    },
  ]));

  const media = await listJobMedia({ dataDir, jobId: "26083" });

  assert.equal(media.length, 1);
  assert.equal(media[0].id, "kgo-photo-1");
  assert.equal(media[0].jobId, "26083");
  assert.equal(media[0].employeeName, "Max Muster");
  assert.equal(media[0].content, "Fortschritt");
  assert.match(media[0].url, /^\/admin\/api\/job\/26083\/media-file\?/);
});

