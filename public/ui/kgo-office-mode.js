"use strict";

(() => {
  const VERSION = "2026-08-25-0826";
  const query = new URLSearchParams(location.search);
  const token = query.get("token") || "";
  let activeEmployeeId = "";
  let office = null;
  let syncing = false;
  let initialized = false;

  const $ = id => document.getElementById(id);

  function tokenUrl(path) {
    const u = new URL(path, location.origin);
    if (token) u.searchParams.set("token", token);
    return u.pathname + u.search;
  }

  async function api(path, options = {}) {
    const response = await fetch(tokenUrl(path), {
      credentials:"same-origin",
      ...options,
      headers:{
        Accept:"application/json",
        ...(options.body ? {"Content-Type":"application/json"} : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok || data?.ok === false) throw new Error(data?.error || text || `HTTP ${response.status}`);
    return data || {};
  }

  function employeeId() {
    return new URLSearchParams(location.search).get("employeeId") || localStorage.getItem("kristineGoEmployeeId") || "";
  }

  function localDate() {
    return new Intl.DateTimeFormat("sv-SE", { timeZone:"Europe/Vienna", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
  }

  function localHM() {
    return new Intl.DateTimeFormat("de-AT", { timeZone:"Europe/Vienna", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).format(new Date());
  }

  function currentMinutes() {
    const [h,m] = localHM().split(":").map(Number);
    return h * 60 + m;
  }

  function minutesSince(hm) {
    const match = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return 0;
    return Math.max(0, currentMinutes() - (Number(match[1]) * 60 + Number(match[2])));
  }

  function durationLabel(minutes) {
    const n = Math.max(0, Math.round(Number(minutes || 0)));
    const h = Math.floor(n / 60), m = n % 60;
    return h ? `${h} Std. ${m} Min.` : `${m} Min.`;
  }

  function installStyle() {
    if ($("kgoOfficeStyle")) return;
    const style = document.createElement("style");
    style.id = "kgoOfficeStyle";
    style.textContent = `
      body.kgo-office-mode .kg-site-actions,
      body.kgo-office-mode #kgContextCard,
      body.kgo-office-mode #kgScheduleSection,
      body.kgo-office-mode #kgQuickActions,
      body.kgo-office-mode #kgWorkActions,
      body.kgo-office-mode #kgAfternoonCard,
      body.kgo-office-mode #kgTomorrowCard{display:none!important}
      body.kgo-office-mode #kgReviewList{display:none!important}
      body.kgo-office-mode .kg-office-hidden{display:none!important}
      body.kgo-office-mode #kgFinishButton{margin-top:18px}
      .kg-office-note{margin:12px 0 0;padding:11px 13px;border-radius:12px;background:#eef6ef;border:1px solid #cfe1d2;color:#285738;font-size:13px;line-height:1.45}
      .kg-office-reminder-bg{position:fixed;inset:0;z-index:50000;display:grid;place-items:center;padding:18px;background:rgba(0,0,0,.56)}
      .kg-office-reminder{width:min(520px,100%);background:#fff;border-radius:22px;padding:22px;box-shadow:0 26px 90px rgba(0,0,0,.34)}
      .kg-office-reminder h2{margin:0 0 7px;font-size:24px}.kg-office-reminder p{margin:0 0 16px;color:#5d655f;line-height:1.5}
      .kg-office-reminder label{display:block;font-size:13px;font-weight:850;margin:0 0 6px}.kg-office-reminder input{width:100%;font:inherit;font-size:20px;padding:12px;border:1px solid #cfd5cf;border-radius:12px;box-sizing:border-box}
      .kg-office-reminder-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px}.kg-office-reminder-actions button{min-height:48px;border-radius:12px;font:850 15px system-ui;border:1px solid #cfd5cf;cursor:pointer}
      .kg-office-reminder-save{background:#27713d;color:#fff;border-color:#27713d!important}.kg-office-reminder-work{background:#fff;color:#222}.kg-office-reminder-error{margin-top:9px;color:#9d2525;font-weight:750;font-size:13px}
      @media(max-width:560px){.kg-office-reminder-actions{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function hideDayCloseSection() {
    const review = $("kgReviewList");
    review?.closest(".kg-section")?.classList.add("kg-office-hidden");
  }

  function ensureOfficeNote() {
    const timeCard = document.querySelector(".kg-time-card");
    if (!timeCard || $("kgOfficeNote")) return;
    const note = document.createElement("div");
    note.id = "kgOfficeNote";
    note.className = "kg-office-note";
    note.textContent = "Büromodus: Start und Ende genügen. 022 Büroarbeiten wird automatisch gebucht – kein Tagesabschluss nötig.";
    timeCard.insertAdjacentElement("afterend", note);
  }

  function modeLabel(mode) {
    if (["working","pause","lunch"].includes(mode)) return "Eingestempelt";
    if (mode === "finished_day") return "Ausgestempelt";
    return "Noch nicht gestartet";
  }

  function applyOfficeUi() {
    if (!office?.office) return;
    document.body.classList.add("kgo-office-mode");
    hideDayCloseSection();
    ensureOfficeNote();

    const sub = document.querySelector(".kg-brand-sub");
    if (sub) sub.textContent = "Dein digitaler Büro-Begleiter";
    const eyebrow = document.querySelector(".kg-site-card .kg-eyebrow");
    if (eyebrow) eyebrow.textContent = "Arbeitsbereich";

    if ($("kgSiteTitle")) $("kgSiteTitle").textContent = `${office.jobId} – ${office.jobName}`;
    if ($("kgSiteAddress")) $("kgSiteAddress").textContent = "Büro · keine Baustellenauswahl";

    const badge = $("kgWorkStatus");
    if (badge) {
      badge.textContent = modeLabel(office.mode);
      badge.className = "kg-status-pill";
      if (["working","pause","lunch"].includes(office.mode)) badge.classList.add("is-working");
    }

    if ($("kgActionHeading")) $("kgActionHeading").textContent = "Bürozeit";
    if ($("kgPhaseLabel")) $("kgPhaseLabel").textContent = "022";

    const startPanel = $("kgStartPanel");
    const startButton = $("kgStartButton");
    const finish = $("kgFinishButton");
    const running = ["working","pause","lunch"].includes(office.mode);

    if (startPanel) startPanel.classList.toggle("kg-hidden", running);
    if (startButton) {
      startButton.onclick = () => clock("start");
      const strong = startButton.querySelector("strong");
      const small = startButton.querySelector("small");
      if (strong) strong.textContent = office.mode === "finished_day" ? "Nochmals einstempeln" : "Büroarbeit starten";
      if (small) small.textContent = "Ein Fingertipp – 022 Büroarbeiten läuft.";
    }

    if (finish) {
      finish.classList.toggle("kg-hidden", !running);
      finish.textContent = "■ Ausstempeln";
      finish.onclick = () => clock("end");
    }

    const headline = $("kgTimeHeadline");
    const detail = $("kgTimeDetail");
    const review = $("kgReviewTime");
    if (running) {
      if (headline) headline.textContent = `Bürozeit läuft seit ${office.startAt || "–"} Uhr`;
      if (detail) detail.textContent = office.startAt ? `Seit ${durationLabel(minutesSince(office.startAt))}` : "Arbeitszeit läuft.";
      if (review) review.textContent = `Läuft seit ${office.startAt || "–"} Uhr`;
    } else if (office.mode === "finished_day") {
      if (headline) headline.textContent = "Bürozeit beendet";
      if (detail) detail.textContent = office.endAt ? `Ende ${office.endAt} Uhr` : "Heute ausgestempelt.";
      if (review) review.textContent = office.endAt ? `Ende ${office.endAt} Uhr` : "Ausgestempelt";
    } else {
      if (headline) headline.textContent = "Bürozeit bereit";
      if (detail) detail.textContent = "Start drücken – 022 Büroarbeiten wird automatisch gebucht.";
      if (review) review.textContent = "Noch nicht gestartet";
    }

    maybeShowReminder();
  }

  async function clock(action, at = "") {
    try {
      const result = await api("/kristine/api/office-clock", {
        method:"POST",
        body:JSON.stringify({ employeeId:activeEmployeeId, action, at }),
      });
      office = result;
      applyOfficeUi();
      const toast = $("kgToast");
      if (toast) {
        toast.textContent = result.reply || "Gespeichert.";
        toast.classList.add("is-visible");
        setTimeout(() => toast.classList.remove("is-visible"), 2600);
      }
      closeReminder();
    } catch (error) {
      const err = $("kgOfficeReminderError");
      if (err) err.textContent = String(error?.message || error);
      else alert(String(error?.message || error));
    }
  }

  function reminderKey() {
    return `kgoOfficeReminderDismissed:${office?.date || localDate()}:${activeEmployeeId}`;
  }

  function closeReminder() {
    $("kgOfficeReminderBg")?.remove();
  }

  function dismissReminder() {
    sessionStorage.setItem(reminderKey(), "1");
    closeReminder();
  }

  function maybeShowReminder() {
    if (!office?.office || !["working","pause","lunch"].includes(office.mode)) return;
    if (currentMinutes() < 12 * 60 + 15) return;
    if (sessionStorage.getItem(reminderKey()) === "1") return;
    if ($("kgOfficeReminderBg")) return;

    const bg = document.createElement("div");
    bg.id = "kgOfficeReminderBg";
    bg.className = "kg-office-reminder-bg";
    bg.innerHTML = `<div class="kg-office-reminder">
      <h2>⏰ Noch eingestempelt</h2>
      <p>Vergessen auszutempeln? Wenn du schon fertig bist: Wann war Ende?</p>
      <label for="kgOfficeEndTime">Endzeit</label>
      <input id="kgOfficeEndTime" type="time" value="${localHM()}">
      <div class="kg-office-reminder-actions">
        <button id="kgOfficeStillWorking" class="kg-office-reminder-work" type="button">Ich arbeite noch</button>
        <button id="kgOfficeSaveEnd" class="kg-office-reminder-save" type="button">Endzeit speichern</button>
      </div>
      <div id="kgOfficeReminderError" class="kg-office-reminder-error"></div>
    </div>`;
    document.body.appendChild(bg);
    $("kgOfficeStillWorking").onclick = dismissReminder;
    $("kgOfficeSaveEnd").onclick = () => clock("end", $("kgOfficeEndTime").value);
  }

  async function syncStatus(force = false) {
    if (syncing) return;
    const id = employeeId();
    if (!id) return;
    if (initialized && id !== activeEmployeeId) {
      location.reload();
      return;
    }
    activeEmployeeId = id;
    syncing = true;
    try {
      const result = await api(`/kristine/api/office-status?employeeId=${encodeURIComponent(id)}`);
      office = result;
      initialized = true;
      if (office.office) applyOfficeUi();
    } catch (error) {
      if (force) console.warn("KGO Büro-Modus", error);
    } finally {
      syncing = false;
    }
  }

  function install() {
    installStyle();
    const wait = () => {
      if (!$("kgContent") || !$("kgEmployeeName")) return setTimeout(wait, 120);
      syncStatus(true);
      setInterval(() => syncStatus(false), 30_000);
      setInterval(() => { if (office?.office) applyOfficeUi(); }, 5_000);
      console.info("KGO Büro-Modus", VERSION);
    };
    wait();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once:true });
  else install();
})();
