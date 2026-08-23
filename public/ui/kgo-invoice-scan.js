"use strict";

(function () {
  const token = new URLSearchParams(location.search).get("token") || "";
  const MAX_UPLOAD = 12 * 1024 * 1024;
  const MAX_PAGES = 10;
  const SOURCE_MAX_SIDE = 2200;
  const OUTPUT_MAX_SIDE = 1800;
  const JPEG_QUALITY = 0.84;
  const pages = [];
  let processing = false;

  function authUrl(path) {
    if (!token) return path;
    return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }

  function employeeId() {
    return String(localStorage.getItem("kristineGoEmployeeId") || new URLSearchParams(location.search).get("employeeId") || "").trim();
  }

  function employeeName() {
    return String(document.getElementById("kgEmployeeName")?.textContent || "Mitarbeiter").trim();
  }

  function toast(text) {
    const existing = document.getElementById("kgToast");
    if (existing) {
      existing.textContent = text;
      existing.classList.add("is-visible");
      clearTimeout(existing._invoiceTimer);
      existing._invoiceTimer = setTimeout(() => existing.classList.remove("is-visible"), 4200);
      return;
    }
    alert(text);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function polygonArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  function makeCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  function canvasBlob(canvas, type = "image/jpeg", quality = JPEG_QUALITY) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Scan konnte nicht erzeugt werden.")), type, quality);
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Kamerabild konnte nicht gelesen werden."));
      };
      img.src = url;
    });
  }

  function normalizedSourceCanvas(img) {
    const nw = Number(img.naturalWidth || img.width || 1);
    const nh = Number(img.naturalHeight || img.height || 1);
    const scale = Math.min(1, SOURCE_MAX_SIDE / Math.max(nw, nh));
    const canvas = makeCanvas(nw * scale, nh * scale);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function fitLineXonY(points) {
    if (!points.length) return null;
    let sy = 0, sx = 0, syy = 0, syx = 0;
    for (const p of points) {
      sy += p.y; sx += p.x; syy += p.y * p.y; syx += p.y * p.x;
    }
    const n = points.length;
    const den = n * syy - sy * sy;
    if (Math.abs(den) < 1e-6) return { a: 0, b: sx / n };
    const a = (n * syx - sy * sx) / den;
    return { a, b: (sx - a * sy) / n };
  }

  function fitLineYonX(points) {
    if (!points.length) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of points) {
      sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y;
    }
    const n = points.length;
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-6) return { a: 0, b: sy / n };
    const a = (n * sxy - sx * sy) / den;
    return { a, b: (sy - a * sx) / n };
  }

  function intersectXonYWithYonX(xLine, yLine) {
    if (!xLine || !yLine) return null;
    const den = 1 - xLine.a * yLine.a;
    if (Math.abs(den) < 1e-5) return null;
    const x = (xLine.a * yLine.b + xLine.b) / den;
    return { x, y: yLine.a * x + yLine.b };
  }

  function fallbackQuad(width, height) {
    const x = width * 0.018;
    const y = height * 0.018;
    return [
      { x, y },
      { x: width - x, y },
      { x: width - x, y: height - y },
      { x, y: height - y },
    ];
  }

  function detectDocument(source) {
    const scale = Math.min(1, 680 / Math.max(source.width, source.height));
    const canvas = makeCanvas(source.width * scale, source.height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgba = image.data;
    const w = canvas.width;
    const h = canvas.height;

    let seed = -1;
    let best = -1e9;
    const x0 = Math.floor(w * 0.30), x1 = Math.ceil(w * 0.70);
    const y0 = Math.floor(h * 0.28), y1 = Math.ceil(h * 0.72);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4;
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const score = lum - chroma * 0.55;
        if (score > best) { best = score; seed = y * w + x; }
      }
    }

    if (seed < 0) return { quad: fallbackQuad(source.width, source.height), confident: false };
    const si = seed * 4;
    const seedLum = 0.299 * rgba[si] + 0.587 * rgba[si + 1] + 0.114 * rgba[si + 2];
    const minLum = Math.max(105, seedLum - 78);
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    const minX = new Int32Array(h); minX.fill(w);
    const maxX = new Int32Array(h); maxX.fill(-1);
    const minY = new Int32Array(w); minY.fill(h);
    const maxY = new Int32Array(w); maxY.fill(-1);
    let count = 0, bx0 = w, bx1 = 0, by0 = h, by1 = 0;

    function qualifies(idx) {
      const i = idx * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      return lum >= minLum && chroma <= 118;
    }

    while (head < tail) {
      const idx = queue[head++];
      if (!qualifies(idx)) continue;
      const x = idx % w;
      const y = (idx / w) | 0;
      count += 1;
      if (x < minX[y]) minX[y] = x;
      if (x > maxX[y]) maxX[y] = x;
      if (y < minY[x]) minY[x] = y;
      if (y > maxY[x]) maxY[x] = y;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      const neighbors = [idx - 1, idx + 1, idx - w, idx + w];
      for (const n of neighbors) {
        if (n < 0 || n >= w * h || visited[n]) continue;
        const nx = n % w;
        const ny = (n / w) | 0;
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        visited[n] = 1;
        queue[tail++] = n;
      }
    }

    const ratio = count / (w * h);
    const bw = Math.max(1, bx1 - bx0), bh = Math.max(1, by1 - by0);
    if (ratio < 0.10 || ratio > 0.94 || bw < w * 0.38 || bh < h * 0.38) {
      return { quad: fallbackQuad(source.width, source.height), confident: false };
    }

    const left = [], right = [], top = [], bottom = [];
    for (let y = by0; y <= by1; y += 2) {
      if (maxX[y] < 0 || maxX[y] - minX[y] < bw * 0.42) continue;
      left.push({ x: minX[y], y });
      right.push({ x: maxX[y], y });
    }
    for (let x = bx0; x <= bx1; x += 2) {
      if (maxY[x] < 0 || maxY[x] - minY[x] < bh * 0.42) continue;
      top.push({ x, y: minY[x] });
      bottom.push({ x, y: maxY[x] });
    }

    const l = fitLineXonY(left), r = fitLineXonY(right);
    const t = fitLineYonX(top), b = fitLineYonX(bottom);
    let quad = [
      intersectXonYWithYonX(l, t),
      intersectXonYWithYonX(r, t),
      intersectXonYWithYonX(r, b),
      intersectXonYWithYonX(l, b),
    ];
    if (quad.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      return { quad: fallbackQuad(source.width, source.height), confident: false };
    }

    const ds = 1 / scale;
    quad = quad.map(p => ({ x: p.x * ds, y: p.y * ds }));
    const center = quad.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    quad = quad.map(p => ({
      x: clamp(center.x + (p.x - center.x) * 1.015, 0, source.width - 1),
      y: clamp(center.y + (p.y - center.y) * 1.015, 0, source.height - 1),
    }));

    const areaRatio = polygonArea(quad) / (source.width * source.height);
    const edges = [dist(quad[0], quad[1]), dist(quad[1], quad[2]), dist(quad[2], quad[3]), dist(quad[3], quad[0])];
    const valid = areaRatio > 0.16 && Math.min(...edges) > Math.min(source.width, source.height) * 0.18;
    return valid ? { quad, confident: true } : { quad: fallbackQuad(source.width, source.height), confident: false };
  }

  function homographyForQuad(q) {
    const p0 = q[0], p1 = q[1], p2 = q[2], p3 = q[3];
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
    let g = 0, h = 0;
    const den = dx1 * dy2 - dx2 * dy1;
    if ((Math.abs(dx3) > 1e-7 || Math.abs(dy3) > 1e-7) && Math.abs(den) > 1e-7) {
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
    }
    return {
      a: p1.x - p0.x + g * p1.x,
      b: p3.x - p0.x + h * p3.x,
      c: p0.x,
      d: p1.y - p0.y + g * p1.y,
      e: p3.y - p0.y + h * p3.y,
      f: p0.y,
      g, h,
    };
  }

  function correctedCanvas(source, quad) {
    const top = dist(quad[0], quad[1]), bottom = dist(quad[3], quad[2]);
    const left = dist(quad[0], quad[3]), right = dist(quad[1], quad[2]);
    let outW = Math.max(240, (top + bottom) / 2);
    let outH = Math.max(320, (left + right) / 2);
    const scale = Math.min(1, OUTPUT_MAX_SIDE / Math.max(outW, outH));
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);

    const srcCtx = source.getContext("2d", { willReadFrequently: true });
    const src = srcCtx.getImageData(0, 0, source.width, source.height);
    const out = makeCanvas(outW, outH);
    const outCtx = out.getContext("2d", { willReadFrequently: true });
    const dst = outCtx.createImageData(outW, outH);
    const H = homographyForQuad(quad);
    const s = src.data, d = dst.data, sw = source.width, sh = source.height;

    let di = 0;
    for (let y = 0; y < outH; y += 1) {
      const v = outH <= 1 ? 0 : y / (outH - 1);
      for (let x = 0; x < outW; x += 1) {
        const u = outW <= 1 ? 0 : x / (outW - 1);
        const z = H.g * u + H.h * v + 1;
        const sx = clamp(Math.round((H.a * u + H.b * v + H.c) / z), 0, sw - 1);
        const sy = clamp(Math.round((H.d * u + H.e * v + H.f) / z), 0, sh - 1);
        const si = (sy * sw + sx) * 4;
        let rr = s[si], gg = s[si + 1], bb = s[si + 2];
        const lum = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        const chroma = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
        rr = clamp((rr - 128) * 1.08 + 134, 0, 255);
        gg = clamp((gg - 128) * 1.08 + 134, 0, 255);
        bb = clamp((bb - 128) * 1.08 + 134, 0, 255);
        if (lum > 214 && chroma < 38) {
          rr += (255 - rr) * 0.28;
          gg += (255 - gg) * 0.28;
          bb += (255 - bb) * 0.28;
        }
        d[di++] = rr; d[di++] = gg; d[di++] = bb; d[di++] = 255;
      }
    }
    outCtx.putImageData(dst, 0, 0);
    return out;
  }

  async function scanImage(file) {
    const img = await loadImage(file);
    const source = normalizedSourceCanvas(img);
    const detection = detectDocument(source);
    const corrected = correctedCanvas(source, detection.quad);
    const blob = await canvasBlob(corrected);
    return {
      blob,
      width: corrected.width,
      height: corrected.height,
      confident: detection.confident,
      url: URL.createObjectURL(blob),
    };
  }

  function asciiBytes(text) {
    return new TextEncoder().encode(text);
  }

  function concatBytes(parts) {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  async function buildPdf(scanPages) {
    const imageBytes = await Promise.all(scanPages.map(p => p.blob.arrayBuffer().then(b => new Uint8Array(b))));
    const objectCount = 2 + scanPages.length * 3;
    const objects = new Array(objectCount + 1);
    const kids = [];
    const pageW = 595.28, pageH = 841.89, margin = 24;

    objects[1] = asciiBytes("<< /Type /Catalog /Pages 2 0 R >>");
    for (let i = 0; i < scanPages.length; i += 1) kids.push(`${3 + i * 3} 0 R`);
    objects[2] = asciiBytes(`<< /Type /Pages /Count ${scanPages.length} /Kids [${kids.join(" ")}] >>`);

    for (let i = 0; i < scanPages.length; i += 1) {
      const page = scanPages[i];
      const pageObj = 3 + i * 3, imageObj = pageObj + 1, contentObj = pageObj + 2;
      const availableW = pageW - margin * 2, availableH = pageH - margin * 2;
      const fit = Math.min(availableW / page.width, availableH / page.height);
      const drawW = page.width * fit, drawH = page.height * fit;
      const x = (pageW - drawW) / 2, y = (pageH - drawH) / 2;
      const content = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im1 Do\nQ\n`;
      const contentBytes = asciiBytes(content);
      objects[pageObj] = asciiBytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im1 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
      objects[imageObj] = concatBytes([
        asciiBytes(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes[i].length} >>\nstream\n`),
        imageBytes[i],
        asciiBytes("\nendstream"),
      ]);
      objects[contentObj] = concatBytes([
        asciiBytes(`<< /Length ${contentBytes.length} >>\nstream\n`),
        contentBytes,
        asciiBytes("endstream"),
      ]);
    }

    const chunks = [asciiBytes("%PDF-1.4\n%KRISTA-SCAN\n")];
    const offsets = new Array(objectCount + 1).fill(0);
    let position = chunks[0].length;
    for (let i = 1; i <= objectCount; i += 1) {
      offsets[i] = position;
      const chunk = concatBytes([asciiBytes(`${i} 0 obj\n`), objects[i], asciiBytes("\nendobj\n")]);
      chunks.push(chunk);
      position += chunk.length;
    }
    const xrefAt = position;
    let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objectCount; i += 1) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    chunks.push(asciiBytes(xref));
    return new Blob(chunks, { type: "application/pdf" });
  }

  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("PDF konnte nicht gelesen werden."));
      reader.readAsDataURL(blob);
    });
  }

  function clearPages() {
    while (pages.length) {
      const page = pages.pop();
      if (page?.url) URL.revokeObjectURL(page.url);
    }
    renderScanner();
  }

  function setScannerOpen(open) {
    const scanner = document.getElementById("kgInvoiceScanner");
    if (!scanner) return;
    scanner.hidden = !open;
    document.body.classList.toggle("kg-scan-open", !!open);
  }

  function statusText() {
    if (!pages.length) return "Kamera auf die Rechnung halten – Ränder werden automatisch erkannt.";
    const last = pages[pages.length - 1];
    return last.confident
      ? `Seite ${pages.length} automatisch erkannt, begradigt und optimiert.`
      : `Seite ${pages.length} optimiert. Rand nicht eindeutig – ganzes Bild verwendet.`;
  }

  function renderScanner() {
    const preview = document.getElementById("kgInvoiceScanPreview");
    const status = document.getElementById("kgInvoiceScanStatus");
    const count = document.getElementById("kgInvoiceScanCount");
    const add = document.getElementById("kgInvoiceScanAdd");
    const retry = document.getElementById("kgInvoiceScanRetry");
    const send = document.getElementById("kgInvoiceScanSend");
    if (!preview || !status || !count || !add || !retry || !send) return;
    count.textContent = pages.length ? `${pages.length} Seite${pages.length === 1 ? "" : "n"}` : "Noch keine Seite";
    status.textContent = processing ? "Dokument wird erkannt und geradegerichtet …" : statusText();
    if (processing) {
      preview.innerHTML = '<div class="kg-scan-processing"><div class="kg-scan-spinner"></div><strong>Scan wird optimiert …</strong></div>';
    } else if (pages.length) {
      const last = pages[pages.length - 1];
      preview.innerHTML = `<img src="${last.url}" alt="Scan Vorschau"><span class="kg-scan-badge">${last.confident ? "✓ Dokument erkannt" : "✓ Scan optimiert"}</span>`;
    } else {
      preview.innerHTML = '<div class="kg-scan-empty"><span>🧾</span><strong>Rechnung scannen</strong><small>Automatisch zuschneiden · geradeziehen · Kontrast verbessern</small></div>';
    }
    add.disabled = processing || pages.length >= MAX_PAGES;
    retry.disabled = processing || !pages.length;
    send.disabled = processing || !pages.length;
  }

  function openCamera() {
    if (processing) return;
    const input = document.getElementById("kgInvoiceScanInput");
    if (!input) return;
    input.value = "";
    input.click();
  }

  async function addPhoto(file) {
    if (!file || processing || pages.length >= MAX_PAGES) return;
    processing = true;
    setScannerOpen(true);
    renderScanner();
    try {
      const page = await scanImage(file);
      pages.push(page);
    } catch (error) {
      toast("Scan fehlgeschlagen: " + String(error?.message || error));
    } finally {
      processing = false;
      renderScanner();
    }
  }

  async function uploadPdf(button) {
    const id = employeeId();
    const name = employeeName();
    if (!id) { toast("Bitte zuerst den Mitarbeiter auswählen."); return; }
    if (!pages.length || processing) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "PDF wird erstellt …";
    processing = true;
    renderScanner();
    try {
      const pdf = await buildPdf(pages);
      if (pdf.size > MAX_UPLOAD) throw new Error("Der Scan ist größer als 12 MB. Bitte weniger Seiten scannen.");
      const data = await blobToDataUrl(pdf);
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
      const filename = `Rechnung_${stamp}_${pages.length}S.pdf`;
      button.textContent = "Wird abgelegt …";
      const response = await fetch(authUrl("/kristine/api/invoice-intake/import"), {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: filename,
          type: "application/pdf",
          data,
          source: "KGO Scan",
          submittedById: id,
          submittedByName: name,
          capturedAt: new Date().toISOString(),
          paymentContext: "beim Bezahlen gescannt",
          note: `Dokumentenscan · ${pages.length} Seite${pages.length === 1 ? "" : "n"} · automatische Korrektur`,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      toast(result.duplicate ? "✓ Rechnung war bereits im Eingangskorb." : `✓ ${pages.length}-seitiger Scan im Eingangskorb · ${name}`);
      setScannerOpen(false);
      clearPages();
    } catch (error) {
      toast("Rechnung konnte nicht abgelegt werden: " + String(error?.message || error));
    } finally {
      processing = false;
      button.disabled = false;
      button.textContent = original;
      renderScanner();
    }
  }

  function install() {
    if (document.getElementById("kgInvoiceScanCard")) return;
    const content = document.getElementById("kgContent");
    if (!content) return;

    const card = document.createElement("section");
    card.id = "kgInvoiceScanCard";
    card.className = "kg-invoice-scan-card";
    card.innerHTML = `
      <button id="kgInvoiceScanButton" class="kg-invoice-scan-button" type="button">
        <span class="kg-invoice-icon">🧾</span>
        <span class="kg-invoice-copy">
          <strong>Rechnung scannen</strong>
          <small>Geradeziehen · optimieren · als PDF in den Eingangskorb</small>
        </span>
        <span class="kg-invoice-arrow">›</span>
      </button>
      <input id="kgInvoiceScanInput" type="file" accept="image/*" capture="environment" hidden>
    `;

    const brain = document.getElementById("kgBrainCard");
    const greeting = document.getElementById("kgGreeting");
    if (brain?.parentElement === content) brain.insertAdjacentElement("afterend", card);
    else if (greeting?.parentElement === content) greeting.insertAdjacentElement("afterend", card);
    else content.prepend(card);

    const scanner = document.createElement("div");
    scanner.id = "kgInvoiceScanner";
    scanner.className = "kg-invoice-scanner";
    scanner.hidden = true;
    scanner.innerHTML = `
      <div class="kg-scan-panel" role="dialog" aria-modal="true" aria-label="Rechnung scannen">
        <div class="kg-scan-head">
          <div><small>KRISTINE GO</small><strong>Rechnung scannen</strong></div>
          <button id="kgInvoiceScanClose" type="button" aria-label="Schließen">×</button>
        </div>
        <div id="kgInvoiceScanPreview" class="kg-scan-preview"></div>
        <div class="kg-scan-meta"><strong id="kgInvoiceScanCount">Noch keine Seite</strong><span id="kgInvoiceScanStatus"></span></div>
        <div class="kg-scan-actions">
          <button id="kgInvoiceScanRetry" class="kg-scan-secondary" type="button">↻ Seite neu</button>
          <button id="kgInvoiceScanAdd" class="kg-scan-secondary" type="button">＋ Weitere Seite</button>
          <button id="kgInvoiceScanSend" class="kg-scan-primary" type="button">✓ Fertig & senden</button>
        </div>
      </div>
    `;
    document.body.appendChild(scanner);

    const style = document.createElement("style");
    style.textContent = `
      .kg-invoice-scan-card{margin:12px 0 18px}.kg-invoice-scan-button{width:100%;display:flex;align-items:center;gap:12px;border:1px solid rgba(16,35,63,.14);border-radius:18px;padding:14px 16px;background:#fff;color:#10233f;box-shadow:0 8px 24px rgba(16,35,63,.08);text-align:left;cursor:pointer}.kg-invoice-scan-button:disabled{opacity:.65;cursor:wait}.kg-invoice-icon{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;background:#e8f1ea;color:#1f6038;font-size:23px;flex:0 0 auto}.kg-invoice-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}.kg-invoice-copy strong{font-size:16px;line-height:1.15}.kg-invoice-copy small{font-size:12px;color:#657387}.kg-invoice-arrow{font-size:28px;line-height:1;color:#657387}
      body.kg-scan-open{overflow:hidden}.kg-invoice-scanner{position:fixed;inset:0;z-index:99999;background:rgba(7,16,28,.88);padding:max(10px,env(safe-area-inset-top)) 10px max(10px,env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center}.kg-invoice-scanner[hidden]{display:none!important}.kg-scan-panel{width:min(620px,100%);max-height:100%;overflow:auto;background:#f5f7f8;border-radius:22px;box-shadow:0 28px 80px rgba(0,0,0,.45);color:#10233f}.kg-scan-head{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px}.kg-scan-head div{display:flex;flex-direction:column;gap:2px}.kg-scan-head small{font-size:11px;color:#68778b;font-weight:800;letter-spacing:.08em}.kg-scan-head strong{font-size:21px}.kg-scan-head button{width:38px;height:38px;border:0;border-radius:12px;background:#e5e9ed;color:#10233f;font-size:25px}.kg-scan-preview{position:relative;margin:0 14px;background:#17212d;border-radius:16px;min-height:330px;display:grid;place-items:center;overflow:hidden}.kg-scan-preview img{display:block;max-width:100%;max-height:58vh;object-fit:contain;background:#fff}.kg-scan-empty,.kg-scan-processing{display:flex;flex-direction:column;align-items:center;gap:8px;color:#fff;text-align:center;padding:34px}.kg-scan-empty>span{font-size:46px}.kg-scan-empty small{color:#b8c3cf;line-height:1.35}.kg-scan-badge{position:absolute;left:10px;bottom:10px;background:rgba(24,96,57,.94);color:#fff;padding:7px 10px;border-radius:999px;font-size:11px;font-weight:800}.kg-scan-spinner{width:34px;height:34px;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:kgScanSpin .8s linear infinite}@keyframes kgScanSpin{to{transform:rotate(360deg)}}.kg-scan-meta{padding:12px 16px;display:flex;flex-direction:column;gap:3px}.kg-scan-meta strong{font-size:14px}.kg-scan-meta span{font-size:12px;color:#667589;line-height:1.35}.kg-scan-actions{padding:0 14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.kg-scan-actions button{min-height:46px;border-radius:12px;font-weight:850;font-size:13px}.kg-scan-secondary{background:#fff;color:#10233f;border:1px solid #cfd6de}.kg-scan-primary{grid-column:1/-1;background:#2f7d4a;color:#fff;border:1px solid #2f7d4a}.kg-scan-actions button:disabled{opacity:.45}.kg-scan-primary:not(:disabled){box-shadow:0 8px 18px rgba(47,125,74,.22)}
      @media(max-width:520px){.kg-invoice-scanner{padding-left:0;padding-right:0;align-items:flex-end}.kg-scan-panel{border-radius:22px 22px 0 0}.kg-scan-preview{min-height:300px}.kg-scan-preview img{max-height:52vh}}
    `;
    document.head.appendChild(style);

    const button = document.getElementById("kgInvoiceScanButton");
    const input = document.getElementById("kgInvoiceScanInput");
    const close = document.getElementById("kgInvoiceScanClose");
    const add = document.getElementById("kgInvoiceScanAdd");
    const retry = document.getElementById("kgInvoiceScanRetry");
    const send = document.getElementById("kgInvoiceScanSend");

    button?.addEventListener("click", () => {
      if (!employeeId()) { toast("Bitte zuerst den Mitarbeiter auswählen."); return; }
      clearPages();
      setScannerOpen(true);
      openCamera();
    });
    close?.addEventListener("click", () => { if (!processing) { setScannerOpen(false); clearPages(); } });
    scanner.addEventListener("click", event => { if (event.target === scanner && !processing) { setScannerOpen(false); clearPages(); } });
    add?.addEventListener("click", openCamera);
    retry?.addEventListener("click", () => {
      const last = pages.pop();
      if (last?.url) URL.revokeObjectURL(last.url);
      renderScanner();
      openCamera();
    });
    send?.addEventListener("click", () => uploadPdf(send));
    input?.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (file) await addPhoto(file);
    });
    renderScanner();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
