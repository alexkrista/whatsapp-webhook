"use strict";

const KristineGo = (() => {
  const state = {
    bootstrap: null,
    employee: null,
    todayAssignments: [],
    currentAssignment: null,
    employeeState: null,
    timerHandle: null,
    assistant: null,
    localReview: {},
    materialResponses: [],
  };
  const query = new URLSearchParams(location.search);
const token = query.get("token") || "";

function authenticatedUrl(url) {
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

  const $ = (id) => document.getElementById(id);
  const qsa = (selector) => [...document.querySelectorAll(selector)];

  const elements = {};

  function cacheElements() {
    [
      "kgLoading","kgError","kgErrorText","kgContent","kgGreeting","kgEmployeeButton","kgEmployeeName",
      "kgSiteTitle","kgSiteAddress","kgWorkStatus","kgTimeHeadline","kgTimeDetail","kgWrongSiteButton",
      "kgNavigationButton","kgContextCard","kgContextIcon","kgContextTitle","kgContextText","kgContextAction",
      "kgScheduleSection","kgScheduleCount","kgSchedule","kgActionHeading","kgPhaseLabel","kgStartPanel",
      "kgStartButton","kgWorkActions","kgQuickActions","kgPauseButton","kgLunchButton","kgSwitchButton",
      "kgAfternoonCard","kgReviewTime","kgReviewPhotos","kgReviewMaterial","kgReviewOrder",
      "kgPhotoReviewStatus","kgMaterialReviewStatus","kgOrderReviewStatus","kgMaterialResponseCard","kgMaterialResponseCount","kgMaterialResponseList","kgTomorrowCard",
      "kgTomorrowTitle","kgTomorrowMeta","kgTomorrowNavigation","kgFinishButton","kgEmployeeDialog",
      "kgEmployeeList","kgAssistantDialog","kgAssistantEyebrow","kgAssistantTitle","kgAssistantQuestion",
      "kgAssistantBody","kgAssistantSecondary","kgAssistantPrimary","kgToast"
    ].forEach(id => elements[id] = $(id));
  }

  async function api(url, options = {}) {
    const response = await fetch(authenticatedUrl(url), {
      credentials: "same-origin",
      ...options,
      headers: {
        "Accept": "application/json",
        ...(options.body ? {"Content-Type":"application/json"} : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`Ungültige Serverantwort (${response.status}).`); }
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || data.message || `Serverfehler ${response.status}`);
    }
    return data;
  }

  function todayISO() {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Vienna",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function tomorrowISO(date = todayISO()) {
    const value = new Date(`${date}T12:00:00`);
    value.setDate(value.getDate() + 1);
    return value.toISOString().slice(0, 10);
  }

  function currentViennaHour() {
    return Number(new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna", hour: "2-digit", hourCycle: "h23"
    }).format(new Date()));
  }

  function greeting() {
    const hour = currentViennaHour();
    if (hour < 10) return "Guten Morgen";
    if (hour < 17) return "Guten Tag";
    return "Guten Abend";
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    })[char]);
  }

  function employeeId(employee) {
    return String(employee?.id || employee?.employeeId || "").trim();
  }

  function employeeName(employee) {
    return String(employee?.nickname || employee?.rufname || employee?.name || employee?.employeeName || employeeId(employee) || "Mitarbeiter").trim();
  }

  function assignmentKey(a) {
    return `${a?.date || ""}|${a?.employeeId || ""}|${a?.from || ""}|${a?.jobId || ""}`;
  }

  function assignmentTitle(a) {
    if (!a) return "Keine Baustelle";
    const number = String(a.jobId || "").trim();
    const name = String(a.jobName || "").trim();
    return [number, name].filter(Boolean).join(" – ") || "Baustelle";
  }

  function assignmentPlace(a) {
    return [a?.address, a?.city].filter(Boolean).join(" · ");
  }

  function mapsUrl(a) {
    const address = [a?.address, a?.city].filter(Boolean).join(", ").trim();
    if (!address) return "#";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  }

  function getQueryEmployeeId() {
    return new URLSearchParams(location.search).get("employeeId") || localStorage.getItem("kristineGoEmployeeId") || "";
  }

  function setEmployee(employee) {
    state.employee = employee;
    const id = employeeId(employee);
    if (id) {
      localStorage.setItem("kristineGoEmployeeId", id);
      const url = new URL(location.href);
      url.searchParams.set("employeeId", id);
      history.replaceState(null, "", url);
    }
    deriveEmployeeData();
    render();
  }

  function employees() {
    return (state.bootstrap?.employees || []).filter(emp => emp && emp.active !== false && employeeId(emp));
  }

  function deriveEmployeeData() {
    const id = employeeId(state.employee);
    const today = state.bootstrap?.today || todayISO();
    state.todayAssignments = (state.bootstrap?.assignments || [])
      .filter(a => String(a.employeeId) === id && String(a.date) === today)
      .sort((a,b) => String(a.from || "").localeCompare(String(b.from || "")));

    state.employeeState = state.bootstrap?.states?.[id] || {
      employeeId: id, employeeName: employeeName(state.employee), mode: "idle", timeline: []
    };

    const activeKey = state.employeeState?.activeAssignmentKey;
    state.currentAssignment =
      state.todayAssignments.find(a => assignmentKey(a) === activeKey) ||
      state.todayAssignments[0] ||
      null;
  }

  function isFirstSiteDay(assignment) {
    if (!assignment) return false;
    const id = employeeId(state.employee);
    const today = state.bootstrap?.today || todayISO();
    return !(state.bootstrap?.assignments || []).some(a =>
      String(a.employeeId) === id &&
      String(a.jobId || a.jobName) === String(assignment.jobId || assignment.jobName) &&
      String(a.date) < today
    );
  }

  function isLastSiteDay(assignment) {
    return Boolean(assignment?.lastDay || assignment?.isLastDay || assignment?.finalDay);
  }

  function latestWorkEvent() {
    const id = employeeId(state.employee);
    const today = state.bootstrap?.today || todayISO();
    const events = (state.bootstrap?.timeEvents || [])
      .filter(row => String(row.employeeId) === id && String(row.date) === today)
      .filter(row => ["start","weiter","pause","mittag","ende"].includes(String(row.type)))
      .sort((a,b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.at || "").localeCompare(String(b.at || "")));
    return events.at(-1) || null;
  }

  function currentStartEvent() {
    const id = employeeId(state.employee);
    const today = state.bootstrap?.today || todayISO();
    return (state.bootstrap?.timeEvents || [])
      .filter(row =>
        String(row.employeeId) === id &&
        String(row.date) === today &&
        ["start","weiter"].includes(String(row.type))
      )
      .sort((a,b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.at || "").localeCompare(String(b.at || "")))
      .at(-1) || null;
  }

  function minutesSince(hm) {
    const match = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return 0;
    const nowParts = Object.fromEntries(new Intl.DateTimeFormat("de-AT", {
      timeZone:"Europe/Vienna",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(new Date()).map(x => [x.type,x.value]));
    const now = Number(nowParts.hour) * 60 + Number(nowParts.minute);
    return Math.max(0, now - (Number(match[1]) * 60 + Number(match[2])));
  }

  function durationLabel(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours) return `${hours} Std. ${minutes} Min.`;
    return `${minutes} Min.`;
  }

  function renderEmployeeChooser() {
    elements.kgEmployeeList.innerHTML = employees().map(emp => {
      const id = employeeId(emp);
      const planned = (state.bootstrap?.assignments || []).filter(a =>
        String(a.employeeId) === id && String(a.date) === (state.bootstrap?.today || todayISO())
      ).length;
      return `<button class="kg-choice-button" type="button" data-employee-id="${esc(id)}">
        <span><strong>${esc(employeeName(emp))}</strong><small>${planned ? `${planned} Einteilung${planned === 1 ? "" : "en"} heute` : "Heute nicht eingeteilt"}</small></span>
        <span>›</span>
      </button>`;
    }).join("") || `<p>Keine aktiven Mitarbeiter gefunden.</p>`;

    elements.kgEmployeeList.querySelectorAll("[data-employee-id]").forEach(button => {
      button.addEventListener("click", () => {
        const emp = employees().find(x => employeeId(x) === button.dataset.employeeId);
        if (emp) setEmployee(emp);
        elements.kgEmployeeDialog.close();
      });
    });
  }

  function renderSite() {
    const a = state.currentAssignment;
    const mode = state.employeeState?.mode || "idle";
    elements.kgSiteTitle.textContent = assignmentTitle(a);
    elements.kgSiteAddress.textContent = assignmentPlace(a) || (a ? "Adresse nicht hinterlegt" : "Für heute ist noch keine Baustelle geplant.");
    elements.kgNavigationButton.href = mapsUrl(a);
    elements.kgNavigationButton.classList.toggle("kg-hidden", !a || mapsUrl(a) === "#");

    const labels = {
      idle:"Noch nicht gestartet",
      working:"Auf Baustelle",
      pause:"Sonderpause",
      lunch:"Mittag",
      finished_site:"Baustelle beendet",
      finished_day:"Tag abgeschlossen",
    };
    elements.kgWorkStatus.textContent = labels[mode] || labels.idle;
    elements.kgWorkStatus.className = "kg-status-pill";
    if (mode === "working") elements.kgWorkStatus.classList.add("is-working");
    if (["pause","lunch"].includes(mode)) elements.kgWorkStatus.classList.add("is-pause");

    renderTime();
  }

  function renderTime() {
    const mode = state.employeeState?.mode || "idle";
    const start = currentStartEvent();
    if (mode === "working" && start?.at) {
      elements.kgTimeHeadline.textContent = `Zeit läuft seit ${start.at} Uhr`;
      elements.kgTimeDetail.textContent = `Auf Baustelle seit ${durationLabel(minutesSince(start.at))}`;
      elements.kgReviewTime.textContent = `Läuft seit ${start.at} Uhr`;
    } else if (mode === "pause") {
      elements.kgTimeHeadline.textContent = "Sonderpause läuft";
      elements.kgTimeDetail.textContent = "Mit „Weiter“ setzt du die Arbeitszeit fort.";
      elements.kgReviewTime.textContent = "Sonderpause offen";
    } else if (mode === "lunch") {
      elements.kgTimeHeadline.textContent = "Mittag läuft";
      elements.kgTimeDetail.textContent = "Mit „Weiter“ setzt du die Arbeitszeit fort.";
      elements.kgReviewTime.textContent = "Mittagspause offen";
    } else if (mode === "finished_day") {
      elements.kgTimeHeadline.textContent = "Arbeitstag abgeschlossen";
      elements.kgTimeDetail.textContent = "Danke – dein Tag ist gespeichert.";
      elements.kgReviewTime.textContent = "Tag abgeschlossen";
    } else {
      const from = state.currentAssignment?.from || "07:00";
      elements.kgTimeHeadline.textContent = `Geplanter Start ${from} Uhr`;
      elements.kgTimeDetail.textContent = "Starte, sobald du loslegst.";
      elements.kgReviewTime.textContent = "Noch nicht gestartet";
    }
  }

  function renderContext() {
    const a = state.currentAssignment;
    const mode = state.employeeState?.mode || "idle";
    const first = isFirstSiteDay(a);
    const last = isLastSiteDay(a);
    const hour = currentViennaHour();

    elements.kgContextCard.classList.add("kg-hidden");
    if (!a || mode === "finished_day") return;

    let ctx = null;
    if (last) {
      ctx = {
        icon:"🏁", title:"Letzter geplanter Baustellentag",
        text:"Abschlussfotos, Restmaterial und offene Leistungen sauber prüfen.",
        button:"Abschluss vorbereiten", action:() => openAssistant("finish")
      };
    } else if (first) {
      ctx = {
        icon:"📸", title:"Erster Tag auf dieser Baustelle",
        text:"Ausgangszustand, bereits beschädigte oder verschmutzte Bereiche und wichtige Details dokumentieren.",
        button:"Vorher-Fotos aufnehmen", action:() => openAssistant("photo")
      };
    } else if (hour >= 14) {
      ctx = {
        icon:"🌇", title:"An morgen denken",
        text:"Materialbedarf und noch offene Abschlussarbeiten kurz prüfen.",
        button:"Material für morgen", action:() => openAssistant("order")
      };
    }

    if (!ctx) return;
    elements.kgContextIcon.textContent = ctx.icon;
    elements.kgContextTitle.textContent = ctx.title;
    elements.kgContextText.textContent = ctx.text;
    elements.kgContextAction.textContent = ctx.button;
    elements.kgContextAction.onclick = ctx.action;
    elements.kgContextCard.classList.remove("kg-hidden");
  }

  function renderSchedule() {
    const rows = state.todayAssignments;
    const show = rows.length > 1;
    elements.kgScheduleSection.classList.toggle("kg-hidden", !show);
    elements.kgSwitchButton.classList.toggle("kg-hidden", !show);
    elements.kgQuickActions.classList.toggle("has-switch", show);
    if (!show) return;

    elements.kgScheduleCount.textContent = `${rows.length} Baustellen`;
    elements.kgSchedule.innerHTML = rows.map(a => {
      const current = assignmentKey(a) === assignmentKey(state.currentAssignment);
      return `<div class="kg-schedule-item ${current ? "is-current" : ""}">
        <span class="kg-schedule-dot"></span>
        <span class="kg-schedule-copy">
          <strong>${esc(assignmentTitle(a))}</strong>
          <small>${esc(a.from || "offen")}${a.to ? `–${esc(a.to)}` : ""}${a.city ? ` · ${esc(a.city)}` : ""}</small>
        </span>
        ${current ? `<span class="kg-current-chip">AKTUELL</span>` : ""}
      </div>`;
    }).join("");
  }

  function renderActions() {
    const mode = state.employeeState?.mode || "idle";
    const started = ["working","pause","lunch","finished_site","finished_day"].includes(mode);
    const finished = mode === "finished_day";
    const paused = ["pause","lunch"].includes(mode);
    const hour = currentViennaHour();

    elements.kgStartPanel.classList.toggle("kg-hidden", started);
    elements.kgWorkActions.classList.toggle("kg-hidden", !started || finished);
    elements.kgQuickActions.classList.toggle("kg-hidden", !started || finished);

    elements.kgActionHeading.textContent = !started ? "Los geht’s" : paused ? "Pause läuft" : finished ? "Heute geschafft" : "Jetzt auf der Baustelle";
    elements.kgPhaseLabel.textContent = !started ? "Arbeitsbeginn" : hour >= 14 ? "Nachmittag" : "Arbeitsphase";

    if (mode === "pause" || mode === "lunch") {
      elements.kgPauseButton.textContent = "▶ Weiter";
      elements.kgLunchButton.classList.add("kg-hidden");
    } else {
      elements.kgPauseButton.textContent = "☕ Sonderpause";
      elements.kgLunchButton.classList.remove("kg-hidden");
    }

    const orderCard = document.querySelector('[data-action="order"].kg-action-card');
    orderCard?.classList.toggle("is-priority", hour >= 14);
    const photoCard = document.querySelector('[data-action="photo"].kg-action-card');
    photoCard?.classList.toggle("is-priority", isFirstSiteDay(state.currentAssignment) || isLastSiteDay(state.currentAssignment));

    elements.kgAfternoonCard.classList.toggle("kg-hidden", hour < 14 || finished);
  }

  function renderTomorrow() {
    const tomorrow = tomorrowISO(state.bootstrap?.today || todayISO());
    const id = employeeId(state.employee);
    const rows = (state.bootstrap?.assignments || [])
      .filter(a => String(a.employeeId) === id && String(a.date) === tomorrow)
      .sort((a,b) => String(a.from || "").localeCompare(String(b.from || "")));
    elements.kgTomorrowCard.classList.toggle("kg-hidden", !rows.length);
    if (!rows.length) return;

    const first = rows[0];
    elements.kgTomorrowTitle.textContent = rows.length === 1 ? assignmentTitle(first) : `${assignmentTitle(first)} + ${rows.length - 1} weitere`;
    elements.kgTomorrowMeta.textContent = `${first.from || "07:00"} Uhr${first.city ? ` · ${first.city}` : ""}`;
    elements.kgTomorrowNavigation.href = mapsUrl(first);
    elements.kgTomorrowNavigation.classList.toggle("kg-hidden", mapsUrl(first) === "#");
  }

  function reviewKey(kind) {
    return `${state.bootstrap?.today || todayISO()}:${employeeId(state.employee)}:${kind}`;
  }

  function reviewValue(kind) {
    return state.localReview[reviewKey(kind)] ?? JSON.parse(localStorage.getItem(`kg-review:${reviewKey(kind)}`) || "null");
  }

  function saveReview(kind, value) {
    state.localReview[reviewKey(kind)] = value;
    localStorage.setItem(`kg-review:${reviewKey(kind)}`, JSON.stringify(value));
    renderReview();
  }

  function renderReview() {
    const photo = reviewValue("photo");
    const material = reviewValue("material");
    const order = reviewValue("order");

    elements.kgReviewPhotos.textContent = photo?.summary || "Noch nicht geprüft";
    elements.kgReviewMaterial.textContent = material?.summary || "Noch nicht geprüft";
    elements.kgReviewOrder.textContent = order?.summary || "Noch nicht beantwortet";

    setReviewStatus(elements.kgPhotoReviewStatus, Boolean(photo));
    setReviewStatus(elements.kgMaterialReviewStatus, Boolean(material));
    setReviewStatus(elements.kgOrderReviewStatus, Boolean(order));
  }

  function setReviewStatus(element, done) {
    element.textContent = done ? "✓" : "!";
    element.className = `kg-review-status ${done ? "kg-done" : "kg-open"}`;
  }

  function renderMaterialResponses() {
    const rows = state.materialResponses || [];
    elements.kgMaterialResponseCard.classList.toggle("kg-hidden", !rows.length);
    if (!rows.length) return;

    elements.kgMaterialResponseCount.textContent = `${rows.length} beantwortet`;
    elements.kgMaterialResponseList.innerHTML = rows.map(row => {
      const status = row.status === "stocked" ? "📦 Lagernd" : "✅ Bestellt";
      return `<article class="kg-material-response-item">
        <div class="kg-material-response-head">
          <strong>${esc(row.materialText || "Material")}</strong>
          <span>${esc(status)}</span>
        </div>
        ${row.jobName ? `<small>Baustelle: ${esc(row.jobName)}</small>` : ""}
        ${row.availableAt ? `<div><b>Verfügbar:</b> ${esc(row.availableAt)}</div>` : ""}
        ${row.responseNote ? `<div><b>Info:</b> ${esc(row.responseNote)}</div>` : ""}
        <button class="kg-material-read-button" type="button" data-material-read="${esc(row.id)}">Gelesen</button>
      </article>`;
    }).join("");

    elements.kgMaterialResponseList.querySelectorAll("[data-material-read]").forEach(button => {
      button.onclick = async () => {
        await api(`/kristine/api/material-responses/${encodeURIComponent(button.dataset.materialRead)}/read`, {
          method:"POST",
          body:JSON.stringify({}),
        });
        state.materialResponses = state.materialResponses.filter(row => row.id !== button.dataset.materialRead);
        renderMaterialResponses();
        toast("Materialantwort als gelesen markiert.");
      };
    });
  }

  function render() {
    if (!state.employee) return;
    elements.kgGreeting.textContent = `${greeting()}, ${employeeName(state.employee)}.`;
    elements.kgEmployeeName.textContent = employeeName(state.employee);
    renderSite();
    renderContext();
    renderSchedule();
    renderActions();
    renderTomorrow();
    renderReview();
    renderMaterialResponses();
    restartTimer();
  }

  function restartTimer() {
    clearInterval(state.timerHandle);
    if (state.employeeState?.mode === "working") {
      state.timerHandle = setInterval(renderTime, 30_000);
    }
  }

  async function sendMessage(text) {
    const id = employeeId(state.employee);
    if (!id) throw new Error("Kein Mitarbeiter ausgewählt.");
    const result = await api("/kristine/api/message", {
      method:"POST",
      body:JSON.stringify({
        employeeId:id,
        employeeName:employeeName(state.employee),
        text,
        date:state.bootstrap?.today || todayISO(),
      }),
    });
    if (result.state) {
      state.employeeState = result.state;
      state.bootstrap.states = state.bootstrap.states || {};
      state.bootstrap.states[id] = result.state;
    }
    await reload(false);
    toast(result.reply || "Gespeichert.");
    return result;
  }

  function toast(message) {
    elements.kgToast.textContent = String(message || "Gespeichert.");
    elements.kgToast.classList.add("is-visible");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => elements.kgToast.classList.remove("is-visible"), 2600);
  }

  function assistantDefinitions(kind) {
    const a = state.currentAssignment;
    return {
      photo: {
        title:"Foto",
        steps:[
          {question:"Was zeigt das Foto?", type:"options", options:["Vorher","Fortschritt","Nachher","Problem / Schaden"]},
          {question:"Möchtest du etwas ergänzen?", type:"text", placeholder:"Optional beschreiben oder später per Sprache erfassen …"},
          {question:"Fotoeintrag prüfen", type:"summary"},
        ],
        save(values) {
          saveReview("photo", {summary:`${values[0] || "Foto"} dokumentiert`});
          toast("Fotoeintrag vorgemerkt. Kamera-Anbindung folgt als nächster Bug.");
        },
      },
      material: {
        title:"Material",
        steps:[
          {question:"Was möchtest du machen?", type:"options", options:["Verbrauch dokumentieren","Material fehlt","Neues Material melden"]},
          {question:"Was und wie viel?", type:"text", placeholder:"z. B. 5 Liter Rolling Fog 154"},
          {question:"Wann wird es benötigt?", type:"options", options:["Heute dringend","Für morgen","Nur dokumentieren"]},
          {question:"Materialeintrag prüfen", type:"summary"},
        ],
        async save(values) {
          const requestType = String(values[0] || "").startsWith("Verbrauch")
            ? "consumption"
            : String(values[0] || "").startsWith("Neues")
              ? "new_material"
              : "missing";
          const need = String(values[2] || "").startsWith("Heute")
            ? "urgent_today"
            : String(values[2] || "").startsWith("Für morgen")
              ? "tomorrow"
              : "document";
          const a = state.currentAssignment;
          const result = await api("/kristine/api/material-requests", {
            method:"POST",
            body:JSON.stringify({
              employeeId:employeeId(state.employee),
              employeeName:employeeName(state.employee),
              jobId:a?.jobId || "",
              jobName:a?.jobName || "",
              materialText:String(values[1] || "").trim(),
              requestType,
              need,
            }),
          });
          const summary = `${values[1] || "Material"} · ${values[2] || "dokumentiert"}`;
          saveReview("material", {summary});
          saveReview("order", {summary: need === "urgent_today" ? "Heute dringend gemeldet" : need === "tomorrow" ? "Für morgen gemeldet" : "Nur dokumentiert"});
          if (need === "urgent_today") {
            toast(result.notification?.sent ? "Aufgabe erstellt – WhatsApp sofort gesendet." : "Aufgabe erstellt – WhatsApp konnte nicht gesendet werden.");
          } else if (need === "tomorrow") {
            toast(result.notification?.sent ? "Nachmeldung gespeichert und sofort gemeldet." : "Für die 15-Uhr-Meldung gespeichert.");
          } else {
            toast("Material dokumentiert.");
          }
        },
      },
      regie: {
        title:"Regie",
        external: `/public/regie-assistant.html?employeeId=${encodeURIComponent(employeeId(state.employee))}&jobId=${encodeURIComponent(a?.jobId || "")}&date=${encodeURIComponent(state.bootstrap?.today || todayISO())}`,
      },
      order: {
        title:"Material",
        steps:[
          {question:"Was und wie viel wird benötigt?", type:"text", placeholder:"z. B. 5 Liter Rolling Fog 154"},
          {question:"Wann wird es benötigt?", type:"options", options:["Heute dringend","Für morgen"]},
          {question:"Materialanforderung prüfen", type:"summary"},
        ],
        async save(values) {
          const a = state.currentAssignment;
          const need = String(values[1] || "").startsWith("Heute") ? "urgent_today" : "tomorrow";
          const result = await api("/kristine/api/material-requests", {
            method:"POST",
            body:JSON.stringify({
              employeeId:employeeId(state.employee),
              employeeName:employeeName(state.employee),
              jobId:a?.jobId || "",
              jobName:a?.jobName || "",
              materialText:String(values[0] || "").trim(),
              requestType:"missing",
              need,
            }),
          });
          saveReview("order", {summary: need === "urgent_today" ? "Heute dringend gemeldet" : "Für morgen gemeldet"});
          toast(need === "urgent_today"
            ? (result.notification?.sent ? "WhatsApp sofort gesendet." : "Aufgabe gespeichert; WhatsApp nicht gesendet.")
            : (result.notification?.sent ? "Nachmeldung sofort gesendet." : "Für 15 Uhr gespeichert."));
        },
      },
      finish: {
        title:"Tagesabschluss",
        steps:[
          {question:"Ist dein heutiger Tag vollständig?", type:"summary"},
          {question:"Tag verbindlich bestätigen?", type:"options", options:["Ja, Tag bestätigen","Noch nicht"]},
        ],
        save(values) {
          if (String(values[1] || "").startsWith("Ja")) {
            sendMessage("Feierabend").catch(showError);
          } else {
            toast("Tagesabschluss bleibt offen.");
          }
        },
      },
      time: {
        title:"Arbeitszeit",
        steps:[
          {question:"Deine Arbeitszeit heute", type:"summary"},
        ],
        save() { toast("Arbeitszeit geprüft."); },
      },
    }[kind];
  }

  function openAssistant(kind) {
    const def = assistantDefinitions(kind);
    if (!def) return;
    if (def.external) {
      location.href = def.external;
      return;
    }
    state.assistant = {kind, def, index:0, values:[]};
    renderAssistant();
    elements.kgAssistantDialog.showModal();
  }

  function renderAssistant() {
    const flow = state.assistant;
    if (!flow) return;
    const step = flow.def.steps[flow.index];
    elements.kgAssistantTitle.textContent = flow.def.title;
    elements.kgAssistantQuestion.textContent = step.question;
    elements.kgAssistantSecondary.textContent = flow.index === 0 ? "Abbrechen" : "Zurück";
    elements.kgAssistantPrimary.textContent = flow.index === flow.def.steps.length - 1 ? "Speichern" : "Weiter";

    if (step.type === "options") {
      elements.kgAssistantBody.innerHTML = `<div class="kg-assistant-options">${step.options.map(option =>
        `<button class="kg-assistant-option ${flow.values[flow.index] === option ? "is-selected" : ""}" type="button" data-option="${esc(option)}">${esc(option)}</button>`
      ).join("")}</div>`;
      elements.kgAssistantBody.querySelectorAll("[data-option]").forEach(button => {
        button.onclick = () => {
          flow.values[flow.index] = button.dataset.option;
          renderAssistant();
        };
      });
    } else if (step.type === "text") {
      elements.kgAssistantBody.innerHTML = `<textarea class="kg-assistant-textarea" placeholder="${esc(step.placeholder || "")}">${esc(flow.values[flow.index] || "")}</textarea>`;
      elements.kgAssistantBody.querySelector("textarea").addEventListener("input", event => {
        flow.values[flow.index] = event.target.value;
      });
    } else {
      const rows = flow.kind === "finish"
        ? [
            ["Arbeitszeit", elements.kgReviewTime.textContent],
            ["Fotos", elements.kgReviewPhotos.textContent],
            ["Material", elements.kgReviewMaterial.textContent],
            ["Regie", "direkt bearbeitbar"],
            ["Material morgen", elements.kgReviewOrder.textContent],
          ]
        : flow.kind === "time"
          ? [["Status", elements.kgReviewTime.textContent]]
          : flow.values.slice(0, flow.index).map((value, index) => [`Schritt ${index + 1}`, value || "–"]);
      elements.kgAssistantBody.innerHTML = `<div class="kg-assistant-summary">${rows.map(([label,value]) =>
        `<div><strong>${esc(label)}:</strong> ${esc(value)}</div>`
      ).join("")}</div>`;
    }
  }

  function assistantBack() {
    const flow = state.assistant;
    if (!flow || flow.index === 0) {
      elements.kgAssistantDialog.close();
      return;
    }
    flow.index -= 1;
    renderAssistant();
  }

  function assistantNext() {
    const flow = state.assistant;
    if (!flow) return;
    const step = flow.def.steps[flow.index];
    if (step.type === "options" && !flow.values[flow.index]) {
      toast("Bitte eine Auswahl treffen.");
      return;
    }
    if (flow.index < flow.def.steps.length - 1) {
      flow.index += 1;
      renderAssistant();
      return;
    }
    elements.kgAssistantDialog.close();
    Promise.resolve(flow.def.save(flow.values)).catch(showError);
    state.assistant = null;
  }

  function showError(error) {
    console.error(error);
    elements.kgErrorText.textContent = String(error?.message || error || "Unbekannter Fehler");
    elements.kgError.classList.remove("kg-hidden");
    elements.kgLoading.classList.add("kg-hidden");
  }

  async function reload(showLoading = true) {
    if (showLoading) {
      elements.kgLoading.classList.remove("kg-hidden");
      elements.kgContent.classList.add("kg-hidden");
      elements.kgError.classList.add("kg-hidden");
    }
    try {
      const bootstrap = await api("/kristine/api/bootstrap");
      state.bootstrap = bootstrap;
      const wanted = getQueryEmployeeId();
      state.employee = employees().find(emp => employeeId(emp) === wanted) || employees()[0] || null;
      renderEmployeeChooser();

      if (!state.employee) {
        throw new Error("Keine aktiven Mitarbeiter in der Datenbank gefunden.");
      }
      deriveEmployeeData();
      const materialResponseResult = await api(`/kristine/api/material-responses/${encodeURIComponent(employeeId(state.employee))}`);
      state.materialResponses = materialResponseResult.responses || [];
      render();
      elements.kgLoading.classList.add("kg-hidden");
      elements.kgError.classList.add("kg-hidden");
      elements.kgContent.classList.remove("kg-hidden");
    } catch (error) {
      showError(error);
    }
  }

  function bindEvents() {
    elements.kgEmployeeButton.onclick = () => elements.kgEmployeeDialog.showModal();
    elements.kgStartButton.onclick = () => sendMessage("Start").catch(showError);
    elements.kgWrongSiteButton.onclick = async () => {
  try {
    const result = await sendMessage("Andere Baustelle");

    const reply = result.reply || "Welche Baustelle ist richtig?";
    const buttons = Array.isArray(result.buttons) ? result.buttons : [];

    state.assistant = {
      kind: "site-switch",
      def: {
        title: "Baustelle auswählen",

        steps: [
          buttons.length
            ? {
                question: reply,
                type: "options",
                options: buttons
              }
            : {
                question: reply,
                type: "text",
                placeholder: "Name oder Baustellennummer"
              }
        ],

      async save(values) {
  const answer = String(values[0] || "").trim();
  if (!answer) return;

  const response = await sendMessage(answer);
  const reply = response.reply || "";
  const buttons = Array.isArray(response.buttons)
    ? response.buttons
    : [];

  // KRISTINE hat mehrere passende Baustellen gefunden:
  // Auswahl wieder groß im Dialog anzeigen.
  if (buttons.length) {
    state.assistant = {
      kind: "site-switch-choice",
      def: {
        title: "Baustelle auswählen",

        steps: [{
          question: reply || "Welche Baustelle ist richtig?",
          type: "options",
          options: buttons
        }],

        async save(choiceValues) {
          const choice = String(choiceValues[0] || "").trim();
          if (!choice) return;

          const finalResponse = await sendMessage(choice);

          if (finalResponse.reply) {
            toast(finalResponse.reply);
          }

          setTimeout(() => location.reload(), 500);
        }
      },

      index: 0,
      values: []
    };

    renderAssistant();
    elements.kgAssistantDialog.showModal();
    return;
  }

  // Keine Auswahl nötig – Baustelle wurde direkt erkannt.
 if (reply) {
  state.assistant = {
    kind: "site-switch-search",
    def: {
      title: "Baustelle suchen",
      steps: [{
        question: reply,
        type: "text",
        placeholder: "Name oder Baustellennummer"
      }],
      save: async (values) => {
        const answer = String(values[0] || "").trim();
        if (!answer) return;

        const response = await sendMessage(answer);

        if (response.reply) {
          toast(response.reply);
        }

        setTimeout(() => location.reload(), 500);
      }
    },
    index: 0,
    values: []
  };

  renderAssistant();
  elements.kgAssistantDialog.showModal();
}
}  
      },

      index: 0,
      values: []
    };

    renderAssistant();
    elements.kgAssistantDialog.showModal();

  } catch (error) {
    showError(error);
  }
};

    elements.kgPauseButton.onclick = () => {
      const mode = state.employeeState?.mode;
      sendMessage(["pause","lunch"].includes(mode) ? "Weiter" : "Pause").catch(showError);
    };
    elements.kgLunchButton.onclick = () => sendMessage("Mittag").catch(showError);
    elements.kgSwitchButton.onclick = () => sendMessage("Baustelle wechseln").catch(showError);
    elements.kgFinishButton.onclick = () => openAssistant("finish");

    qsa("[data-action]").forEach(button => {
      button.addEventListener("click", () => openAssistant(button.dataset.action));
    });
    qsa("[data-review]").forEach(button => {
      button.addEventListener("click", () => openAssistant(button.dataset.review));
    });

    elements.kgAssistantSecondary.onclick = assistantBack;
    elements.kgAssistantPrimary.onclick = assistantNext;
  }

  async function init() {
    cacheElements();
    bindEvents();
    await reload(true);
  }

  document.addEventListener("DOMContentLoaded", init);

  return { reload, openAssistant };
})();
