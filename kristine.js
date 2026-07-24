
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function registerKristine(app, { dataDir, requireAdmin, publicDir, markJobRunning, sendWhatsApp, phoneNumberId, readEmployees, readJobMeta }) {
  const ROOT = path.join(dataDir, "_kristine");
  const ASSIGNMENTS = path.join(ROOT, "assignments.json");
  const STATES = path.join(ROOT, "states.json");
  const TASKS = path.join(ROOT, "tasks.json");
  const EVENTS = path.join(ROOT, "events.jsonl");
  const TIME_EVENTS = path.join(ROOT, "time-events.json");
  const REVIEW_ENTRIES = path.join(ROOT, "day-review-entries.json");

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

  function viennaParts(d = new Date()) {
    const parts = new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function localDateISO(d = new Date()) {
    const p = viennaParts(d);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function localTimeHM(d = new Date()) {
    const p = viennaParts(d);
    return `${p.hour}:${p.minute}`;
  }

  function minutesFromHM(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function clampOfficialStart(actualTime) {
    const actual = minutesFromHM(actualTime);
    const official = minutesFromHM("07:00");
    return actual !== null && actual < official ? "07:00" : actualTime;
  }

  async function appendTimeEvent(event) {
    const rows = await readJson(TIME_EVENTS, []);
    rows.push(event);
    // Genug Historie für Büroprüfung behalten, Datei aber begrenzen.
    await writeJson(TIME_EVENTS, rows.slice(-20000));
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
    if (/^(andere baustelle|baustelle wechseln|wechseln)$/.test(t)) return "switch_site";
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

  function uniqueSites(assignments) {
    const map = new Map();
    for (const assignment of assignments) {
      const jobId = String(assignment?.jobId || "").trim();
      const jobName = String(assignment?.jobName || "").trim();
      if (!jobId && !jobName) continue;
      const key = jobId || normalizeText(jobName);
      if (!map.has(key)) map.set(key, {
        jobId, jobName, city: assignment?.city || "", address: assignment?.address || "",
      });
    }
    return [...map.values()];
  }

  function findSiteCandidates(assignments, query, preferredAssignments = []) {
    const q = normalizeText(query);
    const preferredKeys = new Set(preferredAssignments.map((assignment) => String(assignment.jobId || normalizeText(assignment.jobName))));
    return uniqueSites(assignments)
      .map((site) => {
        const id = normalizeText(site.jobId);
        const name = normalizeText(site.jobName);
        let score = preferredKeys.has(String(site.jobId || name)) ? 100 : 0;
        if (!q) score += 1;
        if (id === q || name === q) score += 1000;
        else if (id.startsWith(q) || name.startsWith(q)) score += 500;
        else if (id.includes(q) || name.includes(q)) score += 200;
        return { ...site, score };
      })
      .filter((site) => !q || site.score > 0)
      .sort((a, b) => b.score - a.score || String(a.jobName).localeCompare(String(b.jobName), "de"));
  }

  function formatDaySummary(timeEvents, employeeId, date, state) {
    const segments = buildEditableSegments(timeEvents, employeeId, date, state);
    if (!segments.length) return "Keine Zeitabschnitte vorhanden.";
    return segments.map((segment) => {
      const label = segment.type === "lunch" ? "Mittag" : segment.type === "pause" ? "Pause" : (segment.jobName || segment.jobId || "Arbeit");
      return `${segment.from}–${segment.to || "offen"} ${label}`;
    }).join("\n");
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
    const [assignments, states, tasks, timeEvents] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
      readJson(TIME_EVENTS, []),
    ]);
    return { assignments, states, tasks, timeEvents };
  }

  async function handleMessage({ employeeId, employeeName, text, date }) {
    const today = date || localDateISO();
    const [assignments, states, tasks, timeEvents] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
      readJson(TIME_EVENTS, []),
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
    let current = activeAssignment(dayAssignments, state);
    if (state.activeJobOverride?.jobId || state.activeJobOverride?.jobName) current = state.activeJobOverride;
    const intent = detectIntent(text);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const actualTime = localTimeHM(nowDate);

    const saveState = async () => {
      states[employeeId] = state;
      await writeJson(STATES, states);
    };
    const addTimeline = (type, detail, assignment = current) => {
      state.timeline = Array.isArray(state.timeline) ? state.timeline : [];
      state.timeline.push({
        at: now,
        time: actualTime,
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
      const query = String(text).trim();
      const candidates = findSiteCandidates(assignments, query, dayAssignments);
      if (!candidates.length) {
        return {
          reply: `Ich finde keine Baustelle zu „${query}“. Bitte Name oder Nummer anders schreiben.`,
          buttons: [],
          state,
        };
      }
      if (candidates.length === 1 || candidates[0].score >= 1000) {
        const selected = candidates[0];
        const wasWorking = ["working", "pause", "lunch"].includes(state.mode) || state.pending?.forSwitch;
        state.activeAssignmentKey = null;
        state.activeJobOverride = { jobId: selected.jobId, jobName: selected.jobName, city: selected.city || "" };
        state.mode = wasWorking ? "working" : state.mode;
        state.pending = null;
        addTimeline(wasWorking ? "site_switch" : "assignment_deviation", `${wasWorking ? "Baustellenwechsel" : "Abweichende Einteilung"} zu ${assignmentLabel(selected)}`, selected);
        await saveState();
        if (wasWorking) {
          await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "weiter", at: actualTime, jobId: selected.jobId, jobName: selected.jobName || "", createdAt: now });
          await appendEvent({ type: "site_switch", employeeId, employeeName: state.employeeName, date: today, jobId: selected.jobId, detail: assignmentLabel(selected), time: actualTime });
          return { reply: `✅ Baustelle gewechselt.\nArbeitszeit läuft weiter auf ${assignmentLabel(selected)}.`, buttons: [], state };
        }
        return { reply: `✅ Baustelle ausgewählt: ${assignmentLabel(selected)}.\nSag „Start“, wenn die Arbeit beginnt.`, buttons: ["Start"], state };
      }
      state.pending = { type: "choose_site_search", choices: candidates.slice(0, 6), forSwitch: Boolean(state.pending?.forSwitch), createdAt: now };
      await saveState();
      return {
        reply: `Welche Baustelle meinst du?\n${candidates.slice(0, 6).map((site, index) => `${index + 1}. ${assignmentLabel(site)}`).join("\n")}`,
        buttons: candidates.slice(0, 3).map((_, index) => String(index + 1)),
        state,
      };
    }

    if (state.pending?.type === "choose_site_search") {
      const number = Number(normalizeText(text));
      const choices = Array.isArray(state.pending.choices) ? state.pending.choices : [];
      const selected = Number.isInteger(number) && number > 0 ? choices[number - 1] : choices.find((site) => normalizeText(site.jobName).includes(normalizeText(text)) || normalizeText(site.jobId) === normalizeText(text));
      if (!selected) return { reply: "Bitte Nummer oder Baustellenname auswählen.", buttons: choices.slice(0, 3).map((_, index) => String(index + 1)), state };
      const wasWorking = Boolean(state.pending.forSwitch) || ["working", "pause", "lunch"].includes(state.mode);
      state.activeAssignmentKey = null;
      state.activeJobOverride = { jobId: selected.jobId, jobName: selected.jobName, city: selected.city || "" };
      state.mode = wasWorking ? "working" : state.mode;
      state.pending = null;
      addTimeline(wasWorking ? "site_switch" : "assignment_deviation", `${wasWorking ? "Baustellenwechsel" : "Abweichende Einteilung"} zu ${assignmentLabel(selected)}`, selected);
      await saveState();
      if (wasWorking) {
        await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "weiter", at: actualTime, jobId: selected.jobId, jobName: selected.jobName || "", createdAt: now });
        return { reply: `✅ Baustelle gewechselt.\nArbeitszeit läuft weiter auf ${assignmentLabel(selected)}.`, buttons: [], state };
      }
      return { reply: `✅ Baustelle ausgewählt: ${assignmentLabel(selected)}.`, buttons: ["Start"], state };
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
        await appendTimeEvent({
          employeeId,
          employeeName: state.employeeName,
          date: today,
          type: "ende",
          at: actualTime,
          jobId: current?.jobId || null,
          jobName: current?.jobName || "",
          createdAt: now,
        });
        await appendEvent({
          type: "day_finished",
          employeeId,
          employeeName: state.employeeName,
          date: today,
          jobId: current?.jobId || null,
          time: actualTime,
        });
        return {
          reply: "Feierabend ist gespeichert. Danke und schönen Abend! 👋",
          buttons: [],
          state,
        };
      }
    }

    if (intent === "switch_site") {
      const alternatives = dayAssignments.filter((assignment) => !current || assignmentKey(assignment) !== assignmentKey(current));
      if (!alternatives.length) {
        state.pending = { type: "ask_actual_assignment", forSwitch: true, createdAt: now };
        await saveState();
        return { reply: "Welche Baustelle ist richtig? Schreib bitte Name oder Nummer.", buttons: [], state };
      }
      state.pending = { type: "choose_switch_assignment", choices: alternatives.map((assignment) => assignmentKey(assignment)), createdAt: now };
      await saveState();
      return {
        reply: `Welche Baustelle?\n${alternatives.map((assignment, index) => `${index + 1}. ${assignmentLabel(assignment)}`).join("\n")}\nOder schreibe Name bzw. Nummer.`,
        buttons: alternatives.slice(0, 3).map((assignment, index) => String(index + 1)),
        state,
      };
    }

    if (state.pending?.type === "choose_switch_assignment") {
      const normalized = normalizeText(text);
      const alternatives = dayAssignments.filter((assignment) => state.pending.choices?.includes(assignmentKey(assignment)));
      const number = Number(normalized);
      const selected = Number.isInteger(number) && number > 0 && number <= alternatives.length
        ? alternatives[number - 1]
        : alternatives.find((assignment) => normalizeText(assignment.jobName).includes(normalized) || normalizeText(assignment.jobId) === normalized);
      if (selected) {
        state.activeAssignmentKey = assignmentKey(selected);
        delete state.activeJobOverride;
        state.mode = "working";
        state.pending = null;
        addTimeline("site_switch", `Baustellenwechsel zu ${assignmentLabel(selected)}`, selected);
        await saveState();
        await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "weiter", at: actualTime, jobId: selected.jobId, jobName: selected.jobName || "", createdAt: now });
        return { reply: `✅ Baustelle gewechselt.\nArbeitszeit läuft weiter auf ${assignmentLabel(selected)}.`, buttons: [], state };
      }
      state.pending = { type: "ask_actual_assignment", forSwitch: true, createdAt: now };
      await saveState();
      return { reply: "Schreib bitte Name oder Nummer der Baustelle.", buttons: [], state };
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
        buttons: state.mode === "working" ? ["Andere Baustelle"] : ["Start"],
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
      const bookedTime = clampOfficialStart(actualTime);
      state.mode = "working";
      state.pending = null;
      state.activeAssignmentKey = assignmentKey(current);
      state.lastStartActual = actualTime;
      state.lastStartBooked = bookedTime;
      addTimeline("work_started", `Arbeitsbeginn ${bookedTime}${bookedTime !== actualTime ? ` (gestempelt ${actualTime})` : ""}`, current);
      await saveState();
      if (typeof markJobRunning === "function") await markJobRunning(current.jobId, "time_booking").catch(() => false);
      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: "start",
        at: bookedTime,
        actualAt: actualTime,
        adjusted: bookedTime !== actualTime,
        jobId: current.jobId,
        jobName: current.jobName || "",
        createdAt: now,
      });
      await appendEvent({
        type: "work_started",
        employeeId,
        employeeName: state.employeeName,
        date: today,
        jobId: current.jobId,
        actualTime,
        bookedTime,
        adjusted: bookedTime !== actualTime,
      });
      return {
        reply: bookedTime !== actualTime
          ? `Arbeitsbeginn bei ${assignmentLabel(current)} ist gespeichert. Gemäß Betriebsregel wurde ${actualTime} auf 07:00 Uhr gesetzt. Gute Arbeit!`
          : `Arbeitsbeginn bei ${assignmentLabel(current)} ist um ${bookedTime} gespeichert. Gute Arbeit!`,
        buttons: ["Andere Baustelle"],
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
      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: intent === "lunch" ? "mittag" : "pause",
        at: actualTime,
        jobId: current?.jobId || null,
        jobName: current?.jobName || "",
        createdAt: now,
      });
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
          buttons: ["Andere Baustelle"],
          state,
        };
      }
      state.mode = "working";
      addTimeline("work_resumed", "Arbeit fortgesetzt", current);
      await saveState();
      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: "weiter",
        at: actualTime,
        jobId: current?.jobId || null,
        jobName: current?.jobName || "",
        createdAt: now,
      });
      return {
        reply: "Weiter geht’s. Arbeitszeit läuft wieder.",
        buttons: ["Andere Baustelle"],
        state,
      };
    }

    if (state.pending?.type === "day_review_summary") {
      if (intent === "no") {
        state.pending = null;
        await saveState();
        return { reply: "Bitte die Zeiten im Leitstand korrigieren und danach nochmals „Fertig“ schreiben.", buttons: [], state };
      }
      if (intent === "yes") {
        state.dayReview = { ...(state.dayReview || {}), summaryConfirmed: true };
        state.pending = { type: "day_review_photo", createdAt: now };
        await saveState();
        return { reply: "Sind alle Fotos für heute erfasst?", buttons: ["Ja", "Nein"], state };
      }
      return { reply: "Passt die Zusammenfassung?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "day_review_photo") {
      if (!["yes", "no"].includes(intent)) return { reply: "Sind alle Fotos erfasst?", buttons: ["Ja", "Nein"], state };
      state.dayReview = { ...(state.dayReview || {}), photosComplete: intent === "yes" };
      state.pending = { type: "day_review_material", createdAt: now };
      await saveState();
      return { reply: "Ist das verwendete Material erfasst?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "day_review_material") {
      if (!["yes", "no"].includes(intent)) return { reply: "Ist das Material erfasst?", buttons: ["Ja", "Nein"], state };
      state.dayReview = { ...(state.dayReview || {}), materialComplete: intent === "yes" };
      state.pending = { type: "day_review_regie", createdAt: now };
      await saveState();
      return { reply: "Ist noch ein Regiebericht nötig?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "day_review_regie") {
      if (!["yes", "no"].includes(intent)) return { reply: "Ist ein Regiebericht nötig?", buttons: ["Ja", "Nein"], state };
      state.dayReview = { ...(state.dayReview || {}), regieNeeded: intent === "yes" };
      state.pending = { type: "day_review_task", createdAt: now };
      await saveState();
      return { reply: "Ist noch etwas offen, das als Aufgabe gespeichert werden soll?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "day_review_task") {
      if (intent === "yes") {
        state.pending = { type: "day_review_task_text", createdAt: now };
        await saveState();
        return { reply: "Was ist noch offen? Schreib mir kurz die Aufgabe.", buttons: [], state };
      }
      if (intent !== "no") return { reply: "Soll ich noch eine Aufgabe speichern?", buttons: ["Ja", "Nein"], state };
      state.pending = null;
      state.mode = "finished_day";
      addTimeline("day_finished", "Tagesabschluss bestätigt", current);
      await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "ende", at: actualTime, jobId: current?.jobId || state.activeJobOverride?.jobId || null, jobName: current?.jobName || state.activeJobOverride?.jobName || "", createdAt: now });
      await appendEvent({ type: "day_finished", employeeId, employeeName: state.employeeName, date: today, jobId: current?.jobId || state.activeJobOverride?.jobId || null, time: actualTime, review: state.dayReview || {} });
      await saveState();
      return { reply: "✅ Tagesabschluss gespeichert. Danke und schönen Feierabend! 👋", buttons: [], state };
    }

    if (state.pending?.type === "day_review_task_text" && intent === "message") {
      const title = String(text).trim();
      tasks.push({
        id: `t_${Date.now()}`, title, assigneeId: String(employeeId), assigneeName: state.employeeName,
        jobId: current?.jobId || state.activeJobOverride?.jobId || "", jobName: current?.jobName || state.activeJobOverride?.jobName || "",
        dueDate: today, reminder: "Beim Tagesabschluss erstellt", status: "open", createdAt: now, completedAt: null, createdBy: employeeId,
      });
      await writeJson(TASKS, tasks);
      state.dayReview = { ...(state.dayReview || {}), taskCreated: title };
      state.pending = null;
      state.mode = "finished_day";
      addTimeline("day_finished", "Tagesabschluss bestätigt", current);
      await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "ende", at: actualTime, jobId: current?.jobId || state.activeJobOverride?.jobId || null, jobName: current?.jobName || state.activeJobOverride?.jobName || "", createdAt: now });
      await appendEvent({ type: "day_finished", employeeId, employeeName: state.employeeName, date: today, jobId: current?.jobId || state.activeJobOverride?.jobId || null, time: actualTime, review: state.dayReview || {} });
      await saveState();
      return { reply: `✅ Aufgabe „${title}“ gespeichert. Tagesabschluss erledigt. Schönen Feierabend! 👋`, buttons: [], state };
    }

    if (intent === "finish") {
      const summary = formatDaySummary(timeEvents, employeeId, today, state);
      state.pending = { type: "day_review_summary", createdAt: now };
      state.dayReview = { startedAt: now, summary };
      await saveState();
      return {
        reply: `📋 Tageszusammenfassung\n${summary}\n\nPasst das so?`,
        buttons: ["Ja", "Nein"],
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
      reply: "Danke, ich habe deine Nachricht gespeichert.",
      buttons: state.mode === "working" ? ["Andere Baustelle"] : ["Status", "Start"],
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
      if (typeof markJobRunning === "function") {
        for (const jobId of [...new Set(clean.map(a => a.jobId).filter(Boolean))]) {
          await markJobRunning(jobId, "planning").catch(() => false);
        }
      }
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


  function hmFromMinutes(value) {
    const minutes = Math.max(0, Math.min(24 * 60, Math.round(Number(value) || 0)));
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  function buildEditableSegments(events, employeeId, date, state) {
    const rows = events
      .filter((row) => String(row.employeeId) === String(employeeId) && String(row.date) === String(date))
      .map((row, index) => ({ ...row, _index: index, _minutes: minutesFromHM(row.at) }))
      .filter((row) => row._minutes !== null)
      .sort((a, b) => a._minutes - b._minutes || String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a._index - b._index);

    const result = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const type = row.type === "start" || row.type === "weiter" ? "work" : row.type === "pause" ? "pause" : row.type === "mittag" ? "lunch" : null;
      if (!type) continue;
      const next = rows[index + 1];
      let toMinutes = next?._minutes ?? null;
      if (toMinutes === null && ["working", "pause", "lunch"].includes(state?.mode)) {
        toMinutes = minutesFromHM(localTimeHM());
      }
      result.push({
        id: String(row.segmentId || `seg_${employeeId}_${date}_${index}`),
        type,
        from: row.at,
        to: toMinutes === null ? "" : hmFromMinutes(toMinutes),
        jobId: String(row.jobId || ""),
        jobName: String(row.jobName || ""),
        source: String(row.source || "employee"),
      });
    }
    return result;
  }

  function eventTypeForSegment(segment) {
    if (segment.type === "pause") return "pause";
    if (segment.type === "lunch") return "mittag";
    return "start";
  }

  function entryMinutes(entry) {
    const direct = minutesFromHM(entry.at || entry.time || entry.capturedAt);
    if (direct !== null) return direct;
    const raw = entry.createdAt || entry.timestamp || entry.capturedAt;
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : minutesFromHM(localTimeHM(parsed));
  }

  app.get("/kristine/api/segments/:employeeId/:date", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.params.employeeId || "");
      const date = String(req.params.date || localDateISO()).slice(0, 10);
      const [events, states] = await Promise.all([readJson(TIME_EVENTS, []), readJson(STATES, {})]);
      res.json({ ok: true, segments: buildEditableSegments(events, employeeId, date, states[employeeId] || {}) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/kristine/api/segments/:employeeId/:date", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.params.employeeId || "").trim();
      const date = String(req.params.date || localDateISO()).slice(0, 10);
      const employeeName = String(req.body?.employeeName || employeeId).trim();
      const moveLinked = true; // Zeitblock ist die Wahrheit: verknüpfte Einträge werden immer mitgeführt.
      const incoming = Array.isArray(req.body?.segments) ? req.body.segments : [];
      const segments = incoming.map((segment, index) => ({
        id: String(segment.id || `seg_${Date.now()}_${index}`),
        type: ["work", "pause", "lunch"].includes(segment.type) ? segment.type : "work",
        from: String(segment.from || "").slice(0, 5),
        to: String(segment.to || "").slice(0, 5),
        jobId: String(segment.jobId || "").slice(0, 80),
        jobName: String(segment.jobName || "").trim().slice(0, 140),
      })).filter((segment) => minutesFromHM(segment.from) !== null && (!segment.to || minutesFromHM(segment.to) !== null));

      segments.sort((a, b) => minutesFromHM(a.from) - minutesFromHM(b.from));
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const from = minutesFromHM(segment.from);
        const to = segment.to ? minutesFromHM(segment.to) : null;
        if (to !== null && to <= from) throw new Error(`Ungültiger Zeitraum ${segment.from}–${segment.to}`);
        if (index > 0) {
          const previous = segments[index - 1];
          const previousTo = previous.to ? minutesFromHM(previous.to) : null;
          if (previousTo === null || previousTo > from) throw new Error("Zeitsegmente überschneiden sich oder ein offenes Segment steht nicht am Ende.");
        }
      }

      const [allEvents, states, reviewEntries] = await Promise.all([
        readJson(TIME_EVENTS, []), readJson(STATES, {}), readJson(REVIEW_ENTRIES, []),
      ]);
      const oldSegments = buildEditableSegments(allEvents, employeeId, date, states[employeeId] || {});
      const retained = allEvents.filter((row) => !(String(row.employeeId) === employeeId && String(row.date) === date));
      const createdAt = new Date().toISOString();
      const replacement = [];
      for (const segment of segments) {
        replacement.push({
          employeeId, employeeName, date,
          type: eventTypeForSegment(segment), at: segment.from,
          jobId: segment.type === "work" ? segment.jobId : null,
          jobName: segment.type === "work" ? segment.jobName : "",
          segmentId: segment.id, source: "office", manual: true, createdAt,
        });
      }
      const last = segments.at(-1);
      if (last?.to) replacement.push({
        employeeId, employeeName, date, type: "ende", at: last.to,
        jobId: last.type === "work" ? last.jobId : null,
        jobName: last.type === "work" ? last.jobName : "",
        source: "office", manual: true, createdAt,
      });
      await writeJson(TIME_EVENTS, [...retained, ...replacement].slice(-20000));

      let moved = 0;
      if (moveLinked) {
        for (const entry of reviewEntries) {
          if (String(entry.employeeId) !== employeeId || String(entry.date) !== date) continue;
          const minute = entryMinutes(entry);
          if (minute === null) continue;
          const target = segments.find((segment) => segment.type === "work" && minute >= minutesFromHM(segment.from) && (!segment.to || minute < minutesFromHM(segment.to)));
          if (!target) continue;
          if (String(entry.jobId || "") !== String(target.jobId || "")) {
            entry.history = Array.isArray(entry.history) ? entry.history : [];
            entry.history.push({ at: createdAt, action: "job_reassigned_from_time_segment", oldJobId: entry.jobId || null, oldJobName: entry.jobName || "", newJobId: target.jobId || null, newJobName: target.jobName || "", source: "office" });
            entry.jobId = target.jobId || null;
            entry.jobName = target.jobName || "";
            entry.bookingSegmentId = target.id;
            moved += 1;
          } else if (!entry.bookingSegmentId) entry.bookingSegmentId = target.id;
        }
        await writeJson(REVIEW_ENTRIES, reviewEntries);
      }

      // Tagesreport ist nur eine Ansicht: nach Zeitblockänderungen immer neu erzeugen.
      const reportFile = path.join(ROOT, "reports", `Tagesreport_${date}.pdf`);
      await fsp.rm(reportFile, { force: true }).catch(() => {});
      const affectedJobs = new Set([
        ...oldSegments.filter((segment) => segment.type === "work" && segment.jobId).map((segment) => String(segment.jobId)),
        ...segments.filter((segment) => segment.type === "work" && segment.jobId).map((segment) => String(segment.jobId)),
      ]);
      for (const jobId of affectedJobs) {
        await fsp.rm(path.join(dataDir, jobId, "_chronik", `Tagesreport_${date}.pdf`), { force: true }).catch(() => {});
      }

      const state = { ...(states[employeeId] || {}), employeeId, employeeName, timeline: Array.isArray(states[employeeId]?.timeline) ? states[employeeId].timeline : [] };
      if (!segments.length) state.mode = "idle";
      else if (last?.to) state.mode = "finished_day";
      else state.mode = last.type === "pause" ? "pause" : last.type === "lunch" ? "lunch" : "working";
      const active = [...segments].reverse().find((segment) => segment.type === "work");
      if (active) state.activeAssignmentKey = `${date}|${employeeId}|${active.from}|${active.jobId}`;
      state.timeline.push({ at: createdAt, time: localTimeHM(), type: "day_segments_edited", detail: `${segments.length} Tagesabschnitt(e) durch Büro gespeichert`, source: "office", manual: true, movedLinkedEntries: moved });
      state.timeline = state.timeline.slice(-200);
      states[employeeId] = state;
      await writeJson(STATES, states);
      await appendEvent({ type: "day_segments_edited", employeeId, employeeName, date, segmentCount: segments.length, movedLinkedEntries: moved, source: "office" });
      res.json({ ok: true, segments, movedLinkedEntries: moved, state, previousSegments: oldSegments.length });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/manual-action", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.body?.employeeId || "").trim();
      const employeeName = String(req.body?.employeeName || employeeId).trim();
      const date = String(req.body?.date || localDateISO()).slice(0, 10);
      const action = String(req.body?.action || "").trim().toLowerCase();
      const at = String(req.body?.at || localTimeHM()).slice(0, 5);
      const jobId = String(req.body?.jobId || "").trim().slice(0, 80);
      const jobName = String(req.body?.jobName || "").trim().slice(0, 140);
      if (!employeeId) return res.status(400).json({ ok: false, error: "employeeId erforderlich" });
      if (!/^(start|pause|lunch|resume|end)$/.test(action)) return res.status(400).json({ ok: false, error: "Ungültige Aktion" });
      if (minutesFromHM(at) === null) return res.status(400).json({ ok: false, error: "Ungültige Uhrzeit" });

      const [states, assignments] = await Promise.all([readJson(STATES, {}), readJson(ASSIGNMENTS, [])]);
      const state = { ...(states[employeeId] || {}), employeeId, employeeName, timeline: Array.isArray(states[employeeId]?.timeline) ? states[employeeId].timeline : [] };
      const dayAssignments = assignments.filter(a => String(a.date) === date && String(a.employeeId) === employeeId);
      const selected = dayAssignments.find(a => String(a.jobId) === jobId) || activeAssignment(dayAssignments, state) || dayAssignments[0] || null;
      const effectiveJobId = jobId || selected?.jobId || null;
      const effectiveJobName = jobName || selected?.jobName || "";
      const now = new Date().toISOString();
      const map = {
        start: { mode: "working", eventType: "start", timelineType: "work_started", detail: `Arbeitsbeginn manuell ${at}` },
        pause: { mode: "pause", eventType: "pause", timelineType: "pause_started", detail: `Pause manuell ${at}` },
        lunch: { mode: "lunch", eventType: "mittag", timelineType: "lunch_started", detail: `Mittag manuell ${at}` },
        resume: { mode: "working", eventType: "weiter", timelineType: "work_resumed", detail: `Arbeit fortgesetzt / Baustelle gewechselt ${at}` },
        end: { mode: "finished_day", eventType: "ende", timelineType: "day_finished", detail: `Feierabend manuell ${at}` },
      };
      const cfg = map[action];
      state.mode = cfg.mode;
      state.pending = null;
      if (selected && ["start", "resume"].includes(action)) state.activeAssignmentKey = assignmentKey(selected);
      state.timeline.push({ at: now, time: at, type: cfg.timelineType, detail: cfg.detail, assignmentKey: selected ? assignmentKey(selected) : null, jobId: effectiveJobId, jobName: effectiveJobName, source: "office", manual: true });
      state.timeline = state.timeline.slice(-200);
      states[employeeId] = state;
      await writeJson(STATES, states);
      await appendTimeEvent({ employeeId, employeeName, date, type: cfg.eventType, at, jobId: effectiveJobId, jobName: effectiveJobName, createdAt: now, source: "office", manual: true });
      await appendEvent({ type: "manual_time_action", action, employeeId, employeeName, date, at, jobId: effectiveJobId, jobName: effectiveJobName, source: "office" });
      res.json({ ok: true, state, action, at });
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
      const previousTasks = await readJson(TASKS, []);
      const previousIds = new Set(previousTasks.map(t => String(t.id || "")));
      const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
      const employees = typeof readEmployees === "function" ? await readEmployees() : [];
      const employeeById = new Map(employees.map(e => [String(e.id || ""), e]));
      const clean = [];
      for (let index = 0; index < tasks.length; index++) {
        const t = tasks[index] || {};
        const jobId = String(t.jobId || "").slice(0, 80);
        let jobMeta = {};
        if (jobId && typeof readJobMeta === "function") {
          try { jobMeta = await readJobMeta(jobId) || {}; } catch {}
        }
        const row = {
          id: String(t.id || `t_${Date.now()}_${index}`),
          title: String(t.title || "").trim().slice(0, 180),
          assigneeId: String(t.assigneeId || "").slice(0, 100),
          assigneeName: String(t.assigneeName || "").trim().slice(0, 140),
          jobId,
          jobName: String(t.jobName || jobMeta.name || "").trim().slice(0, 140),
          taskType: ["Rückruf","Angebot","Problem","Termin","Reklamation","Sonstiges"].includes(String(t.taskType || "")) ? String(t.taskType) : "Sonstiges",
          priority: ["normal","heute","sofort"].includes(String(t.priority || "")) ? String(t.priority) : "normal",
          creatorId: String(t.creatorId || "admin").slice(0, 100),
          creatorName: String(t.creatorName || "Chef / Büro").trim().slice(0, 140),
          address: String(t.address || [jobMeta.street, jobMeta.houseNumber, [jobMeta.postalCode, jobMeta.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "").trim().slice(0, 300),
          contactName: String(t.contactName || jobMeta.contactName || "").trim().slice(0, 140),
          contactPhone: String(t.contactPhone || jobMeta.contactPhone || "").trim().slice(0, 60),
          contactEmail: String(t.contactEmail || jobMeta.contactEmail || jobMeta.email || "").trim().slice(0, 180),
          dueDate: String(t.dueDate || "").slice(0, 10),
          reminder: String(t.reminder || "").trim().slice(0, 500),
          status: t.status === "done" ? "done" : "open",
          createdAt: t.createdAt || new Date().toISOString(),
          completedAt: t.completedAt || null,
        };
        if (row.title) clean.push(row);
      }
      await writeJson(TASKS, clean);

      const notifications = [];
      const newOpenTasks = clean.filter(t => !previousIds.has(String(t.id)) && t.status !== "done");
      for (const task of newOpenTasks) {
        const employee = employeeById.get(String(task.assigneeId || ""));
        const employeePhone = String(employee?.phone || "").replace(/\D/g, "");
        if (!employeePhone) {
          notifications.push({ taskId: task.id, sent: false, reason: "no_employee_phone" });
          continue;
        }
        if (typeof sendWhatsApp !== "function" || !phoneNumberId) {
          notifications.push({ taskId: task.id, sent: false, reason: "whatsapp_not_configured" });
          continue;
        }
        const priorityLabel = task.priority === "sofort" ? "🔴 Sofort" : task.priority === "heute" ? "🟡 Heute" : "🟢 Normal";
        const lines = [
          `📌 Neue Aufgabe · ${task.taskType || "Aufgabe"}`,
          `*${task.title}*`,
          task.creatorName ? `👤 Von: ${task.creatorName}` : "",
          task.jobName ? `🏗️ ${task.jobName}${task.jobId ? ` (#${task.jobId})` : ""}` : "",
          task.address ? `📍 ${task.address}` : "",
          task.dueDate ? `📅 Fällig: ${task.dueDate.split("-").reverse().join(".")}` : "",
          `Priorität: ${priorityLabel}`,
          task.reminder ? `ℹ️ ${task.reminder}` : "",
          task.contactPhone ? `📞 ${task.contactName ? task.contactName + ": " : ""}${task.contactPhone}` : "",
          task.contactEmail ? `✉️ ${task.contactEmail}` : "",
        ].filter(Boolean);
        try {
          await sendWhatsApp({ phoneNumberId, to: employeePhone, reply: lines.join("\n"), buttons: ["Erledigt"] });
          notifications.push({ taskId: task.id, sent: true });
        } catch (error) {
          notifications.push({ taskId: task.id, sent: false, reason: String(error?.message || error) });
        }
      }
      res.json({ ok: true, tasks: clean, notifications });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Derselbe Dialogkern wird vom Browser-Simulator und vom echten WhatsApp-Webhook verwendet.
  return { handleMessage, localDateISO };
}

module.exports = { registerKristine };
