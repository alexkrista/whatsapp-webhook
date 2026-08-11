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
      const closeMissing = hasStarted && !close;
      const closeIncomplete = Boolean(close && !close.complete);

      return res.json({
        ok:true, today, yesterday, hadWork:hasStarted,
        forgotClockOut:hasStarted && !hasEnded,
        autoClosed, autoClosedAt:autoClosed ? "17:00" : null,
        dayCloseMissing:closeMissing,
        dayCloseIncomplete:closeIncomplete,
        needsAttention:Boolean((hasStarted && !hasEnded) || closeMissing || closeIncomplete),
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
