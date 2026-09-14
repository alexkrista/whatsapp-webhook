/* Shared arithmetic and quantity bindings for the internal offer notepad. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KristaOfferNotepad = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MAX_BLOCKS = 30, MAX_TEXT = 12000, MAX_LINES = 120, MAX_EXPRESSION = 500, MAX_QUANTITY = 1e9;
  const round = value => Number(value.toFixed(6));
  const format = value => Number(value).toLocaleString("de-AT", { maximumFractionDigits: 6 });
  const fail = message => { const error = new Error(message); error.status = 400; throw error; };
  const newId = () => "calc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);

  function evaluateExpression(input) {
    const raw = String(input ?? "").trim();
    if (!raw || raw.length > MAX_EXPRESSION) fail(raw ? "Rechnung ist zu lang." : "Rechnung fehlt.");
    const source = raw.replace(/\*\s*[xX×]|[xX×]\s*\*/g, "*")
      .replace(/[xX×·]/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-")
      .replace(/,/g, ".").replace(/=\s*$/, "");
    let index = 0, depth = 0;
    const space = () => { while (/\s/.test(source[index] || "") && index < source.length) index++; };
    const peek = () => { space(); return source[index]; };
    const checked = value => { if (!Number.isFinite(value) || Math.abs(value) > 1e15) fail("Ergebnis ist zu groß."); return value; };
    function atom() {
      if (++depth > 40) fail("Zu viele verschachtelte Klammern.");
      let result;
      const char = peek();
      if (char === "+" || char === "-") { index++; result = (char === "-" ? -1 : 1) * atom(); }
      else if (char === "(") { index++; result = sum(); if (peek() !== ")") fail("Schließende Klammer fehlt."); index++; }
      else {
        const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
        if (!match) fail("Zahl oder Klammer erwartet.");
        index += match[0].length; result = Number(match[0]);
      }
      depth--; return checked(result);
    }
    function product() {
      let value = atom();
      while (peek() === "*" || peek() === "/") {
        const operator = source[index++], right = atom();
        if (operator === "/" && right === 0) fail("Teilen durch 0 geht nicht.");
        value = checked(operator === "*" ? value * right : value / right);
      }
      return value;
    }
    function sum() {
      let value = product();
      while (peek() === "+" || peek() === "-") {
        const operator = source[index++], right = product();
        value = checked(operator === "+" ? value + right : value - right);
      }
      return value;
    }
    const value = sum();
    if (peek() !== undefined) fail("Unvollständige Rechnung oder unbekanntes Zeichen.");
    return checked(value);
  }

  function calculateBlock(text) {
    const source = String(text ?? ""), lines = source.split(/\r?\n/);
    if (source.length > MAX_TEXT || lines.length > MAX_LINES)
      return { total: null, rows: [], error: "Der Block ist zu lang. Bitte einen weiteren Rechenblock verwenden." };
    let total = 0, count = 0;
    const rows = lines.map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || /^(#|\/\/)/.test(trimmed)) return { kind: "note" };
      const separator = trimmed.indexOf(":"), label = separator >= 0 ? trimmed.slice(0, separator) : "";
      let formula = separator >= 0 ? trimmed.slice(separator + 1).trim() : trimmed;
      if (separator < 0 && /^[A-Za-zÄÖÜäöüß]/.test(trimmed)) return { kind: "note" };
      formula = formula.split(/\s+#|\s+\/\//)[0].trim();
      if (!formula && label) return { kind: "note" };
      try { const value = evaluateExpression(formula); total += value; count++; return { kind: "result", label, value: round(value) }; }
      catch (error) { return { kind: "error", error: `Zeile ${index + 1}: ${error.message}` }; }
    });
    const error = rows.find(row => row.kind === "error")?.error || (Math.abs(total) > 1e15 ? "Blocksumme ist zu groß." : "");
    return { rows, total: error || !count ? null : Number(total.toPrecision(15)), error, count };
  }

  function sanitizeBlocks(input) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > MAX_BLOCKS) fail(`Höchstens ${MAX_BLOCKS} Rechenblöcke sind möglich.`);
    const seen = new Set();
    return input.map((block, index) => {
      if (!block || typeof block !== "object") fail("Ungültiger Rechenblock.");
      const id = String(block.id || newId());
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || seen.has(id)) fail("Rechenblöcke brauchen eindeutige Kennungen.");
      seen.add(id);
      const text = String(block.text ?? "");
      if (text.length > MAX_TEXT || text.split(/\r?\n/).length > MAX_LINES) fail(`Rechenblock ${index + 1} ist zu lang.`);
      return { id, title: String(block.title || `Block ${index + 1}`).slice(0, 160), text };
    });
  }

  function automaticMaterial(draft, position) {
    return draft.offerType === "regie_material" && (String(position.text || "").startsWith("Material und Maschinen") || position.unit === "VE" || position.unit === "PA" && String(position.text || "").includes("Regiearbeiten"));
  }

  // The binding is stored on the position itself. Reordering or deleting other
  // positions cannot redirect a formula to a different position number.
  function apply(draft, strict = false) {
    const blocks = Array.isArray(draft.notepadBlocks) ? draft.notepadBlocks : [];
    const results = new Map(blocks.map(block => [block.id, calculateBlock(block.text)])), updates = [], errors = [];
    for (const [index, position] of (draft.positions || []).entries()) {
      const binding = position.quantityFormula;
      if (!binding) continue;
      try {
        if (automaticMaterial(draft, position)) fail("Diese Materialmenge wird bereits aus der Regie berechnet.");
        const block = blocks.find(item => item.id === binding.blockId), result = results.get(binding.blockId);
        if (!block) fail("Der zugeordnete Rechenblock fehlt.");
        if (result.error || result.total === null) fail(`${block.title}: ${result.error || "Rechnung fehlt."}`);
        const factor = evaluateExpression(binding.factor ?? "1");
        if (factor < 0 || factor > 1000000) fail("Der Faktor muss zwischen 0 und 1.000.000 liegen.");
        const quantity = round(result.total * factor);
        if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY) fail("Die Positionsmenge muss zwischen 0 und 1.000.000.000 liegen.");
        updates.push({ position, quantity });
      } catch (error) { errors.push({ index, blockId: binding.blockId, error: `Position ${index + 1}: ${error.message}` }); }
    }
    // Validate everything before changing quantities during a save.
    if (strict && errors.length) fail(errors[0].error);
    for (const { position, quantity } of updates) { position.quantity = quantity; position.autoQuantityOverridden = true; }
    return { results, errors };
  }

  function prepareForSave(draft, input = draft, previous = null) {
    const aware = Object.prototype.hasOwnProperty.call(input, "notepadBlocks");
    draft.notepadBlocks = sanitizeBlocks(aware ? input.notepadBlocks : previous?.notepadBlocks);
    for (const [index, position] of (draft.positions || []).entries()) {
      const source = input.positions?.[index];
      const old = !aware && previous?.positions?.find(item => item.text === position.text && item.groupId === position.groupId && item.unit === position.unit);
      const binding = source?.quantityFormula || old?.quantityFormula;
      if (!binding) { delete position.quantityFormula; continue; }
      const factor = String(binding.factor ?? "1").trim(), blockId = String(binding.blockId || "");
      if (factor.length > MAX_EXPRESSION || !/^[a-zA-Z0-9_-]{1,80}$/.test(blockId)) fail("Ungültige Zuordnung im Rechenblatt.");
      position.quantityFormula = { blockId, factor };
    }
    apply(draft, true);
    return draft;
  }

  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const setText = (element, value) => { if (element && element.textContent !== value) element.textContent = value; };

  function mount(host, options) {
    if (host.offerNotepad) { host.offerNotepad.refresh(); return host.offerNotepad; }
    const doc = host.ownerDocument, getDraft = options.getDraft;
    host.innerHTML = `<details class="kon-sheet" open><summary>Freies Rechenblatt <small>intern</small></summary><p>Eine Rechnung pro Zeile. Jede Blocksumme kann mehreren Positionen zugeordnet werden – mit einem eigenen Faktor je Position.</p><p class="kon-help">Zum Beispiel <code>Nordseite: (2+3) x 2 x 2,5 - 1,2 + 2</code>. Text ohne Rechnung bleibt als Notiz stehen. Wird mit dem Angebotsentwurf gespeichert.</p><div data-kon-blocks></div><button type="button" data-kon-add>+ Rechenblock</button><span data-kon-message role="status"></span></details>`;
    if (!doc.getElementById("offerNotepadCss")) {
      const style = doc.createElement("style"); style.id = "offerNotepadCss";
      style.textContent = `.kon-sheet{margin:22px 0;padding:18px;border:1px solid #bacbbd;border-radius:12px;background:#f5f8f3}.kon-sheet>summary{cursor:pointer;font-size:20px;font-weight:800;color:#264c35}.kon-sheet small,.kon-help{color:#69776b;font-size:13px}.kon-sheet p{margin:10px 0;line-height:1.5}.kon-sheet button{cursor:pointer;border:1px solid #bbc8b9;border-radius:8px;background:white;color:#264c35;padding:8px 12px;font:inherit;font-weight:700}.kon-sheet input,.kon-sheet textarea{box-sizing:border-box;font:inherit;color:#202f23;background:#fff;border:1px solid #c3cbbb;border-radius:6px;padding:8px;min-width:0}.kon-block{margin:16px 0;padding:14px;background:#fff;border:1px solid #d7decf;border-radius:10px}.kon-block-head{display:flex;gap:10px;align-items:center;margin-bottom:10px}.kon-block-head input{flex:1;font-weight:700}.kon-writing{display:grid;grid-template-columns:minmax(140px,1fr) 140px;border:1px solid #d7decf;border-radius:8px;overflow:hidden}.kon-writing textarea{width:100%;resize:vertical;border:0;border-radius:0;line-height:28px;padding:10px 12px;font-family:ui-monospace,monospace;font-size:15px;white-space:pre;overflow:auto;background:repeating-linear-gradient(#fffef7 0,#fffef7 27px,#e7e9db 28px);background-position:0 10px;min-height:136px}.kon-line-results{padding:10px 8px;text-align:right;background:#f6f8f2;overflow:hidden}.kon-line-results>div{height:28px;line-height:28px;white-space:nowrap;font-variant-numeric:tabular-nums}.kon-total{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:12px 0;font-size:18px;color:#264c35}.kon-error{color:#aa342e!important;font-size:13px}.kon-assignment>summary{cursor:pointer;font-weight:700;padding:8px 0}.kon-search{width:100%;margin:8px 0}.kon-assignments{max-height:340px;overflow:auto}.kon-assignment-row{display:grid;grid-template-columns:minmax(160px,1fr) 90px minmax(150px,.65fr);gap:10px;align-items:center;border-bottom:1px solid #edf0e9;padding:9px 0}.kon-assignment-row label{display:flex;gap:8px;align-items:center;font-size:14px}.kon-assignment-row label input{flex:0 0 auto}.kon-assignment-row label span{overflow-wrap:anywhere}.kon-assignment-row input[data-kon-factor]{width:85px}.kon-assignment-row output{font-size:13px;text-align:right}.kon-assignment-row[hidden]{display:none}.kon-position-note{background:#edf4e7;color:#264c35;padding:4px 8px;border-radius:5px}.kon-sheet [data-kon-message]{display:block;margin-top:10px;font-size:13px}.kon-empty{color:#69776b;padding:12px 0}.kon-row-head{font-size:12px;color:#69776b}.kon-sheet input:focus,.kon-sheet textarea:focus{outline:2px solid #3d8455;outline-offset:1px}@media(max-width:650px){.kon-sheet{padding:10px}.kon-block{padding:10px}.kon-assignment-row{grid-template-columns:minmax(140px,1fr) 75px}.kon-assignment-row output{grid-column:1/-1;text-align:left}.kon-writing{grid-template-columns:minmax(120px,1fr) 95px}.kon-block-head{flex-wrap:wrap}}@media print{#kofferNotepad,.kon-position-note{display:none!important}}`;
      doc.head.appendChild(style);
    }
    const list = host.querySelector("[data-kon-blocks]"), cards = new Map();
    const blockById = id => (getDraft().notepadBlocks || []).find(block => block.id === id);
    function changed() {
      apply(getDraft()); refresh(); options.onChange?.();
      setText(host.querySelector("[data-kon-message]"), "Geändert – zum Behalten den Angebotsentwurf speichern.");
      options.onDirty?.();
    }
    function makeCard(block) {
      const card = doc.createElement("section"); card.className = "kon-block"; card.dataset.konBlock = block.id;
      card.innerHTML = `<div class="kon-block-head"><input data-kon-title aria-label="Name des Rechenblocks" maxlength="160"><button type="button" data-kon-remove>Block entfernen</button></div><div class="kon-writing"><textarea data-kon-text aria-label="Rechnungen und Notizen" rows="4" maxlength="${MAX_TEXT}" spellcheck="false" placeholder="Fassade Nord\n(2+3) x 2 x 2,5 - 1,2 + 2\nSüdseite: 6 x 2,5"></textarea><div class="kon-line-results" aria-label="Ergebnisse je Zeile"></div></div><div class="kon-total"><span>Summe</span><strong data-kon-total aria-live="polite"></strong></div><div class="kon-error" data-kon-error role="status"></div><details class="kon-assignment"><summary data-kon-summary>Summe Positionen zuordnen</summary><p class="kon-help">Jede gewählte Position erhält die ganze Summe × Faktor. Bei Faktor 1 bleibt die Menge gleich. Abwählen löst die Verbindung und behält die zuletzt berechnete Menge.</p><input class="kon-search" data-kon-search placeholder="Position suchen, z. B. Gerüst oder 4" aria-label="Position suchen"><div class="kon-assignment-row kon-row-head"><span>Position</span><span>Faktor</span><span>Menge</span></div><div class="kon-assignments"></div></details>`;
      card.querySelector("[data-kon-title]").value = block.title;
      card.querySelector("[data-kon-text]").value = block.text;
      card.querySelector("[data-kon-title]").addEventListener("input", event => { blockById(block.id).title = event.target.value; changed(); });
      card.querySelector("[data-kon-text]").addEventListener("input", event => { blockById(block.id).text = event.target.value; changed(); });
      card.querySelector("[data-kon-remove]").onclick = () => {
        const draft = getDraft();
        // Removing a block never deletes a position or its last calculated quantity.
        draft.notepadBlocks = draft.notepadBlocks.filter(item => item.id !== block.id);
        for (const position of draft.positions || []) if (position.quantityFormula?.blockId === block.id) delete position.quantityFormula;
        changed();
      };
      card.querySelector("[data-kon-search]").oninput = () => filterRows(card);
      card.querySelector("[data-kon-text]").onscroll = event => { card.querySelector(".kon-line-results").scrollTop = event.target.scrollTop; };
      card.querySelector(".kon-assignments").addEventListener("change", event => {
        if (!event.target.matches("[data-kon-link]")) return;
        const position = getDraft().positions[Number(event.target.closest("[data-kon-position]").dataset.konPosition)];
        if (event.target.checked) position.quantityFormula = { blockId: block.id, factor: "1" };
        else delete position.quantityFormula;
        changed();
      });
      card.querySelector(".kon-assignments").addEventListener("input", event => {
        if (!event.target.matches("[data-kon-factor]")) return;
        const position = getDraft().positions[Number(event.target.closest("[data-kon-position]").dataset.konPosition)];
        if (position.quantityFormula?.blockId === block.id) { position.quantityFormula = { ...position.quantityFormula, factor: event.target.value }; changed(); }
      });
      list.appendChild(card); cards.set(block.id, card); return card;
    }
    function filterRows(card) {
      const query = card.querySelector("[data-kon-search]").value.trim().toLocaleLowerCase("de");
      for (const row of card.querySelectorAll("[data-kon-position]")) row.hidden = !row.dataset.search.includes(query);
    }
    function refresh() {
      const draft = getDraft(); if (!draft) return;
      const blocks = draft.notepadBlocks || [], positions = draft.positions || [], state = apply(draft);
      for (const [id, card] of cards) if (!blocks.some(block => block.id === id)) { card.remove(); cards.delete(id); }
      for (const block of blocks) {
        const card = cards.get(block.id) || makeCard(block), result = state.results.get(block.id);
        const title = card.querySelector("[data-kon-title]"), text = card.querySelector("[data-kon-text]");
        if (doc.activeElement !== title && title.value !== block.title) title.value = block.title;
        if (doc.activeElement !== text && text.value !== block.text) text.value = block.text;
        const rows = Math.max(4, Math.min(16, result.rows.length)); if (text.rows !== rows) text.rows = rows;
        const resultsHtml = result.rows.map(row => `<div${row.kind === "error" ? ` class="kon-error" title="${esc(row.error)}"` : ""}>${row.kind === "result" ? `= ${format(row.value)}` : row.kind === "error" ? "prüfen" : "&nbsp;"}</div>`).join("");
        const output = card.querySelector(".kon-line-results"); if (output.innerHTML !== resultsHtml) output.innerHTML = resultsHtml;
        setText(card.querySelector("[data-kon-total]"), result.total === null ? "—" : format(result.total));
        const bindingError = state.errors.find(error => error.blockId === block.id);
        setText(card.querySelector("[data-kon-error]"), bindingError?.error || result.error || "");
        const count = positions.filter(position => position.quantityFormula?.blockId === block.id).length;
        setText(card.querySelector("[data-kon-summary]"), `Summe Positionen zuordnen${count ? ` · ${count} verbunden` : ""}`);
        const fingerprint = JSON.stringify(positions.map(position => [position.text, position.groupName, position.unit, position.quantityFormula?.blockId, automaticMaterial(draft, position)]));
        if (card.positionsFingerprint !== fingerprint) {
          const assignment = card.querySelector(".kon-assignment"), target = card.querySelector(".kon-assignments");
          if (!card.positionsFingerprint && count) assignment.open = true;
          card.positionsFingerprint = fingerprint;
          target.innerHTML = positions.map((position, index) => {
            const linked = position.quantityFormula?.blockId === block.id, other = position.quantityFormula && !linked;
            const unavailable = automaticMaterial(draft, position), label = `Pos. ${index + 1} · ${position.text || "Ohne Bezeichnung"}`;
            const sub = unavailable ? "Material automatisch aus Regie" : other ? `Verbunden mit ${blockById(position.quantityFormula.blockId)?.title || "anderem Block"}` : position.groupName || "";
            return `<div class="kon-assignment-row" data-kon-position="${index}" data-search="${esc(`${index + 1} ${position.text || ""} ${position.groupName || ""}`.toLocaleLowerCase("de"))}"><label><input type="checkbox" data-kon-link ${linked ? "checked" : ""} ${other || unavailable ? "disabled" : ""}><span>${esc(label)}${sub ? `<br><small>${esc(sub)}</small>` : ""}</span></label><input data-kon-factor inputmode="decimal" aria-label="Faktor für Position ${index + 1}" value="${esc(linked ? position.quantityFormula.factor : "1")}" ${linked ? "" : "disabled"}><output data-kon-quantity></output></div>`;
          }).join("") || '<p class="kon-empty">Zuerst die gewünschten Angebotspositionen auswählen.</p>';
          filterRows(card);
        }
        for (const row of card.querySelectorAll("[data-kon-position]")) {
          const index = Number(row.dataset.konPosition), position = positions[index], binding = position.quantityFormula;
          const linked = binding?.blockId === block.id, input = row.querySelector("[data-kon-factor]");
          if (linked && doc.activeElement !== input && input.value !== binding.factor) input.value = binding.factor;
          const invalid = state.errors.some(error => error.index === index);
          setText(row.querySelector("[data-kon-quantity]"), linked ? invalid ? `Bitte Rechnung prüfen · bisher ${format(position.quantity || 0)} ${position.unit || ""}` : `${format(result.total)} × ${binding.factor} = ${format(position.quantity)} ${position.unit || ""}` : "");
        }
      }
      host.querySelector("[data-kon-add]").disabled = blocks.length >= MAX_BLOCKS;
      decoratePositions(doc, draft);
    }
    host.querySelector("[data-kon-add]").onclick = () => {
      const draft = getDraft(); draft.notepadBlocks ||= [];
      if (draft.notepadBlocks.length >= MAX_BLOCKS) return;
      const block = { id: newId(), title: `Block ${draft.notepadBlocks.length + 1}`, text: "" };
      draft.notepadBlocks.push(block); changed(); cards.get(block.id).querySelector("[data-kon-text]").focus();
    };
    host.offerNotepad = { refresh, saved() { refresh(); setText(host.querySelector("[data-kon-message]"), "Rechenblatt mit dem Angebotsentwurf gespeichert."); } };
    refresh(); return host.offerNotepad;
  }

  function decoratePositions(doc, draft) {
    for (const row of doc.querySelectorAll("#koffer .koffer-pos[data-i]")) {
      const position = draft.positions?.[Number(row.dataset.i)], binding = position?.quantityFormula, input = row.querySelector('[data-f="quantity"]');
      if (!input) continue;
      if (input.readOnly !== !!binding) input.readOnly = !!binding;
      let note = row.querySelector("[data-kon-source]");
      if (!binding) { if (note) { note.remove(); input.removeAttribute("title"); } continue; }
      const block = draft.notepadBlocks?.find(item => item.id === binding.blockId);
      const label = `Rechenblatt: ${block?.title || "Block"} × ${binding.factor}`;
      if (!note) { note = doc.createElement("span"); note.dataset.konSource = "1"; note.className = "kon-position-note"; (row.querySelector(".koffer-facts") || row).appendChild(note); }
      setText(note, label);
      input.title = "Menge aus dem Rechenblatt. Dort ändern oder die Zuordnung lösen.";
    }
  }

  return { evaluateExpression, calculateBlock, sanitizeBlocks, apply, prepareForSave, automaticMaterial, mount, MAX_BLOCKS };
});
