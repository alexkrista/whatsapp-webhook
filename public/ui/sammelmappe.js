"use strict";
(function () {
  const D = window.BaustellenData, B = window.KristaRegieBilling;
  const token = new URLSearchParams(location.search).get("token") || "";
  const id = decodeURIComponent(location.hash.slice(1));
  let jobs = [], collection = null, data = null, serial = 0, mediaLoaded = false;
  const esc = value => String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hours = value => new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(D.num(value)) + " h";
  const money = value => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(D.num(value));
  const date = value => /^\d{4}-\d{2}-\d{2}/.test(String(value || "")) ? String(value).slice(0, 10).split("-").reverse().join(".") : "–";
  const el = id => document.getElementById(id);
  const text = (id, value) => { el(id).textContent = value; };
  function url(path) { try { const value = new URL(path, location.origin); if (value.origin !== location.origin || !["http:", "https:"].includes(value.protocol)) return ""; if (token) value.searchParams.set("token", token); return value.pathname + value.search + value.hash; } catch { return ""; } }
  const projectUrl = jobId => url("/kristine/baustellen#" + encodeURIComponent(jobId));
  const projectLink = jobId => `<a href="${esc(projectUrl(jobId))}">${esc(jobId)}</a>`;
  async function api(path, options = {}) { const response = await fetch(url(path), options), result = await response.json(); if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`); return result; }
  function notice(message, warning = false) { text("collectionStatus", message); el("collectionStatus").classList.toggle("warning", warning); }
  const reports = row => B.dedupeReports(row.documents.filter(doc => doc.type === "regie_report"));
  function rowBilling(row) { return D.combineBilling(row.billingSources.filter(source => source.data).map(source => ({ ...source, billing: source.data.billing }))); }
  function documentLink(doc) { const href = doc.url ? url(doc.url) : ""; return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(doc.reportNumber || doc.name || "Dokument")}</a>` : `${esc(doc.reportNumber || doc.name || "Bericht")} · ${projectLink(doc.jobId)}`; }

  function renderHours() {
    if (!collection) return;
    const snapshot = window.BaustellenLiveHours.summary(id), byId = new Map(snapshot.memberHours.map(row => [row.jobId, row]));
    const expected = D.memberIds(collection), ready = expected.length > 0 && expected.every(jobId => byId.has(jobId));
    const sourceRows = new Map((data?.rows || []).map(row => [row.jobId, row]));
    const main = collection.collectionMainJobId;
    text("collectionTarget", ready ? hours(snapshot.target) : "–");
    text("collectionActual", ready ? hours(snapshot.total) : "–");
    text("collectionActualNote", ready ? `${hours(snapshot.kristine)} KRISTINE + ${hours(snapshot.ww)} WW` : "Stunden werden geladen …");
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
      const state = window.BaustellenLiveHours.sourceStatus(jobId, { single: true });
      const difference = live ? live.target - live.total : null;
      return `<tr data-source-job="${esc(jobId)}"${jobId === main ? ' class="main-row"' : ""}><td>${projectLink(jobId)}<br>${esc(member?.name || "Einzelakte nicht geladen")}<small>${jobId === main ? "Hauptakte · Einzelprojekt" : esc(member?.status || "")}</small></td><td class="num">${live ? hours(live.target) : "–"}</td><td class="num" data-member-hours>${live ? hours(live.total) : "–"}</td><td class="num${difference < 0 ? " negative" : ""}">${difference === null ? "–" : hours(difference)}</td><td class="num">${reportCountRow ?? "–"}</td><td class="num">${invoiceCountRow ?? "–"}</td><td><small>${esc(state.label)}${source?.errors.length ? " · " + esc(source.errors.join(" · ")) : ""}</small></td><td>${jobId === main ? "" : `<button class="quiet" data-remove-member="${esc(jobId)}" type="button">Lösen</button>`}</td></tr>`;
    }).join("");
    el("collectionTotals").innerHTML = `<tr><th>Summe aus ${expected.length} Akten</th><th class="num">${ready ? hours(snapshot.target) : "–"}</th><th class="num" data-collection-hours>${ready ? hours(snapshot.total) : "–"}</th><th class="num">${ready ? hours(snapshot.target - snapshot.total) : "–"}</th><th class="num">${data ? reportCount : "–"}</th><th class="num">${data ? invoiceCount : "–"}</th><td colspan="2">${ready && snapshot.complete ? "Stunden aktuell" : "Stundenabgleich ausstehend"}</td></tr>`;
    if (data) {
      const sources = data.rows.flatMap(row => [...row.regieSources, ...row.billingSources]);
      const failed = sources.filter(source => source.error || source.data?.cached || source.data?.saved === false).length;
      const missing = data.rows.some(row => row.errors.length) || data.rows.length !== expected.length;
      notice(`${data.rows.length}/${expected.length} Einzelakten geladen · ${failed ? failed + " Beleg-Abgleich(e) ausstehend" : "Regie und Rechnungen abgeglichen"} · ${snapshot.complete && ready ? "Stunden aktuell" : "Stundenabgleich ausstehend; vorhandener Stand bleibt sichtbar"}`, !!failed || missing || !ready || !snapshot.complete);
      const performance = window.BaustellenSources.performance(id);
      text("collectionToInvoice", performance && !data.billing.partial && snapshot.complete && ready ? money(performance.amountToInvoice) : "–");
    }
  }

  function renderDocuments() {
    const allReports = data.rows.flatMap(row => reports(row).map(report => ({ ...report, jobId: row.jobId })));
    const reportHours = allReports.reduce((sum, row) => sum + D.num(row.totalHours), 0);
    const reportAmount = row => D.num(row.totalNet) || D.num(row.laborCost) + D.num(row.materialCost);
    text("reportCount", `(${allReports.length})`);
    el("collectionReports").innerHTML = allReports.map(row => `<tr><td>${projectLink(row.jobId)}</td><td>${date(row.reportDate)}</td><td>${documentLink(row)}</td><td class="num">${hours(row.totalHours)}</td><td class="num">${money(reportAmount(row))}</td></tr>`).join("") || '<tr><td colspan="5">Keine gespeicherten Regieberichte vorhanden.</td></tr>';
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

  async function load(force = false) {
    const generation = ++serial;
    el("refreshCollection").disabled = true;
    try {
      const payload = await api("/admin/api/jobs");
      if (generation !== serial) return;
      jobs = D.catalog(payload); collection = jobs.find(row => row.jobId === id && D.isCollection(row));
      if (!collection) throw new Error("Sammelmappe nicht gefunden. Bitte über die Baustellenliste öffnen.");
      document.title = `${id} · Sammelmappe · KRISTINE`;
      text("collectionTitle", `${id} · ${collection.name}`);
      el("collectionReference").innerHTML = `Verweist auf Hauptakte ${projectLink(collection.collectionMainJobId)} · ${D.memberIds(collection).length} Einzelakten`;
      renderHours();
      const loaded = await window.BaustellenSources.load(collection, jobs, { force });
      if (generation !== serial) return;
      data = loaded; renderDocuments(); renderHours();
      text("updatedAt", new Date().toLocaleString("de-AT"));
      mediaLoaded = false; await loadPhotos();
    } catch (error) { if (generation === serial) notice(error.message, true); }
    finally { if (generation === serial) el("refreshCollection").disabled = false; }
  }
  function boot() {
    el("backToJobs").href = url("/kristine/baustellen");
    el("refreshCollection").onclick = async () => { window.BaustellenSources.clear(); await Promise.all([load(true), window.BaustellenLiveHours.refresh()]); };
    el("mediaDetails").addEventListener("toggle", loadPhotos);
    el("collectionMembers").addEventListener("click", event => { const button = event.target.closest("[data-remove-member]"); if (button) saveMembers(D.memberIds(collection).filter(jobId => jobId !== button.dataset.removeMember)); });
    el("dissolveCollection").onclick = () => collection && saveMembers([]);
    window.addEventListener("krista:live-hours-updated", renderHours);
    window.addEventListener("hashchange", () => location.reload());
    load();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
