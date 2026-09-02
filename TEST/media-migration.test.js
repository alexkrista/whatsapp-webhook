"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { listJobMedia, listJobKnowledge } = require("../media-migration");

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

test("listJobKnowledge fuehrt alle KGO-Eintraege einer Baustelle zusammen", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "kristine-knowledge-"));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "_kristine");
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(path.join(dataDir, "26083", "2026", "09", "02"), { recursive: true });
  const write = (name, value) => fsp.writeFile(path.join(root, name), JSON.stringify(value));
  await Promise.all([
    write("day-review-entries.json", [{ id: "review-1", jobId: "26083", category: "note", content: "Untergrund prüfen" }]),
    write("material-requests.json", [{ id: "mat-1", jobId: "26083", materialText: "5 Liter Farbe" }, { id: "foreign", jobId: "99999" }]),
    write("tasks.json", [{ id: "task-1", jobId: "26083", title: "Abkleben" }]),
    write("assignments.json", [{ id: "assignment-1", jobId: "26083", note: "Schlüssel holen" }]),
    write("time-events.json", [{ id: "time-1", jobId: "26083", type: "start" }]),
    write("appointments.json", [{ id: "appointment-1", taskId: "task-1", date: "2026-09-03" }]),
    write("visit-workflows.json", [{ id: "workflow-1", taskId: "task-1", timeline: [{ type: "call", label: "Anruf" }] }]),
    fsp.writeFile(path.join(root, "events.jsonl"), `${JSON.stringify({ type: "employee_message", jobId: "26083", detail: "Kunde kommt später" })}\n${JSON.stringify({ type: "employee_message", jobId: "99999", detail: "fremd" })}\n`),
    fsp.writeFile(path.join(dataDir, "26083", "2026", "09", "02", "log.jsonl"), `${JSON.stringify({ type: "text", text: "Fensterbank ist beschädigt", at: "2026-09-02T09:30:00Z" })}\n`),
  ]);

  const result = await listJobKnowledge({ dataDir, jobId: "26083" });

  assert.equal(result.reviews.length, 1);
  assert.equal(result.materialRequests.length, 1);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.assignments.length, 1);
  assert.equal(result.timeEvents.length, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.appointments.length, 1);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.protocolEntries.length, 1);
  assert.equal(result.protocolEntries[0].text, "Fensterbank ist beschädigt");
  assert.equal(result.counts.messages, 1);
});
