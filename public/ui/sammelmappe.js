"use strict";
(function () {
  const D = window.BaustellenData, B = window.KristaRegieBilling, I = window.SammelmappeInsights;
  const token = new URLSearchParams(location.search).get("token") || "";
  const id = decodeURIComponent(location.hash.slice(1));
  let jobs = [], collection = null, data = null, serial = 0, mediaLoaded = false;
  let allReports = [], previewIndex = -1, bookings = [], bookingFailures = 0, bookingsReady = false;
  let savedView = null, savedAt = "", usingSaved = false, dataGeneration = 0, startedAt = "", lastSavedSignature = "", savingSnapshot = false;
  let memberCandidates = [];
  const esc = value => String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hours = value => new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(D.num(value)) + " h";
  const money = value => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(D.num(value));
  const quantity = value => value === null || value === undefined || value === "" ? "–" : Number.isFinite(Number(value)) ? new Intl.NumberFormat("de-AT", { maximumFractionDigits: 3 }).format(Number(value)) : String(value);
  const month = value => new Intl.DateTimeFormat("de-AT", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value + "-01T12:00:00Z"));
  const date = value => /^\d{4}-\d{2}-\d{2}/.test(String(value || "")) ? String(value).slice(0, 10).split("-").reverse().join(".") : "–";
  const el = id => document.getElementById(id);
  const text = (id, value) => { el(id).textContent = value; };
  function url(path) { try { const value = new URL(path, location.origin); if (value.origin !== location.origin || !["http:", "https:"].includes(value.protocol)) return ""; if (token) value.searchParams.set("token", token); return value.pathname + value.search + value.hash; } catch { return ""; } }
  const projectUrl = jobId => url("/kristine/baustellen#" + encodeURIComponent(jobId));
  const projectLink = jobId => `<a href="${esc(projectUrl(jobId))}">${esc(jobId)}</a>`;
  async function api(path, options = {}) { const response = await fetch(url(path), { signal: AbortSignal.timeout(20000), ...options }), result = await response.json(); if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`); return result; }
  function notice(message, warning = false) { text("collectionStatus", message); el("collectionStatus").classList.toggle("warning", warning); }
  const reports = row => B.dedupeReports(row.documents.filter(doc => doc.type === "regie_report"));
  function rowBilling(row) { return D.combineBilling(row.billingSources.filter(source => source.data).map(source => ({ ...source, billing: source.data.billing }))); }
  function documentLink(doc) { const href = doc.url ? url(doc.url) : ""; return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(doc.reportNumber || doc.name || "Dokument")}</a>` : `${esc(doc.reportNumber || doc.name || "Bericht")} · ${projectLink(doc.jobId)}`; }
  const reportButton = (report, index) => `<button type="button" class="report-button" data-report-preview="${index}" aria-label="Regiebericht ${esc(report.reportNumber || report.name || "Bericht")} aus Akte ${esc(report.jobId)} öffnen">${esc(report.reportNumber || report.name || "Bericht")}<small>Schnellansicht ↗</small></button>`;

  function openReport(index) {
    if (!Number.isInteger(index) || !allReports[index]) return;
    previewIndex = index;
    const report = allReports[index], staff = Array.isArray(report.employeeDetails) ? report.employeeDetails : [], materials = I.reportMaterials([report]);
    const original = report.url || report.pdfUrl ? url(report.url || report.pdfUrl) : "";
    text("reportPreviewTitle", report.reportNumber || report.name || "Regiebericht");
    el("reportPreviewReference").innerHTML = `Akte ${projectLink(report.jobId)} · ${date(report.reportDate)} · ${esc(report.source === "WW" ? "WinWorker" : report.source || "Gespeicherter Bericht")}`;
    const materialRows = materials.items.map(row => `<tr><td>${esc(row.name)}${row.note ? `<small>${esc(row.note)}</small>` : ""}</td><td class="num">${esc(quantity(row.quantity))} ${esc(row.unit)}</td><td class="num">${money(row.unitPrice)}</td><td class="num">${money(row.cost)}</td><td class="num">${row.purchaseCost === null ? "–" : money(row.purchaseCost)}</td></tr>`).join("");
    el("reportPreviewBody").innerHTML = `<div class="kpis"><div class="card"><span class="label">Stunden</span><strong>${hours(report.totalHours)}</strong></div><div class="card"><span class="label">Arbeit netto</span><strong>${money(report.laborCost)}</strong></div><div class="card"><span class="label">Material netto</span><strong>${money(materials.sales)}</strong></div><div class="card"><span class="label">Gesamt netto</span><strong>${money(B.reportAmount(report))}</strong></div></div>
      <h3>Ausgeführte Arbeiten</h3>${report.description ? `<div class="pre-wrap preview-context">${esc(report.description)}</div>` : '<p class="preview-empty">Keine Tätigkeitsbeschreibung im gespeicherten Bericht vorhanden.</p>'}
      ${report.note ? `<h3>Notiz</h3><div class="pre-wrap preview-context">${esc(report.note)}</div>` : ""}
      <h3>Mitarbeiter</h3>${staff.length ? `<div class="table-scroll"><table><thead><tr><th>Name</th><th>Von / bis</th><th class="num">Stunden</th><th class="num">Arbeit netto</th></tr></thead><tbody>${staff.map(person => `<tr><td>${esc(person.name)}</td><td>${esc([person.from, person.to].filter(Boolean).join(" – ") || "–")}</td><td class="num">${hours(person.hours)}</td><td class="num">${money(person.cost)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="preview-empty">${esc(report.employees || "Keine Mitarbeiterdetails im gespeicherten Bericht vorhanden.")}</p>`}
      <h3>Verwendetes Material</h3>${materialRows ? `<div class="table-scroll"><table><thead><tr><th>Material</th><th class="num">Menge</th><th class="num">VK / Einheit</th><th class="num">VK netto</th><th class="num">EK netto</th></tr></thead><tbody>${materialRows}</tbody></table></div>` : `<p class="preview-empty">${materials.sales > 0 ? "Materialbetrag vorhanden; einzelne Materialien sind im gespeicherten Bericht nicht angegeben." : "Keine Materialpositionen im gespeicherten Bericht vorhanden."}</p>`}
      ${numFlatNote(report)}${materials.missing.length ? '<p class="muted material-warning">Für einzelne Positionen fehlt ein eindeutiger Einkaufspreis oder eine Materialposition. „–“ bedeutet unbekannt.</p>' : ""}
      ${original && (report.url || report.pdfUrl) ? `<details class="pdf-preview"><summary>Original-PDF anzeigen</summary><p><a href="${esc(original)}" target="_blank" rel="noopener">Original in neuem Tab öffnen</a></p><iframe title="Original-Regiebericht" src="${esc(original)}" loading="lazy"></iframe></details>` : '<p class="muted">Kein Original-PDF hinterlegt. Die Schnellansicht zeigt die gespeicherten Berichtsdaten.</p>'}`;
    text("reportPreviewPosition", `${index + 1} / ${allReports.length}`);
    el("previousReport").disabled = index === 0; el("nextReport").disabled = index === allReports.length - 1;
    const dialog = el("reportPreview");
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
  }

  function numFlatNote(report) {
    return D.num(report.materialFlatPercent) > 0 ? `<p class="muted material-warning">Im Bericht ist eine Materialpauschale von ${esc(quantity(report.materialFlatPercent))} % hinterlegt. Die Pauschale benennt kein konkretes Material; ein zusätzlicher Betrag wird hier nicht geschätzt.</p>` : "";
  }

  function renderMaterial() {
    if (!data) return;
    const material = I.reportMaterials(allReports), others = I.additionalMaterials(data.rows, bookings);
    text("materialCount", `(${material.items.length + others.length} Positionen)`);
    const missingSources = data.rows.filter(row => row.errors.length).length;
    text("materialState", `Material bleibt in der jeweiligen Einzelakte gespeichert und wird hier gemeinsam angezeigt. ${missingSources ? `${missingSources} Akte(n) konnten nicht vollständig gelesen werden. ` : ""}${bookingsReady ? bookingFailures ? `${bookingFailures} Lager-/Mischmaterial-Abgleich(e) fehlen.` : "Lager- und Mischmaterial geladen." : "Lager- und Mischmaterial wird geladen …"}`);
    el("collectionMaterials").innerHTML = material.items.map(row => `<tr><td>${projectLink(row.jobId)}<br>${reportButton(allReports[row.reportIndex], row.reportIndex)}</td><td>${esc(row.name)}${row.note ? `<small>${esc(row.note)}</small>` : ""}</td><td class="num">${esc(quantity(row.quantity))} ${esc(row.unit)}</td><td class="num">${money(row.cost)}</td><td class="num">${row.purchaseCost === null ? "–" : money(row.purchaseCost)}</td></tr>`).join("") || '<tr><td colspan="5">Keine gespeicherten Material-Einzelpositionen in den Regieberichten.</td></tr>';
    el("collectionMaterialTotals").innerHTML = `<tr><th colspan="3">Material laut Regieberichten</th><th class="num">${money(material.sales)}</th><th class="num">${material.missing.length || material.flat.length ? "unvollständig" : money(material.purchase)}</th></tr>`;
    text("materialMissingNote", [material.missing.length ? `${material.missing.length} Position(en) ohne vollständige EK-/Materialangaben. Bekannter EK-Teilbetrag: ${money(material.purchase)}.` : "", material.flat.length ? `${material.flat.length} Bericht(e) enthalten eine Materialpauschale; Details stehen in der Schnellansicht.` : ""].filter(Boolean).join(" "));
    text("additionalMaterialCount", `(${others.length})`);
    el("additionalMaterials").innerHTML = others.map(row => `<tr><td>${projectLink(row.jobId)}</td><td>${date(row.date)}</td><td>${esc(row.name)}${row.note || row.use ? `<small>${esc([row.use, row.note].filter(Boolean).join(" · "))}</small>` : ""}</td><td class="num">${esc(quantity(row.quantity))} ${esc(row.unit)}</td><td>${esc(row.source)}</td></tr>`).join("") || '<tr><td colspan="5">Keine weiteren Materialeinträge geladen.</td></tr>';
  }

  function renderInsights(snapshot, ready) {
    if (!I || !window.BaustellenLiveHours.personDayHours) return;
    const people = usingSaved ? savedView.personDays : window.BaustellenLiveHours.personDayHours(id), chart = I.monthlyHours(people, snapshot.total, snapshot.target);
    text("hoursChartStart", chart.first ? `Start der erfassten Arbeit: ${date(chart.first)}` : "Noch keine datierten Stunden");
    text("hoursChartNote", !ready ? "Stunden werden geladen …" : !chart.consistent ? "Monatsdaten und Gesamtstunden sind noch nicht vollständig abgeglichen." : `${snapshot.complete ? "Aktuelle" : "Gespeicherte"} produktive Stunden nach WW-/KRISTINE-Abgleich. ${chart.unassigned > .02 ? `${hours(chart.unassigned)} haben noch keine Monatszuordnung und stehen separat in der Tabelle.` : "Die Monatsbalken ergeben die Ist-Gesamtsumme."}`);
    const width = Math.max(650, chart.months.length * 68 + 60), plotHeight = 180, base = 210, max = Math.max(1, ...chart.months.map(row => row.hours)), step = (width - 65) / Math.max(1, chart.months.length);
    const grid = [0, .5, 1].map(part => `<line class="grid" x1="48" x2="${width - 5}" y1="${base - part * plotHeight}" y2="${base - part * plotHeight}"/><text x="43" y="${base - part * plotHeight + 4}" text-anchor="end">${esc(quantity(max * part))}</text>`).join("");
    const bars = chart.months.map((row, index) => { const x = 53 + index * step, height = row.hours / max * plotHeight, label = `${month(row.month)}: ${hours(row.hours)} · bis dahin ${hours(row.cumulative)}${chart.unassigned <= .02 && chart.consistent ? ` · Soll minus Ist ${hours(row.balance)}` : ""}`; return `<rect class="bar${row.balance < 0 ? " over" : ""}" x="${x}" y="${base - height}" width="${Math.max(8, step - 17)}" height="${Math.max(1, height)}" rx="4" tabindex="0" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title></rect><text x="${x + (step - 17) / 2}" y="232" text-anchor="middle">${esc(month(row.month))}</text>`; }).join("");
    el("hoursChart").innerHTML = ready ? `<div class="chart-budget"><span>Sollbudget aktuell: <strong>${hours(chart.target)}</strong></span><span>Verbraucht: <strong>${hours(chart.total)}</strong></span><span>Saldo: <strong class="${chart.balance < 0 ? "negative" : ""}">${hours(chart.balance)}</strong></span></div>${chart.months.length ? `<svg style="--chart-width:${width}px" viewBox="0 0 ${width} 260" role="group" aria-label="Stundenverbrauch je Monat"><title>Monatlicher Stundenverbrauch</title><text x="8" y="16">h</text>${grid}${bars}</svg>` : '<p class="preview-empty">Sobald Stunden mit Datum vorliegen, erscheint hier der Monatsverlauf.</p>'}` : "";
    el("hoursMonths").innerHTML = chart.months.map(row => `<tr><td>${esc(month(row.month))}</td><td class="num">${hours(row.hours)}</td><td class="num">${hours(row.cumulative)}</td><td class="num">${chart.consistent && chart.unassigned <= .02 ? hours(row.balance) : "–"}</td></tr>`).join("") + (chart.unassigned > .02 ? `<tr><td>Ohne Monatszuordnung</td><td class="num">${hours(chart.unassigned)}</td><td class="num">${hours(chart.total)}</td><td class="num">${hours(chart.balance)}</td></tr>` : "");
    el("hoursMonthsTotal").innerHTML = `<tr><th>Gesamt</th><th class="num">${ready ? hours(chart.total) : "–"}</th><th></th><th class="num">${ready ? hours(chart.balance) : "–"}</th></tr>`;
    if (!data) return;
    const cost = usingSaved ? savedView.cost : window.BaustellenLiveHours.laborCost(id), material = I.reportMaterials(allReports), value = I.economy(data, snapshot, cost, material, ready);
    text("economyRevenueRate", value.revenuePerHour === null ? "–" : money(value.revenuePerHour) + " / h");
    text("economyRevenueFormula", `${money(value.revenue)} Rechnungen netto ÷ ${hours(value.actual)} produktive Iststunden`);
    text("economyLabor", cost.ratesAvailable && value.hoursCovered ? money(cost.total) : "–");
    text("economyMaterial", material.missing.length || material.flat.length ? "–" : money(value.materialEk));
    text("economyMaterialNote", `Fixer Auftrag: ${money(value.fixedMaterial)} EK angesetzt (60 % des kalkulierten Materialanteils). Regie: ${money(material.purchase)} EK bekannt.`);
    text("economyProfitRate", value.profitPerHour === null ? "–" : money(value.profitPerHour) + " / h");
    text("economyProfitFormula", value.profit === null ? "Ertrag erst bei vollständiger Stunden- und Kostenzuordnung" : `${money(value.profit)} Ertrag ÷ ${hours(value.actual)}`);
    text("economyState", !value.full ? "Abgleich ausstehend" : !value.costsComplete ? "Kostenzuordnung unvollständig" : value.estimated ? "Mit kalkulierten Kosten" : "Aktueller Stand");
    text("economyNote", ["Ausgestellte Rechnungen netto, einschließlich Gutschriften; je Rechnungsnummer die jüngste Fassung. Entwürfe zählen nicht zum Umsatz. Laufende Projekte zeigen einen Zwischenstand.", !cost.ratesAvailable ? "Mitarbeiter-Kostensätze fehlen." : "", value.unassignedHours > .02 ? `${hours(value.unassignedHours)} sind noch keinem Mitarbeiter zugeordnet.` : "", cost.rows.some(row => !row.matched) ? "Nicht zugeordnete Mitarbeiter verwenden wie im Einzelprojekt die Ø-Kostensätze." : "", material.missing.length || material.flat.length ? "Material-EK noch nicht vollständig bekannt." : ""].filter(Boolean).join(" "));
    el("economyPeople").innerHTML = cost.rows.map(row => `<tr><td>${esc(row.name)}${!row.matched ? "<small>Ø-Kostensätze</small>" : ""}</td><td class="num">${hours(row.hours)}</td><td class="num">${cost.ratesAvailable ? money(row.wageRate) : "–"}</td><td class="num">${cost.ratesAvailable ? money(row.wageCost) : "–"}</td><td class="num">${cost.ratesAvailable ? money(row.gkRate) : "–"}</td><td class="num">${cost.ratesAvailable ? money(row.gkCost) : "–"}</td><td class="num">${cost.ratesAvailable ? money(row.totalCost) : "–"}</td></tr>`).join("") || '<tr><td colspan="7">Noch keine Mitarbeiterstunden zugeordnet.</td></tr>';
    el("economyTotals").innerHTML = `<tr><th>Summe Mitarbeiter</th><th class="num">${hours(cost.totalHours)}</th><th></th><th class="num">${cost.ratesAvailable ? money(cost.wageTotal) : "–"}</th><th></th><th class="num">${cost.ratesAvailable ? money(cost.gkTotal) : "–"}</th><th class="num">${cost.ratesAvailable ? money(cost.total) : "–"}</th></tr><tr><th colspan="6">Umsatz netto</th><th class="num">${value.full ? money(value.revenue) : "–"}</th></tr><tr><th colspan="6">Ertrag = Umsatz − Mitarbeiterkosten − Material-EK</th><th class="num">${value.profit === null ? "–" : money(value.profit)}</th></tr>`;
  }

  async function loadMaterialBookings(generation) {
    const results = await D.mapLimit(D.memberIds(collection), 4, async jobId => {
      const result = await api(`/admin/api/paint/job-materials?jobId=${encodeURIComponent(jobId)}`);
      return (result.items || []).map(row => ({ ...row, jobId }));
    });
    if (generation !== serial) return;
    bookings = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
    bookingFailures = results.filter(result => result.status === "rejected").length; bookingsReady = true; renderHours();
  }

  function renderHours() {
    const current = window.BaustellenLiveHours?.summary(id);
    const ready = collection && data && dataGeneration === serial && current?.complete && !data.billing.partial && !data.rows.some(row => row.errors.length);
    if (savedView && !ready) {
      const before = { jobs, collection, data, bookings, bookingFailures, bookingsReady };
      ({ jobs, collection, data, bookings, bookingFailures, bookingsReady } = savedView);
      usingSaved = true;
      try { renderHeader(); renderDocuments(); renderCurrentHours(); }
      finally { ({ jobs, collection, data, bookings, bookingFailures, bookingsReady } = before); usingSaved = false; }
      return;
    }
    if (!collection) return;
    renderHeader();
    if (data) renderDocuments();
    renderCurrentHours();
    if (ready) saveSnapshot(current);
  }

  function renderHeader() {
    document.title = `${id} · Sammelmappe · KRISTINE`;
    text("collectionTitle", `${id} · ${collection.name}`);
    el("collectionReference").innerHTML = `Verweist auf Hauptakte ${projectLink(collection.collectionMainJobId)} · ${D.memberIds(collection).length} Einzelakten`;
    el("collectionCustomerPortal").href = projectUrl(collection.collectionMainJobId);
  }

  async function loadSavedView() {
    try {
      const result = await api(`/admin/api/sammelmappe/${encodeURIComponent(id)}/view-cache`);
      if (!result.snapshot || result.snapshot.version !== 1 || result.snapshot.view?.collection?.jobId !== id) return;
      if (collection && (collection.registryUpdatedAt !== result.snapshot.view.collection.registryUpdatedAt || D.memberIds(collection).join("|") !== D.memberIds(result.snapshot.view.collection).join("|"))) return;
      savedView = result.snapshot.view; savedAt = result.snapshot.savedAt; renderHours();
    } catch { /* The normal source load remains available without a saved view. */ }
  }

  async function saveSnapshot(snapshot) {
    if (usingSaved || savingSnapshot || snapshot.saved === false || !startedAt || !bookingsReady || bookingFailures || data.rows.some(row => [...row.regieSources, ...row.billingSources].some(source => source.error || source.data?.cached || source.data?.saved === false))) return;
    const cacheKey = JSON.stringify([serial, snapshot.total, snapshot.target, snapshot.memberHours, bookings.length]);
    if (cacheKey === lastSavedSignature) return;
    const generation = serial;
    const view = { jobs: D.members(collection, jobs), collection, data, hours: snapshot,
      personDays: window.BaustellenLiveHours.personDayHours(id), cost: window.BaustellenLiveHours.laborCost(id),
      performance: window.BaustellenSources.performance(id), bookings, bookingFailures, bookingsReady };
    savingSnapshot = true;
    try {
      const result = await api(`/admin/api/sammelmappe/${encodeURIComponent(id)}/view-cache`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, startedAt, view }) });
      if (generation !== serial) return;
      if (result.stored === false) { lastSavedSignature = cacheKey; return; }
      lastSavedSignature = cacheKey; savedView = view; savedAt = result.savedAt;
      text("updatedAt", new Date(savedAt).toLocaleString("de-AT"));
      notice(`Stand gespeichert: ${new Date(savedAt).toLocaleString("de-AT")} · ${D.memberIds(collection).length}/${D.memberIds(collection).length} Akten geprüft · Stunden und Belege aktuell`);
    } catch (error) { if (generation === serial) notice("Zahlen geladen; Stand konnte nicht gespeichert werden: " + error.message, true); }
    finally { savingSnapshot = false; }
  }

  function renderCurrentHours() {
    if (!collection) return;
    const snapshot = usingSaved ? savedView.hours : window.BaustellenLiveHours.summary(id), byId = new Map(snapshot.memberHours.map(row => [row.jobId, row]));
    const expected = D.memberIds(collection), ready = expected.length > 0 && snapshot.available !== false && expected.every(jobId => byId.has(jobId));
    const sourceRows = new Map((data?.rows || []).map(row => [row.jobId, row]));
    const main = collection.collectionMainJobId;
    text("collectionTarget", ready ? hours(snapshot.target) : "–");
    text("collectionActual", ready ? hours(snapshot.total) : "–");
    const hoursStamp = snapshot.syncedAt ? new Date(snapshot.syncedAt).toLocaleString("de-AT") : "";
    text("collectionActualNote", ready ? `${hours(snapshot.kristine)} KRISTINE + ${hours(snapshot.ww)} WW${hoursStamp ? ` · ${snapshot.complete ? "Stand" : "Gespeicherter WW-Stand"}: ${hoursStamp}` : ""}${snapshot.saved === false ? " · Stand konnte nicht gespeichert werden" : ""}` : "Stunden werden geladen …");
    text("collectionOpen", ready ? hours(snapshot.remaining) : "–");
    text("collectionOverrun", ready ? hours(snapshot.overrun) : "–");
    text("collectionBalance", ready ? `${hours(snapshot.target)} Soll − ${hours(snapshot.total)} Ist = ${hours(snapshot.target - snapshot.total)}` : "Soll gesamt − Ist gesamt");
    text("collectionContract", money(collection.collectionSummary?.contractAmount));
    text("collectionCount", `${expected.length} Einzelakten`);
    let reportCount = 0, invoiceCount = 0;
    el("collectionMembers").innerHTML = expected.map(jobId => {
      const member = jobs.find(row => String(row.jobId) === jobId), live = byId.get(jobId), source = sourceRows.get(jobId);
      const reportCountRow = source ? reports(source).length : null, invoiceCountRow = source ? rowBilling(source).invoices.length : null;
      reportCount += reportCountRow || 0; invoiceCount += invoiceCountRow || 0;
      const state = usingSaved ? { label: "Gespeicherter Stand" } : window.BaustellenLiveHours.sourceStatus(jobId, { single: true });
      const difference = live ? live.target - live.total : null;
      return `<tr data-source-job="${esc(jobId)}"${jobId === main ? ' class="main-row"' : ""}><td>${projectLink(jobId)}<br>${esc(member?.name || "Einzelakte nicht geladen")}<small>${jobId === main ? "Hauptakte · Einzelprojekt" : esc(member?.status || "")}</small></td><td class="num">${live ? hours(live.target) : "–"}</td><td class="num" data-member-hours>${live ? hours(live.total) : "–"}</td><td class="num${difference < 0 ? " negative" : ""}">${difference === null ? "–" : hours(difference)}</td><td class="num">${reportCountRow ?? "–"}</td><td class="num">${invoiceCountRow ?? "–"}</td><td><small>${esc(state.label)}${source?.errors.length ? " · " + esc(source.errors.join(" · ")) : ""}</small></td><td>${jobId === main ? "" : `<button class="quiet" data-remove-member="${esc(jobId)}" type="button">Lösen</button>`}</td></tr>`;
    }).join("");
    el("collectionTotals").innerHTML = `<tr><th>Summe aus ${expected.length} Akten</th><th class="num">${ready ? hours(snapshot.target) : "–"}</th><th class="num" data-collection-hours>${ready ? hours(snapshot.total) : "–"}</th><th class="num">${ready ? hours(snapshot.target - snapshot.total) : "–"}</th><th class="num">${data ? reportCount : "–"}</th><th class="num">${data ? invoiceCount : "–"}</th><td colspan="2">${ready && snapshot.complete ? "Stunden aktuell" : "Stundenabgleich ausstehend"}</td></tr>`;
    if (data) {
      const sources = data.rows.flatMap(row => [...row.regieSources, ...row.billingSources]);
      const failed = sources.filter(source => source.error || source.data?.cached || source.data?.saved === false).length;
      const missing = data.rows.some(row => row.errors.length) || data.rows.length !== expected.length;
      notice(`${data.rows.length}/${expected.length} Einzelakten geladen · ${failed ? failed + " Beleg-Abgleich(e) ausstehend" : "Regie und Rechnungen abgeglichen"} · ${snapshot.complete && ready ? "Stunden aktuell" : "Stundenabgleich ausstehend; vorhandener Stand bleibt sichtbar"}`, !!failed || missing || !ready || !snapshot.complete);
      const performance = usingSaved ? savedView.performance : window.BaustellenSources.performance(id);
      text("collectionToInvoice", performance && !data.billing.partial && snapshot.complete && ready ? money(performance.amountToInvoice) : "–");
    }
    renderInsights(snapshot, ready);
    if (usingSaved) {
      const stamp = new Date(savedAt).toLocaleString("de-AT");
      notice(`Gespeicherter Stand: ${stamp} · ${expected.length}/${expected.length} Akten geprüft. ${el("refreshCollection").disabled ? "Aktualisierung läuft …" : "Aktueller Abgleich noch unvollständig; letzter Stand bleibt sichtbar."}`, true);
      text("updatedAt", stamp);
    }
  }

  function renderDocuments() {
    const selectedReport = el("reportPreview").open && allReports[previewIndex];
    allReports = data.rows.flatMap(row => reports(row).map(report => ({ ...report, jobId: row.jobId })));
    const reportHours = allReports.reduce((sum, row) => sum + D.num(row.totalHours), 0);
    const reportAmount = row => D.num(row.totalNet) || D.num(row.laborCost) + D.num(row.materialCost);
    text("reportCount", `(${allReports.length})`);
    el("collectionReports").innerHTML = allReports.map((row, index) => `<tr><td>${projectLink(row.jobId)}</td><td>${date(row.reportDate)}</td><td>${reportButton(row, index)}</td><td class="num">${hours(row.totalHours)}</td><td class="num">${money(reportAmount(row))}</td></tr>`).join("") || '<tr><td colspan="5">Keine gespeicherten Regieberichte vorhanden.</td></tr>';
    el("collectionReportTotals").innerHTML = `<tr><th colspan="3">Summe Regieberichte</th><th class="num">${hours(reportHours)}</th><th class="num">${money(allReports.reduce((sum, row) => sum + reportAmount(row), 0))}</th></tr>`;
    const invoices = data.billing.invoices;
    text("invoiceCount", `(${invoices.length})`);
    el("collectionInvoices").innerHTML = invoices.map(row => {
      const run = Number(row.runId ?? row.run_id), invoiceId = Number(row.id), label = esc(row.invoiceNumber || `Beleg ${row.id || ""}`);
      const link = run > 0 && invoiceId > 0 ? `<a href="http://127.0.0.1:5051/outgoing/invoices?run=${run}&invoice=${invoiceId}" target="_blank" rel="noopener">${label}</a>` : label;
      return `<tr><td>${projectLink(row.jobId)}</td><td>${date(row.issueDate)}</td><td>${link}</td><td>${row.status === "draft" ? "Entwurf" : row.status === "issued" ? "Ausgestellt" : esc(row.status || "–")}</td><td class="num">${money(row.net)}</td><td class="num">${money(row.gross)}</td></tr>`;
    }).join("") || '<tr><td colspan="6">Keine gespeicherten Rechnungen vorhanden.</td></tr>';
    text("collectionInvoiced", data.billing.partial ? "–" : money(data.billing.summary.billedNet));
    text("collectionPaid", data.billing.partial ? "–" : money(data.billing.summary.paidGross));
    const other = data.documents.filter(row => row.type !== "regie_report");
    text("documentCount", `(${other.length})`);
    el("collectionDocuments").innerHTML = other.map(row => `<li>${projectLink(row.jobId)} · ${documentLink(row)}</li>`).join("") || "<li>Keine weiteren gespeicherten Dokumente vorhanden.</li>";
    renderMaterial();
    if (selectedReport) {
      const index = allReports.findIndex(report => report.jobId === selectedReport.jobId && B.reportDedupeKey(report) === B.reportDedupeKey(selectedReport));
      if (index >= 0) openReport(index); else el("reportPreview").close();
    }
  }

  async function loadPhotos() {
    if (!collection || mediaLoaded || !el("mediaDetails").open) return;
    mediaLoaded = true;
    el("collectionPhotos").innerHTML = "<p>Fotos werden geladen …</p>";
    const results = await D.mapLimit(D.memberIds(collection), 4, async jobId => {
      const response = await api(`/admin/api/job/${encodeURIComponent(jobId)}/media?scope=single`);
      return (response.media || []).filter(row => row.kind === "photo").map(row => ({ ...row, jobId }));
    });
    const seen = new Set(), photos = results.flatMap(result => result.status === "fulfilled" ? result.value : []).filter(row => row.file && !seen.has(row.file) && seen.add(row.file));
    const failed = results.filter(row => row.status === "rejected").length;
    text("photoCount", `(${photos.length}${failed ? "; unvollständig" : ""})`);
    el("collectionPhotos").innerHTML = photos.map(row => `<a class="photo" href="${esc(url(row.url))}" target="_blank" rel="noopener"><img src="${esc(url(row.url))}" alt="Foto aus Akte ${esc(row.jobId)}" loading="lazy"><span>Akte ${esc(row.jobId)}</span></a>`).join("") || "<p>Keine Fotos geladen.</p>";
    if (failed) { el("collectionPhotos").insertAdjacentHTML("beforeend", `<p>${failed} Akte(n) konnten nicht geladen werden. Bitte aktualisieren.</p>`); mediaLoaded = false; }
  }

  async function saveMembers(memberJobIds) {
    const message = memberJobIds.length ? "Diese Einzelakte aus der Sammelmappe lösen? Die Akte bleibt erhalten." : "Sammelmappe auflösen? Alle Einzelakten bleiben erhalten.";
    if (!confirm(message)) return;
    try {
      await api(`/admin/api/job/${encodeURIComponent(id)}/collection`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberJobIds }) });
      location.href = memberJobIds.length ? url("/kristine/sammelmappe#" + encodeURIComponent(id)) : url("/kristine/baustellen");
      if (memberJobIds.length) location.reload();
    } catch (error) { notice("Nicht gespeichert: " + error.message, true); }
  }

  function filterMemberChoices() {
    const normalize = value => String(value || "").toLocaleLowerCase("de").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const terms = normalize(el("memberSearch").value).trim().split(/\s+/).filter(Boolean);
    const matches = memberCandidates.filter(job => terms.every(term => normalize([job.jobId, job.name, job.street, job.city].join(" ")).includes(term)));
    el("memberChoice").innerHTML = '<option value="">Bitte die passende Akte auswählen …</option>' + matches.map(job => `<option value="${esc(job.jobId)}">${esc(job.jobId)} · ${esc(job.name || "Ohne Namen")}${job.city ? " · " + esc(job.city) : ""}</option>`).join("");
    el("memberChoice").value = ""; el("saveAddMember").disabled = true;
    text("addMemberStatus", matches.length ? `${matches.length} verfügbare Einzelakten` : "Keine passende freie Einzelakte gefunden.");
  }

  async function openAddMember() {
    memberCandidates = [];
    el("memberSearch").value = ""; el("memberChoice").innerHTML = ""; el("saveAddMember").disabled = true;
    text("addMemberStatus", "Einzelakten werden geladen …"); el("addMemberDialog").showModal();
    try {
      const payload = await api("/admin/api/jobs"), group = (payload.collections || []).find(row => row.jobId === id);
      if (!group) throw new Error("Sammelmappe nicht gefunden.");
      const assigned = new Set((payload.collections || []).flatMap(row => D.memberIds(row)));
      memberCandidates = (payload.jobs || []).filter(job => !D.isCollection(job) && !assigned.has(String(job.jobId)) && !job.collectionMemberJobIds?.length);
      filterMemberChoices(); el("memberSearch").focus();
    } catch (error) { text("addMemberStatus", error.message); }
  }

  async function addMember() {
    const jobId = el("memberChoice").value;
    if (!memberCandidates.some(job => String(job.jobId) === jobId)) return;
    el("saveAddMember").disabled = true; text("addMemberStatus", "Einzelakte wird hinzugefügt …");
    try {
      // Re-read membership immediately before adding so another user's new
      // member is retained rather than replaced by the older screen contents.
      const payload = await api("/admin/api/jobs"), group = (payload.collections || []).find(row => row.jobId === id);
      if (!group) throw new Error("Sammelmappe nicht gefunden.");
      await api(`/admin/api/job/${encodeURIComponent(id)}/collection`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberJobIds: [...new Set([...D.memberIds(group), jobId])] }) });
      location.reload();
    } catch (error) { text("addMemberStatus", "Nicht hinzugefügt: " + error.message); el("saveAddMember").disabled = false; }
  }

  async function load(force = false) {
    const generation = ++serial;
    startedAt = new Date().toISOString(); bookingsReady = false;
    el("refreshCollection").disabled = true;
    try {
      const payload = await api("/admin/api/jobs");
      if (generation !== serial) return;
      jobs = D.catalog(payload); collection = jobs.find(row => row.jobId === id && D.isCollection(row));
      if (!collection) { savedView = null; throw new Error("Sammelmappe nicht gefunden. Bitte über die Baustellenliste öffnen."); }
      if (savedView && (collection.registryUpdatedAt !== savedView.collection.registryUpdatedAt || D.memberIds(collection).join("|") !== D.memberIds(savedView.collection).join("|"))) savedView = null;
      renderHours();
      const loaded = await window.BaustellenSources.load(collection, jobs, { force });
      if (generation !== serial) return;
      data = loaded; dataGeneration = generation; renderHours();
      loadMaterialBookings(generation);
      text("updatedAt", new Date().toLocaleString("de-AT"));
      mediaLoaded = false; await loadPhotos();
    } catch (error) { if (generation === serial) notice(error.message, true); }
    finally { if (generation === serial) { el("refreshCollection").disabled = false; renderHours(); } }
  }
  function boot() {
    el("addCollectionMember").onclick = openAddMember;
    el("closeAddMember").onclick = () => el("addMemberDialog").close();
    el("memberSearch").addEventListener("input", filterMemberChoices);
    el("memberChoice").addEventListener("change", () => { el("saveAddMember").disabled = !el("memberChoice").value; });
    el("saveAddMember").onclick = addMember;
    document.addEventListener("click", event => { const button = event.target.closest("[data-report-preview]"); if (button) openReport(Number(button.dataset.reportPreview)); });
    el("closeReportPreview").onclick = () => el("reportPreview").close();
    el("reportPreview").addEventListener("close", () => { el("reportPreviewBody").innerHTML = ""; });
    el("previousReport").onclick = () => openReport(previewIndex - 1);
    el("nextReport").onclick = () => openReport(previewIndex + 1);
    el("backToJobs").href = url("/kristine/baustellen");
    el("refreshCollection").onclick = async () => { window.BaustellenSources.clear(); await Promise.all([load(true), window.BaustellenLiveHours.refresh()]); };
    el("mediaDetails").addEventListener("toggle", loadPhotos);
    el("collectionMembers").addEventListener("click", event => { const button = event.target.closest("[data-remove-member]"); if (button && collection) saveMembers(D.memberIds(collection).filter(jobId => jobId !== button.dataset.removeMember)); });
    el("dissolveCollection").onclick = () => collection && saveMembers([]);
    window.addEventListener("krista:live-hours-updated", renderHours);
    window.addEventListener("hashchange", () => location.reload());
    loadSavedView(); load();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
