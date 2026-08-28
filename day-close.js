"use strict";

const fsp = require("fs/promises");
const path = require("path");

function registerDayClose(app, {
  dataDir,
  requireAdmin,
  readEmployees,
  sendWhatsApp,
  phoneNumberId,
  publicBaseUrl = "",
  logger = console,
}) {
  const root = path.join(dataDir, "_kristine");
  const dayCloseFile = path.join(root, "day-closes.json");
  const timeEventsFile = path.join(root, "time-events.json");
  const statesFile = path.join(root, "states.json");
  const tasksFile = path.join(root, "tasks.json");

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  }

  async function writeJsonAtomic(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(temp, file);
  }

  function normalizePhone(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("0")) digits = `43${digits.slice(1)}`;
    return digits;
  }

  function localTime() {
    return new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date());
  }

  function localDate() {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Vienna",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function employeeName(employee, fallback = "") {
    return String(
      employee?.nickname ||
      employee?.rufname ||
      employee?.name ||
      employee?.employeeName ||
      fallback ||
      "Mitarbeiter"
    ).trim();
  }

  function findEmployee(employees, employeeId) {
    return employees.find((employee) =>
      String(employee?.id || employee?.employeeId || "") === String(employeeId)
    ) || null;
  }

  function cleanChecks(value) {
    const checks = value && typeof value === "object" ? value : {};
    return {
      time: checks.time === true,
      photos: checks.photos === true,
      material: checks.material === true,
      regie: checks.regie === true,
      order: checks.order === true,
    };
  }

  function completedCount(checks) {
    return Object.values(checks).filter(Boolean).length;
  }

  function upsertByEmployeeDate(rows, record) {
    const index = rows.findIndex((row) =>
      String(row.employeeId) === String(record.employeeId) &&
      String(row.date) === String(record.date)
    );

    if (index === -1) return [...rows, record];

    const next = rows.slice();
    next[index] = {
      ...next[index],
      ...record,
      createdAt: next[index].createdAt || record.createdAt,
    };
    return next;
  }

  function appendFinishEvent(events, record) {
    const exists = events.some((event) =>
      String(event.employeeId) === String(record.employeeId) &&
      String(event.date) === String(record.date) &&
      ["ende", "fertig", "stop", "stopp"].includes(String(event.type || "").toLowerCase())
    );

    if (exists) return events;

    return [
      ...events,
      {
        id: `day_close_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        employeeId: record.employeeId,
        employeeName: record.employeeName,
        date: record.date,
        at: record.finishedAt,
        type: "ende",
        command: "feierabend",
        jobId: record.jobId,
        jobName: record.jobName,
        source: "kristine-go-day-close",
        createdAt: new Date().toISOString(),
      },
    ];
  }

  function confirmationText(record) {
    const done = completedCount(record.checks);
    const lines = [
      `✅ Danke ${record.employeeName}.`,
      "",
      "Dein Tagesabschluss wurde gespeichert.",
    ];

    if (record.jobName || record.jobId) {
      lines.push(`📍 ${record.jobName || record.jobId}`);
    }

    lines.push(`📋 Tageskontrolle: ${done}/5 geprüft`);

    if (!record.complete) {
      lines.push("", "⚠️ Der Abschluss enthält noch offene Prüfpunkte.");
    }

    if (record.note) {
      lines.push("", "📝 Deine Tagesnotiz wurde gespeichert.");
    }

    return lines.join("\n");
  }

  function previousLocalDate(date) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // ===================== KGO Baustellenwechsel =====================
  // Ein einziger, klarer Datenweg: KGO zeigt nur Auftrag + Laufend.
  // Keine Angebote, keine fertigen/geschlossenen Baustellen und kein "UNBEKANNT".
  function safeJobId(value) {
    const id = String(value || "").trim();
    return /^[A-Za-z0-9_-]{1,100}$/.test(id) && !id.startsWith("_");
  }

  async function readJobMetaLocal(jobId) {
    if (!safeJobId(jobId)) return null;
    const file = path.join(dataDir, jobId, ".meta.json");
    try {
      const meta = JSON.parse(await fsp.readFile(file, "utf8"));
      return meta && typeof meta === "object" ? meta : null;
    } catch {
      return null;
    }
  }

  function activeJobRow(jobId, meta) {
    if (!meta || !["Auftrag", "Laufend"].includes(String(meta.status || "").trim())) return null;
    const street = [meta.street, meta.houseNumber].filter(Boolean).join(" ").trim();
    const city = [meta.postalCode, meta.city].filter(Boolean).join(" ").trim();
    return {
      jobId: String(jobId),
      jobName: String(meta.name || jobId).trim(),
      status: String(meta.status || ""),
      city: String(meta.city || "").trim(),
      address: [street, city].filter(Boolean).join(", "),
      contactName: String(meta.contactName || "").trim(),
      contactPhone: String(meta.contactPhone || "").trim(),
    };
  }

  async function listActiveJobs() {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true }).catch(() => []);
    const rows = await Promise.all(entries
      .filter((entry) => entry?.isDirectory?.() && safeJobId(entry.name))
      .map(async (entry) => activeJobRow(entry.name, await readJobMetaLocal(entry.name))));

    return rows.filter(Boolean).sort((left, right) => {
      const statusOrder = (left.status === "Laufend" ? 0 : 1) - (right.status === "Laufend" ? 0 : 1);
      if (statusOrder) return statusOrder;
      const leftNumber = /^\d+$/.test(left.jobId) ? Number(left.jobId) : -1;
      const rightNumber = /^\d+$/.test(right.jobId) ? Number(right.jobId) : -1;
      if (leftNumber !== rightNumber) return rightNumber - leftNumber;
      return left.jobName.localeCompare(right.jobName, "de");
    });
  }

  function appendTimeline(state, type, text, job) {
    const timeline = Array.isArray(state.timeline) ? state.timeline.slice(-99) : [];
    timeline.push({
      at: new Date().toISOString(),
      type,
      text,
      jobId: job?.jobId || null,
      jobName: job?.jobName || "",
    });
    state.timeline = timeline;
  }

  async function markJobRunningLocal(job) {
    if (!job || job.status !== "Auftrag" || !safeJobId(job.jobId)) return job;
    const file = path.join(dataDir, job.jobId, ".meta.json");
    const meta = await readJobMetaLocal(job.jobId);
    if (!meta || meta.status !== "Auftrag") return job;
    const updated = { ...meta, status: "Laufend", updatedAt: new Date().toISOString() };
    await writeJsonAtomic(file, updated);
    return { ...job, status: "Laufend" };
  }

  function expressTask({ employeeId, employeeLabel, date, job }) {
    const now = new Date().toISOString();
    return {
      id: `express_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: `Expressbaustelle zuordnen: ${job.jobName}`,
      assigneeId: "",
      assigneeName: "Chef / Büro",
      jobId: job.jobId,
      jobName: job.jobName,
      taskType: "Problem",
      priority: "heute",
      creatorId: employeeId,
      creatorName: employeeLabel,
      createdBy: employeeId,
      dueDate: date,
      note: `${employeeLabel} arbeitet auf einer Expressbaustelle. Bitte bestehender Baustelle zuordnen oder neue Baustelle anlegen und die Buchung danach bereinigen.`,
      status: "open",
      createdAt: now,
      completedAt: null,
      source: "kgo-express-site",
    };
  }

  app.get("/kristine/api/active-jobs", async (req, res) => {
    if (typeof requireAdmin === "function" && !requireAdmin(req, res)) return;
    try {
      const jobs = await listActiveJobs();
      return res.json({ ok: true, jobs, count: jobs.length });
    } catch (error) {
      logger.error("❌ KGO aktive Baustellen konnten nicht geladen werden", error);
      return res.status(500).json({ ok:false, error:String(error?.message || error) });
    }
  });

  app.post("/kristine/api/switch-job", async (req, res) => {
    if (typeof requireAdmin === "function" && !requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.body?.employeeId || "").trim();
      const date = String(req.body?.date || localDate()).trim();
      const requestedJobId = String(req.body?.jobId || "").trim();
      const expressName = String(req.body?.expressName || "").replace(/\s+/g, " ").trim().slice(0, 140);
      if (!employeeId) return res.status(400).json({ ok:false, error:"Mitarbeiter fehlt." });

      const employees = await readEmployees();
      const employee = findEmployee(employees, employeeId);
      if (!employee) return res.status(404).json({ ok:false, error:"Mitarbeiter nicht gefunden." });
      const employeeLabel = employeeName(employee);

      const [statesRaw, eventsRaw, tasksRaw] = await Promise.all([
        readJson(statesFile, {}),
        readJson(timeEventsFile, []),
        readJson(tasksFile, []),
      ]);
      const states = statesRaw && typeof statesRaw === "object" && !Array.isArray(statesRaw) ? statesRaw : {};
      const events = Array.isArray(eventsRaw) ? eventsRaw : [];
      const tasks = Array.isArray(tasksRaw) ? tasksRaw : [];
      const previous = states[employeeId] && typeof states[employeeId] === "object" ? states[employeeId] : {};
      const state = {
        ...previous,
        employeeId,
        employeeName: employeeLabel,
        mode: previous.mode || "idle",
        timeline: Array.isArray(previous.timeline) ? previous.timeline : [],
      };

      // states.json ist mitarbeiterbezogen und kann noch den Modus von gestern tragen.
      // Für einen Wechsel zählt ausschließlich der letzte echte Zeitevent von HEUTE.
      const todays = events
        .filter((event) => String(event?.employeeId || "") === employeeId && String(event?.date || "") === date)
        .sort((a,b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.at || "").localeCompare(String(b.at || "")));
      const lastRelevant = [...todays].reverse().find((event) => ["start","weiter","pause","mittag","ende","fertig","stop","stopp"].includes(String(event?.type || "").toLowerCase()));
      const lastType = String(lastRelevant?.type || "").toLowerCase();
      if (!lastRelevant) state.mode = "idle";
      else if (["start","weiter"].includes(lastType)) state.mode = "working";
      else if (lastType === "pause") state.mode = "pause";
      else if (lastType === "mittag") state.mode = "lunch";
      else if (["ende","fertig","stop","stopp"].includes(lastType)) state.mode = "finished_day";

      if (state.mode === "finished_day") {
        return res.status(409).json({ ok:false, error:"Der Tag ist bereits abgeschlossen." });
      }

      let selected = null;
      let isExpress = false;
      if (expressName) {
        if (expressName.length < 2) return res.status(400).json({ ok:false, error:"Bitte einen kurzen Namen für die Expressbaustelle eingeben." });
        const compact = date.replace(/-/g, "");
        selected = {
          jobId: `express_${compact}_${employeeId}_${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, "_"),
          jobName: expressName,
          status: "Express",
          city: "",
          address: "",
          contactName: "",
          contactPhone: "",
          express: true,
        };
        isExpress = true;
      } else {
        if (!requestedJobId) return res.status(400).json({ ok:false, error:"Bitte Baustelle auswählen." });
        const jobs = await listActiveJobs();
        selected = jobs.find((job) => String(job.jobId) === requestedJobId) || null;
        if (!selected) return res.status(409).json({ ok:false, error:"Diese Baustelle ist nicht mehr Auftrag/Laufend. Bitte Liste aktualisieren." });
      }

      const wasWorking = state.mode === "working";
      if (wasWorking && !isExpress) selected = await markJobRunningLocal(selected);

      const currentOverrideId = String(state.activeJobOverride?.date === date ? state.activeJobOverride?.jobId || "" : "");
      const lastWork = [...todays].reverse().find((event) => ["start","weiter"].includes(String(event?.type || "").toLowerCase()));
      const alreadyCurrent = currentOverrideId === selected.jobId || (wasWorking && String(lastWork?.jobId || "") === selected.jobId);

      state.activeAssignmentKey = null;
      state.activeJobOverride = {
        date,
        jobId: selected.jobId,
        jobName: selected.jobName,
        city: selected.city || "",
        address: selected.address || "",
        contactName: selected.contactName || "",
        contactPhone: selected.contactPhone || "",
        status: selected.status || "",
        express: isExpress,
      };
      state.pending = null;
      if (["finished_site"].includes(state.mode)) state.mode = "idle";
      appendTimeline(state, isExpress ? "express_site" : "site_selected", `${isExpress ? "Expressbaustelle" : "Baustelle"}: ${selected.jobName}`, selected);
      states[employeeId] = state;

      if (wasWorking && !alreadyCurrent) {
        events.push({
          id: `switch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          employeeId,
          employeeName: employeeLabel,
          date,
          type: "weiter",
          at: localTime(),
          jobId: selected.jobId,
          jobName: selected.jobName,
          source: isExpress ? "kgo-express-site" : "kgo-site-picker",
          createdAt: new Date().toISOString(),
        });
      }

      if (isExpress) tasks.push(expressTask({ employeeId, employeeLabel, date, job:selected }));

      await Promise.all([
        writeJsonAtomic(statesFile, states),
        wasWorking && !alreadyCurrent ? writeJsonAtomic(timeEventsFile, events) : Promise.resolve(),
        isExpress ? writeJsonAtomic(tasksFile, tasks) : Promise.resolve(),
      ]);

      return res.json({
        ok:true,
        selected,
        continued:wasWorking && !alreadyCurrent,
        express:isExpress,
        reply:isExpress
          ? `Expressbaustelle „${selected.jobName}“ ist aktiv. Chef/Büro bekommt sie zur Zuordnung.`
          : `Baustelle ${selected.jobId} · ${selected.jobName} ausgewählt.`,
      });
    } catch (error) {
      logger.error("❌ KGO Baustellenwechsel fehlgeschlagen", error);
      return res.status(500).json({ ok:false, error:String(error?.message || error) });
    }
  });

  app.post("/kristine/api/morning-check", async (req, res) => {
    if (typeof requireAdmin === "function" && !requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.body?.employeeId || "").trim();
      const today = String(req.body?.date || localDate()).trim();
      if (!employeeId) return res.status(400).json({ ok:false, error:"employeeId fehlt" });

      const yesterday = previousLocalDate(today);
      const [employees, rawEvents, rawCloses] = await Promise.all([
        readEmployees(), readJson(timeEventsFile, []), readJson(dayCloseFile, [])
      ]);
      const employee = findEmployee(employees, employeeId);
      if (!employee) return res.status(404).json({ ok:false, error:"Mitarbeiter nicht gefunden" });

      let events = Array.isArray(rawEvents) ? rawEvents : [];
      const closes = Array.isArray(rawCloses) ? rawCloses : [];
      const dayEvents = events.filter(e => String(e.employeeId) === employeeId && String(e.date) === yesterday);
      const hasStarted = dayEvents.some(e => ["start","weiter"].includes(String(e.type||"").toLowerCase()));
      const hasEnded = dayEvents.some(e => ["ende","fertig","stop","stopp"].includes(String(e.type||"").toLowerCase()));
      let autoClosed = false;

      if (hasStarted && !hasEnded) {
        const latestWork = [...dayEvents].reverse().find(e => ["start","weiter"].includes(String(e.type||"").toLowerCase()));
        events = [...events, {
          id:`auto_close_${yesterday}_${employeeId}`,
          employeeId,
          employeeName:employeeName(employee),
          date:yesterday,
          at:"17:00",
          type:"ende",
          command:"auto-feierabend",
          jobId:latestWork?.jobId || null,
          jobName:latestWork?.jobName || "",
          source:"kristine-morning-reconcile",
          automatic:true,
          createdAt:new Date().toISOString(),
        }];
        await writeJson(timeEventsFile, events);
        autoClosed = true;
      }

      const close = closes.find(row => String(row.employeeId) === employeeId && String(row.date) === yesterday) || null;

      // Ein bewusst bestätigter Tagesabschluss gilt als ERLEDIGT – auch wenn einzelne
      // Prüfpunkte (Fotos, Material, Bestellung ...) noch offen waren. Die Abschlussseite
      // erlaubt ausdrücklich, offene Punkte bewusst zu bestätigen. Deshalb darf
      // `complete === false` am nächsten Morgen NICHT erneut den Liegestütz-Schirm auslösen.
      const closeConfirmed = Boolean(close && close.confirmed === true);
      const closeMissing = hasStarted && !closeConfirmed;
      const closeIncomplete = Boolean(closeConfirmed && !close.complete);

      return res.json({
        ok:true, today, yesterday, hadWork:hasStarted,
        forgotClockOut:hasStarted && !hasEnded,
        autoClosed, autoClosedAt:autoClosed ? "17:00" : null,
        dayCloseMissing:closeMissing,
        // Nur Information für die Oberfläche; ein bestätigter Abschluss blockiert nicht mehr.
        dayCloseIncomplete:closeIncomplete,
        needsAttention:Boolean((hasStarted && !hasEnded) || closeMissing),
      });
    } catch (error) {
      logger.error("❌ Morgenprüfung fehlgeschlagen", error);
      return res.status(500).json({ok:false,error:String(error?.message||error)});
    }
  });

  app.post("/kristine/api/day-close", async (req, res) => {
    if (typeof requireAdmin === "function" && !requireAdmin(req, res)) return;

    try {
      const body = req.body || {};
      const employeeId = String(body.employeeId || "").trim();
      const date = String(body.date || localDate()).trim();
      const jobId = String(body.jobId || "").trim();
      const jobName = String(body.jobName || "").trim();
      const note = String(body.note || "").trim().slice(0, 4000);
      const checks = cleanChecks(body.checks);

      if (!employeeId) {
        return res.status(400).json({
          ok: false,
          error: "employeeId fehlt",
        });
      }

      const employees = await readEmployees();
      const employee = findEmployee(employees, employeeId);

      if (!employee) {
        return res.status(404).json({
          ok: false,
          error: "Mitarbeiter nicht gefunden",
        });
      }

      const now = new Date().toISOString();
      const finishedAt = localTime();
      const complete =
        Object.values(checks).every(Boolean) &&
        body.confirmed === true;

      const record = {
        id: `day_close_${date}_${employeeId}`,
        employeeId,
        employeeName: employeeName(employee, body.employeeName),
        phone: normalizePhone(employee.phone),
        date,
        jobId,
        jobName,
        note,
        checks,
        complete,
        confirmed: body.confirmed === true,
        status: "finished_day",
        finishedAt,
        createdAt: now,
        updatedAt: now,
        needsReconfirmation: false,
        source: "kristine-go",
      };

      const dayCloses = await readJson(dayCloseFile, []);
      const savedDayCloses = upsertByEmployeeDate(
        Array.isArray(dayCloses) ? dayCloses : [],
        record
      );
      await writeJson(dayCloseFile, savedDayCloses);

      // WICHTIG: Ein Tagesabschluss ist KEIN Ausstempeln.
      // Er darf niemals ein Zeitereignis "ende" erzeugen – weder heute noch beim Nachtrag.
      // Die Zeiterfassung wird ausschließlich über Start/Pause/Mittag/Feierabend geführt.

      let whatsapp = {
        sent: false,
        reason: "phone_missing",
      };

      if (record.phone) {
        try {
          const result = await sendWhatsApp({
            phoneNumberId,
            to: record.phone,
            reply: confirmationText(record),
          });

          whatsapp = {
            sent: true,
            messageId: result?.messages?.[0]?.id || null,
          };
        } catch (error) {
          whatsapp = {
            sent: false,
            reason: "send_failed",
            error: String(error?.message || error),
          };

          logger.error("❌ Tagesabschluss-WhatsApp fehlgeschlagen", {
            employeeId,
            date,
            error: whatsapp.error,
          });
        }
      }

      logger.log("✅ KRISTINE Tagesabschluss gespeichert", {
        employeeId,
        date,
        jobId,
        complete,
        whatsappSent: whatsapp.sent,
      });

      return res.json({
        ok: true,
        reply: whatsapp.sent
          ? "Tagesabschluss gespeichert und per WhatsApp bestätigt."
          : "Tagesabschluss gespeichert. WhatsApp konnte nicht versendet werden.",
        record,
        whatsapp,
        dayCloseUrl: publicBaseUrl
          ? `${String(publicBaseUrl).replace(/\/$/, "")}/public/kristine-go-abschluss.html`
          : null,
      });
    } catch (error) {
      logger.error("❌ Tagesabschluss fehlgeschlagen", error);
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error),
      });
    }
  });

  app.get("/kristine/api/day-close/:employeeId/:date", async (req, res) => {
    if (typeof requireAdmin === "function" && !requireAdmin(req, res)) return;

    try {
      const rows = await readJson(dayCloseFile, []);
      const record = (Array.isArray(rows) ? rows : []).find((row) =>
        String(row.employeeId) === String(req.params.employeeId) &&
        String(row.date) === String(req.params.date)
      ) || null;

      return res.json({
        ok: true,
        exists: Boolean(record),
        record,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error),
      });
    }
  });

  return {
    dayCloseFile,
    timeEventsFile,
  };
}

module.exports = {
  registerDayClose,
};
