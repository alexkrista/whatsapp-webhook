"use strict";
(() => {
  const root = document.getElementById("supplier-pool");
  if (!root) return;
  const list = root.querySelector("#supplier-list");
  const message = root.querySelector("#supplier-message");
  const form = root.querySelector("#supplier-form");
  const statuses = {
    idee: "Idee", gestaltung: "In Gestaltung", freigabe: "Zur Freigabe",
    freigegeben: "Freigegeben", geplant: "Geplant", veroeffentlicht: "Veröffentlicht"
  };
  function report(value) { message.textContent = value; }
  async function request(endpoint, options = {}) {
    const response = await fetch("/kristine/api/supplier-stories" + endpoint, {
      credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...options
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Serverfehler");
    return data;
  }
  function button(text, handler) {
    const element = document.createElement("button");
    element.type = "button"; element.textContent = text;
    element.addEventListener("click", handler);
    return element;
  }
  function makeLink(text, href) {
    const element = document.createElement("a");
    element.textContent = text; element.href = href;
    element.rel = "noopener noreferrer"; element.target = "_blank";
    return element;
  }
  async function refresh() {
    try {
      const data = await request("");
      list.replaceChildren();
      if (!data.items.length) { list.textContent = "Noch keine Lieferanten-Stories gespeichert."; return; }
      for (const item of data.items) {
        const card = document.createElement("article");
        card.className = "card";
        const title = document.createElement("h3"); title.textContent = item.supplier;
        const note = document.createElement("p"); note.textContent = item.note || "Noch kein Kommentar – ergänzen vor dem Posten.";
        const date = document.createElement("p"); date.className = "note";
        date.textContent = new Date(item.createdAt).toLocaleDateString("de-AT") + " · " + (statuses[item.status] || item.status);
        const actions = document.createElement("div"); actions.className = "actions";
        actions.append(makeLink("Original öffnen / teilen", item.link));
        actions.append(makeLink("In Canva bearbeiten", "https://www.canva.com/"));
        actions.append(button("Für später merken", async () => {
          try { await request("/" + encodeURIComponent(item.id), { method: "PATCH", body: JSON.stringify({ status: "idee" }) }); await refresh(); }
          catch (error) { report(error.message); }
        }));
        actions.append(button("Text kopieren", async () => {
          const text = item.note || "Schönes Detail für unser Zuhause – entdeckt bei " + item.supplier + ".";
          try { await navigator.clipboard.writeText(text); report("Kommentar kopiert."); }
          catch { window.prompt("Kommentar kopieren", text); }
        }));
        const select = document.createElement("select");
        select.setAttribute("aria-label", "Bearbeitungsstatus " + item.supplier);
        for (const [value, label] of Object.entries(statuses)) {
          const opt = document.createElement("option"); opt.value = value; opt.textContent = label; select.append(opt);
        }
        select.value = item.status;
        select.addEventListener("change", async () => {
          try { await request("/" + encodeURIComponent(item.id), { method: "PATCH", body: JSON.stringify({ status: select.value }) }); report("Status gespeichert."); await refresh(); }
          catch (error) { report(error.message); await refresh(); }
        });
        const supplierLabel = document.createElement("label");
        supplierLabel.textContent = "Lieferant zuordnen: ";
        const supplierInput = document.createElement("input");
        supplierInput.type = "text";
        supplierInput.maxLength = 90;
        supplierInput.setAttribute("list", "krista-suppliers");
        supplierInput.setAttribute("aria-label", "Lieferant auswählen oder eingeben");
        supplierInput.value = item.supplier === "Lieferant noch zuordnen" ? "" : item.supplier;
        supplierInput.placeholder = "Lieferant auswählen oder eingeben";
        supplierInput.style.cssText = "width:100%;padding:.65rem;margin:.3rem 0;min-height:44px";
        const saveSupplier = button("Zuordnung speichern", async () => {
          const value = supplierInput.value.trim();
          if (!value) { report("Bitte Lieferanten auswählen oder eingeben."); return; }
          saveSupplier.disabled = true;
          try {
            await request("/" + encodeURIComponent(item.id), { method: "PATCH", body: JSON.stringify({ supplier: value }) });
            await refresh(); report("Lieferant zugeordnet.");
          } catch (error) { report(error.message); saveSupplier.disabled = false; }
        });
        supplierLabel.append(supplierInput);
        const noteLabel = document.createElement("label");
        noteLabel.textContent = "Krista-Kommentar bearbeiten: ";
        const noteInput = document.createElement("textarea");
        noteInput.rows = 2; noteInput.maxLength = 1200;
        noteInput.value = item.note || "";
        noteInput.style.cssText = "display:block;width:100%;padding:.65rem;margin:.3rem 0";
        const saveNote = button("Kommentar speichern", async () => {
          saveNote.disabled = true;
          try {
            await request("/" + encodeURIComponent(item.id), { method: "PATCH", body: JSON.stringify({note:noteInput.value}) });
            await refresh(); report("Kommentar gespeichert.");
          } catch (error) { report(error.message); saveNote.disabled = false; }
        });
        noteLabel.append(noteInput);
        card.append(title, date, note, supplierLabel, saveSupplier, noteLabel, saveNote, actions, select);
        list.append(card);
      }
      report("");
    } catch (error) { report(error.message); }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const link = form.querySelector('[name="link"]').value;
      const supplier = form.querySelector('[name="supplier"]').value;
      const note = form.querySelector('[name="note"]').value;
      await request("", { method: "POST", body: JSON.stringify({ link, supplier, note }) });
      form.reset(); await refresh(); report("Lieferanten-Story gespeichert.");
    } catch (error) { report(error.message); }
    finally { submit.disabled = false; }
  });
  refresh();
})();

