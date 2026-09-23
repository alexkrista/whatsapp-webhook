"use strict";
(() => {
  const host = document.getElementById("logbook");
  if (!host) return;
  const token = new URLSearchParams(location.search).get("token") || "";
  const endpoint = "/kristine/api/krisdrive/logbook";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const format = (value, digits = 1) => value == null ? "–" : Number(value).toLocaleString("de-AT", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const date = value => new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
  const time = value => new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const label = category => ({ business: "Geschäftlich", private: "Privat", unassigned: "Fahrtart offen" })[category] || "Offen";
  let vehicle = null, data = null, activeRow = null, generation = 0, controller = null;
  host.innerHTML = `
    <div class="lb-head"><div><div class="eyebrow">KRISDRIVE · Fahrtenbuch</div><h2 id="lb-title" tabindex="-1">Fahrtenbuch</h2><div id="lb-vehicle" class="lb-sub"></div></div><button class="lb-close" id="lb-close" aria-label="Fahrtenbuch schließen">×</button></div>
    <form id="lb-filters" class="lb-controls">
      <label>Von<input id="lb-from" type="date" required></label><label>Bis<input id="lb-to" type="date" required></label>
      <button type="button" class="btn secondary" id="lb-today">Heute</button><button type="button" class="btn secondary" id="lb-month">Dieser Monat</button>
      <button type="submit" class="btn" id="lb-load">Fahrten abrufen</button>
      <div class="lb-export"><button type="button" class="btn secondary" id="lb-pdf" disabled>PDF</button><button type="button" class="btn secondary" id="lb-csv" disabled>CSV / Excel</button></div>
    </form>
    <div id="lb-warning" class="lb-warning" role="status" hidden></div><div id="lb-error" class="lb-error" role="alert" hidden></div>
    <div id="lb-totals" class="lb-totals"></div>
    <div class="lb-columns"><span>Datum / Zeit</span><span>Strecke</span><span>Zuordnung / Zweck</span><span>Kilometer</span><span></span></div>
    <div id="lb-rows" aria-live="polite"></div><div id="lb-stamp" class="lb-stamp"></div>
    <dialog id="lb-dialog" class="lb-dialog" aria-labelledby="lb-edit-title">
      <form id="lb-edit-form"><h3 id="lb-edit-title">Fahrt ergänzen</h3><div id="lb-edit-sub" class="lb-sub"></div>
        <div id="lb-edit-error" class="lb-error" role="alert" hidden></div>
        <div class="lb-fields"><label>Fahrer<select id="lb-driver"></select></label><label>Fahrtart<select id="lb-category"><option value="unassigned">Noch offen</option><option value="business">Geschäftlich</option><option value="private">Privat</option></select></label>
          <label data-business>Start<input id="lb-start" maxlength="500" autocomplete="off" placeholder="Straße, Ort"></label><label data-business>Ziel<input id="lb-end" maxlength="500" autocomplete="off" placeholder="Straße, Ort"></label>
          <label class="full" data-business>Zweck / Kunde / Baustelle<textarea id="lb-purpose" rows="2" maxlength="1000" placeholder="z. B. Baustellenbesprechung · Kunde / Baustelle"></textarea></label>
        </div><div id="lb-private-hint" class="lb-hint" hidden>Privatfahrten werden ohne Ziel- und Zweckangaben angezeigt und exportiert.</div>
        <details id="lb-km-details"><summary>Kilometerstände prüfen / korrigieren</summary><div class="lb-fields"><label>km-Stand Beginn<input id="lb-km-start" type="number" min="0" max="10000000" step="0.001"></label><label>km-Stand Ende<input id="lb-km-end" type="number" min="0" max="10000000" step="0.001"></label></div><div class="lb-hint" id="lb-km-hint"></div></details>
        <div id="lb-history" class="lb-hint"></div><footer><button class="btn secondary" id="lb-cancel" type="button">Abbrechen</button><button class="btn" id="lb-save" type="submit">Speichern</button></footer>
      </form>
    </dialog>`;
  const $ = id => document.getElementById("lb-" + id);
  function url(path, query = {}) {
    const params = new URLSearchParams(query);
    if (token) params.set("token", token);
    return path + (params.size ? "?" + params.toString() : "");
  }
  async function jsonRequest(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...options });
    let result;
    try { result = await response.json(); } catch { throw Error("Der Server hat keine lesbare Antwort geliefert."); }
    if (!response.ok || result.ok === false) throw Error(result.error || `Abruf fehlgeschlagen (${response.status}).`);
    return result;
  }
  function error(message, id = "error") { $(id).textContent = message; $(id).hidden = !message; }
  function exportsEnabled(enabled) { $("pdf").disabled = !enabled; $("csv").disabled = !enabled; }
  function render() {
    const sum = data.totals;
    $("totals").innerHTML = [[format(sum.km) + " km", `${sum.count} ${sum.count === 1 ? "Fahrt" : "Fahrten"} insgesamt`], [format(sum.businessKm) + " km", "Geschäftlich"], [format(sum.privateKm) + " km", "Privat"], [String(sum.open), `${sum.open === 1 ? "Fahrt" : "Fahrten"} zu ergänzen`]].map(([n, title], i) => `<div class="lb-total ${i === 3 && sum.open ? "lb-open-count" : ""}"><strong>${esc(n)}</strong><span>${esc(title)}</span></div>`).join("");
    $("warning").textContent = data.warning || ""; $("warning").hidden = !data.warning;
    $("rows").innerHTML = data.rows.length ? data.rows.map(row => `
      <article class="lb-row">
        <div class="lb-date"><strong>${esc(date(row.startedAt))}</strong><small>${esc(time(row.startedAt))} – ${esc(date(row.startedAt) !== date(row.closedAt) ? date(row.closedAt) + " " : "")}${esc(time(row.closedAt))}</small></div>
        <div class="lb-route">${row.category === "private" ? '<span class="lb-private">Privatfahrt</span>' : `<div>${esc(row.startLocation || "Start noch offen")}${row.inferredStart ? ' <small>(aus vorheriger Fahrt)</small>' : ""}</div><div>→ ${esc(row.endLocation || "Ziel noch offen")}${row.inferredEnd ? ' <small>(aus nächster Fahrt)</small>' : ""}</div>`}</div>
        <div class="lb-assignment"><strong>${esc(row.driver?.employeeName || "Fahrer offen")}</strong><span class="lb-badge ${esc(row.category)}">${esc(label(row.category))}</span>${row.purpose ? `<small class="lb-purpose">${esc(row.purpose)}</small>` : ""}${row.missing.length ? `<small class="lb-missing">Offen: ${esc(row.missing.join(", "))}</small>` : ""}</div>
        <div class="lb-km"><strong>${esc(format(row.distanceKm))}</strong><small>km${row.odometerCorrected ? " · korrigiert" : ""}</small></div>
        <button type="button" class="btn secondary lb-edit" data-edit="${esc(row.id)}" aria-label="Fahrt am ${esc(date(row.startedAt))} um ${esc(time(row.startedAt))} bearbeiten">${row.missing.length ? "Ergänzen" : "Bearbeiten"}</button>
      </article>`).join("") : '<div class="lb-empty">Keine gespeicherten Fahrten in diesem Zeitraum.<br>Wähle einen anderen Zeitraum oder rufe die Fahrten erneut ab.</div>';
    $("stamp").textContent = `${data.range.from} bis ${data.range.to} · ${data.lastSync ? "Letzter GPS-Abruf " + date(data.lastSync) + " " + time(data.lastSync) : "Noch kein erfolgreicher GPS-Abruf"}${sum.unassignedKm ? " · " + format(sum.unassignedKm) + " km noch nicht zugeordnet" : ""}${sum.missingKm ? " · " + sum.missingKm + " Fahrt(en) ohne Kilometerangabe" : ""}`;
  }
  async function load(force = false) {
    if (!vehicle) return;
    const current = ++generation;
    controller?.abort(); controller = new AbortController();
    const query = { vehicleId: vehicle.id, from: $("from").value, to: $("to").value };
    if (force) query.refresh = "1";
    error(""); exportsEnabled(false); $("load").disabled = true;
    $("rows").textContent = "Fahrten werden geladen …"; $("totals").innerHTML = ""; $("stamp").textContent = ""; $("warning").hidden = true;
    try {
      const result = await jsonRequest(url(endpoint, query), { signal: controller.signal });
      if (current !== generation) return;
      data = result; render(); exportsEnabled(true);
    } catch (e) {
      if (current !== generation || e.name === "AbortError") return;
      data = null; $("rows").innerHTML = ""; error(e.message);
    } finally { if (current === generation) $("load").disabled = false; }
  }
  function togglePrivate() {
    const isPrivate = $("category").value === "private";
    host.querySelectorAll("[data-business]").forEach(node => node.hidden = isPrivate);
    $("private-hint").hidden = !isPrivate;
  }
  function edit(id) {
    activeRow = data?.rows.find(row => row.id === id);
    if (!activeRow) return;
    const row = activeRow;
    $("edit-sub").textContent = `${date(row.startedAt)} · ${time(row.startedAt)} – ${time(row.closedAt)} · ${format(row.distanceKm)} km`;
    const people = [...data.employees];
    if (row.driver?.employeeId && !people.some(person => person.id === row.driver.employeeId)) people.push({ id: row.driver.employeeId, name: row.driver.employeeName });
    $("driver").innerHTML = '<option value="">Noch nicht zugeordnet</option>' + people.map(person => `<option value="${esc(person.id)}">${esc(person.name)}</option>`).join("");
    $("driver").value = row.driver?.employeeId || ""; $("category").value = row.category;
    $("start").value = row.startLocation || ""; $("end").value = row.endLocation || ""; $("purpose").value = row.purpose || "";
    $("km-start").value = row.odometerCorrected ? row.odometerStartKm : ""; $("km-end").value = row.odometerCorrected ? row.odometerEndKm : "";
    $("km-start").placeholder = format(row.odometerStartKm, 2); $("km-end").placeholder = format(row.odometerEndKm, 2);
    $("km-details").open = row.odometerStartKm == null || row.odometerEndKm == null;
    $("km-hint").textContent = `Übernommen: ${format(row.odometerStartKm, 2)} → ${format(row.odometerEndKm, 2)} km. Mit dem Fahrzeugtacho abgleichen. Nur bei Abweichung beide Felder ausfüllen; leer lassen übernimmt die GPS-Werte.`;
    $("history").textContent = row.updatedAt ? `Zuletzt geändert: ${date(row.updatedAt)} ${time(row.updatedAt)} · ${row.changedBy}. Änderungen werden protokolliert.` : "Ergänzungen und Korrekturen werden mit Zeitpunkt protokolliert.";
    error("", "edit-error"); togglePrivate(); $("dialog").showModal();
  }
  $("edit-form").addEventListener("submit", async event => {
    event.preventDefault();
    const row = activeRow;
    if (!row) return;
    const body = { revision: row.revision, employeeId: $("driver").value, category: $("category").value, odometerStartKm: $("km-start").value, odometerEndKm: $("km-end").value };
    for (const [key, input] of [["startLocation", "start"], ["endLocation", "end"], ["purpose", "purpose"]]) {
      // A private row is redacted by the server. Leaving a redacted field blank
      // when switching back restores the stored original instead of erasing it.
      if ($(input).value !== (row[key] || "") && (row.category !== "private" || $(input).value)) body[key] = $(input).value;
    }
    $("save").disabled = true; $("cancel").disabled = true; error("", "edit-error");
    try {
      await jsonRequest(url(`${endpoint}/${encodeURIComponent(vehicle.id)}/${encodeURIComponent(row.id)}`), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      $("dialog").close(); await load();
    } catch (e) { error(e.message, "edit-error"); }
    finally { $("save").disabled = false; $("cancel").disabled = false; }
  });
  async function download(formatName) {
    if (!data) return;
    const snapshot = data;
    exportsEnabled(false); error("");
    try {
      const response = await fetch(url(`${endpoint}/export.${formatName}`, { vehicleId: snapshot.vehicle.id, ...snapshot.range }), { credentials: "same-origin" });
      if (!response.ok) { const problem = await response.json().catch(() => ({})); throw Error(problem.error || "Export fehlgeschlagen."); }
      const blob = await response.blob(), link = document.createElement("a"), objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl; link.download = `Fahrtenbuch-${snapshot.vehicle.plate || snapshot.vehicle.id}-${snapshot.range.from}.${formatName}`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    } catch (e) { error(e.message); }
    finally { exportsEnabled(Boolean(data)); }
  }
  $("rows").addEventListener("click", event => { const button = event.target.closest("[data-edit]"); if (button) edit(button.dataset.edit); });
  $("category").addEventListener("change", togglePrivate);
  $("cancel").addEventListener("click", () => $("dialog").close());
  $("dialog").addEventListener("cancel", event => { if ($("save").disabled) event.preventDefault(); });
  $("filters").addEventListener("submit", event => { event.preventDefault(); load(true); });
  $("today").addEventListener("click", () => { $("from").value = $("to").value = today(); load(); });
  $("month").addEventListener("click", () => { $("to").value = today(); $("from").value = today().slice(0, 8) + "01"; load(); });
  $("pdf").addEventListener("click", () => download("pdf")); $("csv").addEventListener("click", () => download("csv"));
  $("close").addEventListener("click", () => { generation++; controller?.abort(); host.hidden = true; data = null; });
  window.addEventListener("krisdrive:logbook", event => {
    vehicle = event.detail; if (!vehicle?.id) return;
    host.hidden = false; $("title").textContent = `Fahrtenbuch · ${vehicle.label || "Fahrzeug"}`; $("vehicle").textContent = vehicle.plate || "";
    if (!$("from").value) { $("to").value = today(); $("from").value = today().slice(0, 8) + "01"; }
    host.scrollIntoView({ behavior: "smooth", block: "start" }); $("title").focus({ preventScroll: true }); load();
  });
})();
