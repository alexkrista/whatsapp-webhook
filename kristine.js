
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function registerKristine(app, { dataDir, requireAdmin, publicDir }) {
  const ROOT = path.join(dataDir, "_kristine");
  const ASSIGNMENTS = path.join(ROOT, "assignments.json");
  const STATES = path.join(ROOT, "states.json");
  const TASKS = path.join(ROOT, "tasks.json");
  const EVENTS = path.join(ROOT, "events.jsonl");

  async function ensureRoot() {
    await fsp.mkdir(ROOT, { recursive: true });
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async function writeJson(file, value) {
    await ensureRoot();
    await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  }

  async function appendEvent(event) {
    await ensureRoot();
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    await fsp.appendFile(EVENTS, line, "utf8");
  }

  function localDateISO(d = new Date()) {
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }

  function normalizeText(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/[.!?,;:]+/g, "")
      .replace(/\s+/g, " ");
  }

  function detectIntent(text) {
    const t = normalizeText(text);
    if (/^(start|beginn|los|arbeitsbeginn|geht los|auf gehts)$/.test(t)) return "start";
    if (/^(pause|kaffee|kaffeepause|kurze pause)$/.test(t)) return "pause";
    if (/^(mittag|essen|mittagspause|mahlzeit)$/.test(t)) return "lunch";
    if (/^(weiter|wieder da|geht weiter|pause fertig|los gehts)$/.test(t)) return "resume";
    if (/^(fertig|feierabend|schluss|wir sind fertig|bin fertig)$/.test(t)) return "finish";
    if (/^(ja|jup|passt|ok|okay|genau|👍)$/.test(t)) return "yes";
    if (/^(nein|passt nicht|falsch|👎)$/.test(t)) return "no";
    if (/^(status|wo bin ich|was steht an|heute)$/.test(t)) return "status";
    if (/^(erledigt|aufgabe erledigt)$/.test(t)) return "task_done";
    return "message";
  }

  function assignmentKey(a) {
    return `${a.date}|${a.employeeId}|${a.from || ""}|${a.jobId || ""}`;
  }

  function sortedAssignments(items) {
    return [...items].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      String(a.from || "").localeCompare(String(b.from || ""))
    );
  }

  function assignmentsFor(items, employeeId, date) {
    return sortedAssignments(items.filter(a =>
      String(a.employeeId) === String(employeeId) &&
      String(a.date) === String(date)
    ));
  }

  function activeAssignment(dayAssignments, state) {
    if (state?.activeAssignmentKey) {
      const found = dayAssignments.find(a => assignmentKey(a) === state.activeAssignmentKey);
      if (found) return found;
    }
    return dayAssignments[0] || null;
  }

  function nextAssignment(dayAssignments, current) {
    if (!current) return dayAssignments[0] || null;
    const idx = dayAssignments.findIndex(a => assignmentKey(a) === assignmentKey(current));
    return idx >= 0 ? dayAssignments[idx + 1] || null : null;
  }

  function assignmentLabel(a) {
    if (!a) return "keine Baustelle";
    return `${a.jobName || ("#" + a.jobId)}${a.city ? ", " + a.city : ""}`;
  }

  function stateLabel(state) {
    const map = {
      idle: "noch nicht gestartet",
      working: "arbeitet",
      pause: "Pause",
      lunch: "Mittagspause",
      finished_site: "Baustelle fertig",
      finished_day: "Feierabend",
    };
    return map[state?.mode] || map.idle;
  }

  async function getBootstrap() {
    const [assignments, states, tasks] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
    ]);
    return { assignments, states, tasks };
  }

  async function handleMessage({ employeeId, employeeName, text, date }) {
    const today = date || localDateISO();
    const [assignments, states, tasks] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
    ]);

    const dayAssignments = assignmentsFor(assignments, employeeId, today);
    const previous = states[employeeId] || {
      employeeId,
      employeeName: employeeName || employeeId,
      mode: "idle",
      activeAssignmentKey: dayAssignments[0] ? assignmentKey(dayAssignments[0]) : null,
      pending: null,
      timeline: [],
    };
    const state = { ...previous, employeeName: employeeName || previous.employeeName || employeeId };
    const current = activeAssignment(dayAssignments, state);
    const intent = detectIntent(text);
    const now = new Date().toISOString();

    const saveState = async () => {
      states[employeeId] = state;
      await writeJson(STATES, states);
    };
    const addTimeline = (type, detail, assignment = current) => {
      state.timeline = Array.isArray(state.timeline) ? state.timeline : [];
      state.timeline.push({
        at: now,
        type,
        detail,
        assignmentKey: assignment ? assignmentKey(assignment) : null,
        jobId: assignment?.jobId || null,
        jobName: assignment?.jobName || "",
      });
      state.timeline = state.timeline.slice(-200);
    };

    // Pending questions have priority.
    if (state.pending?.type === "confirm_assignment") {
      if (intent === "yes") {
        state.pending = null;
        await saveState();
        return {
          reply: `Perfekt. Sag einfach „Start“, wenn ihr bei ${assignmentLabel(current)} beginnt.`,
          buttons: ["Start", "Navigation"],
          state,
        };
      }
      if (intent === "no") {
        state.pending = { type: "ask_actual_assignment", createdAt: now };
        await saveState();
        return {
          reply: "Okay. Wo wurdest du stattdessen eingeteilt?",
          buttons: [],
          state,
        };
      }
    }

    if (state.pending?.type === "ask_actual_assignment" && intent === "message") {
      state.pending = null;
      addTimeline("assignment_deviation", String(text), null);
      await saveState();
      await appendEvent({
        type: "assignment_deviation",
        employeeId,
        employeeName: state.employeeName,
        date: today,
        detail: String(text),
      });
      return {
        reply: `Danke, ich habe „${String(text).trim()}“ als abweichende Einteilung ans Büro gemeldet.`,
        buttons: ["Start"],
        needsOfficeReview: true,
        state,
      };
    }

    if (state.pending?.type === "finish_choice") {
      if (intent === "yes" && state.pending.nextAssignmentKey) {
        const next = dayAssignments.find(a => assignmentKey(a) === state.pending.nextAssignmentKey);
        if (next) {
          state.activeAssignmentKey = assignmentKey(next);
          state.mode = "idle";
          state.pending = null;
          addTimeline("site_switch", `Wechsel zu ${assignmentLabel(next)}`, next);
          await saveState();
          await appendEvent({
            type: "site_switch",
            employeeId,
            employeeName: state.employeeName,
            date: today,
            jobId: next.jobId,
            detail: assignmentLabel(next),
          });
          return {
            reply: `Passt. Nächste Baustelle: ${assignmentLabel(next)}${next.from ? ` ab ${next.from}` : ""}. Sag „Start“, wenn du dort beginnst.`,
            buttons: ["Navigation", "Start"],
            state,
          };
        }
      }
      if (intent === "finish" || /feierabend/.test(normalizeText(text)) || intent === "no") {
        state.mode = "finished_day";
        state.pending = null;
        addTimeline("day_finished", "Feierabend", current);
        await saveState();
        await appendEvent({
          type: "day_finished",
          employeeId,
          employeeName: state.employeeName,
          date: today,
          jobId: current?.jobId || null,
        });
        return {
          reply: "Feierabend ist gespeichert. Danke und schönen Abend! 👋",
          buttons: [],
          state,
        };
      }
    }

    if (intent === "status") {
      if (!dayAssignments.length) {
        state.pending = { type: "ask_actual_assignment", createdAt: now };
        await saveState();
        return {
          reply: "Für heute finde ich noch keine Einteilung. Wo wurdest du eingeteilt?",
          buttons: [],
          state,
        };
      }
      return {
        reply: `Heute: ${dayAssignments.map(a => `${a.from || "ganztägig"}${a.to ? "–" + a.to : ""} ${assignmentLabel(a)}`).join(" · ")}. Aktueller Status: ${stateLabel(state)}.`,
        buttons: state.mode === "working" ? ["Pause", "Fertig"] : ["Start"],
        state,
      };
    }

    if (intent === "start") {
      if (!current) {
        state.pending = { type: "ask_actual_assignment", createdAt: now };
        await saveState();
        return {
          reply: "Ich finde für heute noch keine Baustelle. Wo wurdest du eingeteilt?",
          buttons: [],
          state,
        };
      }
      state.mode = "working";
      state.pending = null;
      state.activeAssignmentKey = assignmentKey(current);
      addTimeline("work_started", "Arbeitsbeginn", current);
      await saveState();
      await appendEvent({
        type: "work_started",
        employeeId,
        employeeName: state.employeeName,
        date: today,
        jobId: current.jobId,
      });
      return {
        reply: `Arbeitsbeginn bei ${assignmentLabel(current)} ist gespeichert. Gute Arbeit!`,
        buttons: ["Pause", "Mittag", "Fertig"],
        state,
      };
    }

    if (intent === "pause" || intent === "lunch") {
      if (state.mode !== "working") {
        return {
          reply: "Deine Arbeitszeit läuft gerade nicht. Soll ich zuerst den Arbeitsbeginn speichern?",
          buttons: ["Start"],
          state,
        };
      }
      state.mode = intent === "lunch" ? "lunch" : "pause";
      addTimeline(intent === "lunch" ? "lunch_started" : "pause_started", intent === "lunch" ? "Mittagspause" : "Pause", current);
      await saveState();
      return {
        reply: intent === "lunch" ? "Mittagspause begonnen. Mahlzeit! 🍽️" : "Pause begonnen. ☕",
        buttons: ["Weiter"],
        state,
      };
    }

    if (intent === "resume") {
      if (!["pause", "lunch"].includes(state.mode)) {
        return {
          reply: "Bei mir ist gerade keine Pause offen. Deine Arbeitszeit läuft weiter.",
          buttons: ["Pause", "Fertig"],
          state,
        };
      }
      state.mode = "working";
      addTimeline("work_resumed", "Arbeit fortgesetzt", current);
      await saveState();
      return {
        reply: "Weiter geht’s. Arbeitszeit läuft wieder.",
        buttons: ["Pause", "Mittag", "Fertig"],
        state,
      };
    }

    if (intent === "finish") {
      if (!current) {
        state.mode = "finished_day";
        addTimeline("day_finished", "Feierabend ohne Einteilung", null);
        await saveState();
        return {
          reply: "Feierabend ist gespeichert. Schönen Abend! 👋",
          buttons: [],
          state,
        };
      }
      const next = nextAssignment(dayAssignments, current);
      addTimeline("site_finished", `${assignmentLabel(current)} fertig`, current);
      if (next) {
        state.mode = "finished_site";
        state.pending = {
          type: "finish_choice",
          nextAssignmentKey: assignmentKey(next),
          createdAt: now,
        };
        await saveState();
        return {
          reply: `${assignmentLabel(current)} ist als fertig markiert. Geht’s jetzt weiter zu ${assignmentLabel(next)} oder hast du Feierabend?`,
          buttons: [`Weiter zu ${next.jobName || "#" + next.jobId}`, "Feierabend"],
          state,
        };
      }
      state.mode = "finished_day";
      state.pending = null;
      addTimeline("day_finished", "Feierabend", current);
      await saveState();
      await appendEvent({
        type: "day_finished",
        employeeId,
        employeeName: state.employeeName,
        date: today,
        jobId: current.jobId,
      });
      const openTasks = tasks.filter(t =>
        String(t.assigneeId) === String(employeeId) &&
        t.status !== "done" &&
        (!t.jobId || String(t.jobId) === String(current.jobId))
      );
      return {
        reply: `Feierabend ist gespeichert.${openTasks.length ? ` Es sind noch ${openTasks.length} offene Aufgabe(n) vorgemerkt.` : ""} Danke und schönen Abend! 👋`,
        buttons: [],
        state,
      };
    }

    if (intent === "task_done") {
      const open = tasks.find(t => String(t.assigneeId) === String(employeeId) && t.status !== "done");
      if (!open) {
        return { reply: "Ich finde gerade keine offene Aufgabe für dich.", buttons: [], state };
      }
      open.status = "done";
      open.completedAt = now;
      await writeJson(TASKS, tasks);
      await appendEvent({
        type: "task_completed",
        employeeId,
        employeeName: state.employeeName,
        taskId: open.id,
        detail: open.title,
      });
      return {
        reply: `Danke. „${open.title}“ ist als erledigt markiert.`,
        buttons: [],
        state,
      };
    }

    // If this is the first contact of the day, confirm plan.
    if (state.mode === "idle" && current && !state.pending) {
      state.pending = { type: "confirm_assignment", createdAt: now };
      await saveState();
      return {
        reply: `Hallo ${state.employeeName}. Du bist heute bei ${assignmentLabel(current)}${current.from ? ` von ${current.from}${current.to ? " bis " + current.to : ""}` : ""} eingeteilt. Passt das?`,
        buttons: ["Ja", "Nein", "Navigation"],
        state,
      };
    }

    addTimeline("message", String(text), current);
    await saveState();
    await appendEvent({
      type: "employee_message",
      employeeId,
      employeeName: state.employeeName,
      date: today,
      jobId: current?.jobId || null,
      detail: String(text),
    });
    return {
      reply: "Danke, ich habe deine Nachricht gespeichert. Für den Test verstehe ich bereits: Start, Pause, Mittag, Weiter, Fertig, Status und Erledigt.",
      buttons: state.mode === "working" ? ["Pause", "Fertig"] : ["Status", "Start"],
      state,
    };
  }

  app.get("/kristine", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.sendFile(path.join(publicDir, "kristine.html"));
  });

  app.get("/kristine/api/bootstrap", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ ok: true, ...(await getBootstrap()), today: localDateISO() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.put("/kristine/api/assignments", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
      const clean = rows.map((a, index) => ({
        id: String(a.id || `a_${Date.now()}_${index}`),
        date: String(a.date || "").slice(0, 10),
        jobId: String(a.jobId || "").slice(0, 80),
        jobName: String(a.jobName || "").trim().slice(0, 140),
        city: String(a.city || "").trim().slice(0, 100),
        address: String(a.address || "").trim().slice(0, 300),
        employeeId: String(a.employeeId || "").slice(0, 100),
        employeeName: String(a.employeeName || "").trim().slice(0, 140),
        vehicle: String(a.vehicle || "").trim().slice(0, 100),
        from: String(a.from || "").slice(0, 5),
        to: String(a.to || "").slice(0, 5),
        note: String(a.note || "").trim().slice(0, 500),
      })).filter(a => a.date && a.employeeId && (a.jobId || a.jobName));
      await writeJson(ASSIGNMENTS, clean);
      await appendEvent({ type: "planning_saved", detail: `${clean.length} Einteilungen gespeichert`, source: "office" });
      res.json({ ok: true, assignments: clean });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/kristine/api/message", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.body?.employeeId || "").trim();
      const employeeName = String(req.body?.employeeName || employeeId).trim();
      const text = String(req.body?.text || "").trim();
      const date = String(req.body?.date || localDateISO()).slice(0, 10);
      if (!employeeId || !text) return res.status(400).json({ ok: false, error: "employeeId und text erforderlich" });
      res.json({ ok: true, ...(await handleMessage({ employeeId, employeeName, text, date })) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/kristine/api/reset-state/:employeeId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const states = await readJson(STATES, {});
      delete states[String(req.params.employeeId)];
      await writeJson(STATES, states);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.put("/kristine/api/tasks", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
      const clean = tasks.map((t, index) => ({
        id: String(t.id || `t_${Date.now()}_${index}`),
        title: String(t.title || "").trim().slice(0, 180),
        assigneeId: String(t.assigneeId || "").slice(0, 100),
        assigneeName: String(t.assigneeName || "").trim().slice(0, 140),
        jobId: String(t.jobId || "").slice(0, 80),
        jobName: String(t.jobName || "").trim().slice(0, 140),
        dueDate: String(t.dueDate || "").slice(0, 10),
        reminder: String(t.reminder || "").trim().slice(0, 300),
        status: t.status === "done" ? "done" : "open",
        createdAt: t.createdAt || new Date().toISOString(),
        completedAt: t.completedAt || null,
      })).filter(t => t.title);
      await writeJson(TASKS, clean);
      res.json({ ok: true, tasks: clean });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}

module.exports = { registerKristine };
