"use strict";

(function () {
  const VERSION = "2026-08-24-1555";
  let installed = false;

  function selectedDate() {
    try { return typeof selectedWorkDate === "function" ? String(selectedWorkDate() || "") : ""; } catch { return ""; }
  }

  function liveDate() {
    try { return typeof data !== "undefined" ? String(data?.today || "") : ""; } catch { return ""; }
  }

  function isHistorical() {
    const d = selectedDate(), t = liveDate();
    return !!d && !!t && d !== t;
  }

  function eventDate(row) {
    const direct = String(row?.date || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
    const raw = row?.createdAt || row?.timestamp || row?.atIso || "";
    if (!raw) return "";
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return "";
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(dt);
      const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}`;
    } catch { return ""; }
  }

  function employeeEvents(employeeId, date) {
    try {
      return (data?.timeEvents || []).filter(x => String(x?.employeeId) === String(employeeId) && String(x?.date) === String(date));
    } catch { return []; }
  }

  function employeePlans(employeeId, employeeName, date) {
    try {
      const rows = (data?.assignments || []).filter(x => String(x?.date) === String(date));
      let own = rows.filter(x => String(x?.employeeId) === String(employeeId));
      if (!own.length && employeeName) own = rows.filter(x => String(x?.employeeName || "") === String(employeeName));
      return own;
    } catch { return []; }
  }

  function typeOf(row) {
    try { return typeof cardTypeOf === "function" ? String(cardTypeOf(row) || "") : String(row?.cardType || "site"); }
    catch { return String(row?.cardType || "site"); }
  }

  function historicalState(employeeId, employeeName, date) {
    const plans = employeePlans(employeeId, employeeName, date);
    const absence = plans.find(x => ["urlaub", "krank", "za", "feiertag", "betriebsurlaub"].includes(typeOf(x)));
    if (absence) {
      const type = typeOf(absence);
      const labels = { urlaub: "Urlaub", krank: "Krank", za: "Zeitausgleich", feiertag: "Feiertag", betriebsurlaub: "Betriebsurlaub" };
      return { label: labels[type] || "Abwesend", css: "idle" };
    }

    const events = employeeEvents(employeeId, date);
    const hasEnd = events.some(x => ["ende", "end", "finished_day", "day_end"].includes(String(x?.type || "").toLowerCase()));
    if (hasEnd) return { label: "Feierabend", css: "finished_day" };
    if (events.length) return { label: "Tag erfasst", css: "idle" };
    if (plans.length) return { label: "Eingeplant", css: "idle" };
    return { label: "Keine Buchung", css: "idle" };
  }

  function lastHistoricalAction(employeeId, date) {
    const events = employeeEvents(employeeId, date);
    if (!events.length) return "–";
    const last = events.at(-1) || {};
    if (last.detail) return String(last.detail);
    const labels = {
      start: "Arbeitsbeginn",
      weiter: "Arbeit fortgesetzt",
      pause: "Pause",
      mittag: "Mittag",
      ende: "Feierabend",
      end: "Feierabend"
    };
    return labels[String(last.type || "").toLowerCase()] || String(last.type || "Buchung");
  }

  function employeeIdFromCard(card) {
    const nodes = card.querySelectorAll("[onclick*='openEmployeeActionModal']");
    for (const node of nodes) {
      const raw = String(node.getAttribute("onclick") || "");
      const m = raw.match(/openEmployeeActionModal\(['\"]([^'\"]+)['\"]\)/);
      if (m) return m[1];
    }
    return "";
  }

  function patchAlerts(date) {
    const box = document.getElementById("controlAlerts");
    if (!box) return;
    let unknown = 0, regie = 0;
    try {
      Object.values(data?.states || {}).forEach(state => (state?.timeline || []).forEach(row => {
        if (eventDate(row) !== date) return;
        if (row.type === "assignment_deviation") unknown += 1;
        if (row.type === "regie_reported") regie += 1;
      }));
    } catch {}
    const alerts = [];
    if (unknown) alerts.push(`<span>🔔 ${unknown} unbekannte Baustelle${unknown === 1 ? "" : "n"}</span>`);
    if (regie) alerts.push(`<span>📝 ${regie} Regie-Vormerkung${regie === 1 ? "" : "en"}</span>`);
    box.style.display = alerts.length ? "block" : "none";
    box.innerHTML = alerts.length ? `<strong>Offene Punkte</strong><br><span style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:5px">${alerts.join("<span>·</span>")}</span>` : "";
  }

  function patchHistoricalControl() {
    if (!isHistorical()) return;
    const date = selectedDate();
    document.querySelectorAll("#controlList .control-card").forEach(card => {
      const employeeId = employeeIdFromCard(card);
      const employeeName = String(card.querySelector(".control-name")?.textContent || "").trim();
      if (!employeeId && !employeeName) return;
      const state = historicalState(employeeId, employeeName, date);
      const badge = card.querySelector(".status");
      if (badge) {
        badge.className = `status ${state.css}`;
        badge.textContent = state.label;
      }
      const meta = [...card.querySelectorAll(".control-meta span")].find(x => String(x.textContent || "").includes("Letzte Aktion:"));
      if (meta) meta.innerHTML = `Letzte Aktion: <strong>${escapeHtml(lastHistoricalAction(employeeId, date))}</strong>`;
    });
    patchAlerts(date);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function patchEmployeeInfo(employeeId) {
    if (!isHistorical()) return;
    const info = document.getElementById("employeeActionInfo");
    if (!info) return;
    const date = selectedDate();
    let name = "";
    try { name = (masterEmployees || []).find(e => String(e.id) === String(employeeId))?.name || ""; } catch {}
    const state = historicalState(employeeId, name, date);
    info.innerHTML = info.innerHTML.replace(/(<strong>Status:<\/strong>)\s*[^<]*/i, `$1 ${escapeHtml(state.label)}`);
  }

  function install() {
    if (installed) return true;
    if (typeof window.renderControl !== "function" || typeof window.employeeDaySegments !== "function") return false;
    installed = true;

    const originalEmployeeDaySegments = window.employeeDaySegments;
    window.employeeDaySegments = function (employeeId, date, state) {
      const historical = String(date || "") && String(date || "") !== liveDate();
      const safeState = historical ? { ...(state || {}), mode: "idle" } : state;
      return originalEmployeeDaySegments.call(this, employeeId, date, safeState);
    };

    const originalRenderControl = window.renderControl;
    window.renderControl = function () {
      const result = originalRenderControl.apply(this, arguments);
      if (isHistorical()) queueMicrotask(patchHistoricalControl);
      return result;
    };

    if (typeof window.openEmployeeActionModal === "function") {
      const originalOpenEmployeeActionModal = window.openEmployeeActionModal;
      window.openEmployeeActionModal = async function (employeeId) {
        const result = await originalOpenEmployeeActionModal.apply(this, arguments);
        if (isHistorical()) setTimeout(() => patchEmployeeInfo(employeeId), 0);
        return result;
      };
    }

    if (isHistorical()) window.renderControl();
    console.info("KRISTINE Leitstand Datumsfix", VERSION);
    return true;
  }

  if (!install()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (install() || tries > 40) clearInterval(timer);
    }, 100);
  }
})();
