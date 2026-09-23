/* KRISTINE Farben: Vergleichsleiste + Rezeptvergleich */
(function () {
  'use strict';
  var host = document.getElementById('tab-search');
  var detailEl = document.getElementById('detail');
  if (!host || !detailEl) return;

  var STORE_KEY = 'kristine.paintCompare.v1';
  var items = [];
  var enhanceRevision = 0;

  function e(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function rgb(v) {
    if (!Array.isArray(v) || v.length < 3) return '';
    var a = v.slice(0,3).map(Number);
    if (a.some(function (n) { return !Number.isFinite(n); })) return '';
    return 'rgb(' + a.map(function (n) { return Math.max(0, Math.min(255, Math.round(n))); }).join(',') + ')';
  }
  function swatch(item) {
    var c = rgb(item && item.color && item.color.rgb);
    return c ? 'background:' + c : 'background:linear-gradient(135deg,#e7e8e3,#c9cbc4)';
  }
  function makeKey(color, product, size) {
    return [color && (color.system || system), color && color.id, product && product.productId, size && size.canSizeId].join('|');
  }
  function save() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(items)); } catch (_) {}
  }
  function restore() {
    try {
      var x = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]');
      if (Array.isArray(x)) items = x.filter(Boolean);
    } catch (_) {}
  }

  var style = document.createElement('style');
  style.textContent =
    '.paintCompareBar{position:sticky;top:8px;z-index:9;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;margin-bottom:14px;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 6px 20px #00000010}' +
    '.paintCompareLeft{display:flex;align-items:center;gap:10px;min-width:0;flex:1}.paintCompareTitle{font-weight:850;white-space:nowrap}.paintCompareChips{display:flex;gap:7px;overflow:auto;min-width:0;padding:2px}' +
    '.paintCompareChip{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:5px 8px 5px 5px;background:#f7f8f5;white-space:nowrap;font-size:12px}.paintCompareDot{width:24px;height:24px;border-radius:50%;border:1px solid #0002;flex:0 0 auto}.paintCompareChip button{border:0;background:transparent;cursor:pointer;font-size:16px;line-height:1;color:#666}.paintCompareActions{display:flex;gap:7px;flex:0 0 auto}.compareAddBtn.inCompare{background:var(--accent);color:#fff}' +
    '.paintCompareModal{position:fixed;inset:0;background:#0008;display:none;align-items:center;justify-content:center;padding:18px;z-index:40}.paintCompareModal.show{display:flex}.paintCompareModalCard{background:#fff;border-radius:18px;width:min(1280px,100%);max-height:92vh;overflow:auto;padding:18px}.paintCompareModalHead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;position:sticky;top:-18px;background:#fff;padding:18px 0 12px;z-index:2;border-bottom:1px solid var(--line)}' +
    '.paintCompareWarning{background:#fff4d8;border:1px solid #e7b84d;border-radius:10px;padding:9px 11px;margin:12px 0;font-size:13px}.paintCompareGrid{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(280px,1fr);gap:12px;overflow-x:auto;padding:4px 2px 10px}.paintCompareCard{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#fff;min-width:280px}.paintCompareSwatch{height:130px;border-bottom:1px solid var(--line)}.paintCompareBody{padding:12px}.paintCompareName{font-size:20px;font-weight:850}.paintCompareMeta{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.45}.paintCompareRecipe{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}.paintCompareRecipe th,.paintCompareRecipe td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}.paintCompareRecipe th:nth-child(n+2),.paintCompareRecipe td:nth-child(n+2){text-align:right}.paintCompareCalibration{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.4}.paintCompareRemove{margin-top:10px;width:100%}' +
    '@media(max-width:750px){.paintCompareBar{top:4px;align-items:flex-start;flex-direction:column}.paintCompareActions{width:100%}.paintCompareActions .btn{flex:1}.paintCompareTitle{font-size:13px}.paintCompareGrid{grid-auto-columns:minmax(245px,82vw)}}';
  document.head.appendChild(style);

  var bar = document.createElement('div');
  bar.className = 'paintCompareBar';
  bar.innerHTML = '<div class="paintCompareLeft"><div class="paintCompareTitle">Farben vergleichen <span id="paintCompareCount">(0)</span></div><div class="paintCompareChips" id="paintCompareChips"><span class="muted">Noch keine Farbe gewählt</span></div></div><div class="paintCompareActions"><button class="btn" id="paintCompareClear" disabled>Leeren</button><button class="btn primary" id="paintCompareOpen" disabled>Vergleich öffnen</button></div>';
  host.insertBefore(bar, detailEl);

  var modal = document.createElement('div');
  modal.className = 'paintCompareModal';
  modal.innerHTML = '<div class="paintCompareModalCard"><div class="paintCompareModalHead"><div><h2 style="margin:0">Farben vergleichen</h2><div class="muted">Farbwirkung oben · Rezept direkt darunter</div></div><button class="btn" id="paintCompareClose">Schließen</button></div><div id="paintCompareWarning"></div><div class="paintCompareGrid" id="paintCompareGrid"></div></div>';
  document.body.appendChild(modal);

  var countEl = document.getElementById('paintCompareCount');
  var chipsEl = document.getElementById('paintCompareChips');
  var clearBtn = document.getElementById('paintCompareClear');
  var openBtn = document.getElementById('paintCompareOpen');
  var closeBtn = document.getElementById('paintCompareClose');
  var gridEl = document.getElementById('paintCompareGrid');
  var warningEl = document.getElementById('paintCompareWarning');

  function renderBar() {
    countEl.textContent = '(' + items.length + ')';
    clearBtn.disabled = !items.length;
    openBtn.disabled = !items.length;
    if (!items.length) {
      chipsEl.innerHTML = '<span class="muted">Noch keine Farbe gewählt</span>';
    } else {
      chipsEl.innerHTML = items.map(function (item) {
        return '<span class="paintCompareChip"><span class="paintCompareDot" style="' + swatch(item) + '"></span><span>' + e(item.color.name || item.color.code || 'Farbe') + '</span><button type="button" title="Aus Vergleich entfernen" data-remove-compare="' + e(item.key) + '">×</button></span>';
      }).join('');
    }
    document.querySelectorAll('.compareAddBtn[data-compare-key]').forEach(function (button) {
      var active = items.some(function (item) { return item.key === button.dataset.compareKey; });
      button.classList.toggle('inCompare', active);
      button.textContent = active ? 'Im Vergleich ✓' : '+ Vergleich';
    });
  }

  function removeItem(key) {
    items = items.filter(function (item) { return item.key !== key; });
    save(); renderBar();
    if (modal.classList.contains('show')) renderModal();
  }

  chipsEl.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-remove-compare]');
    if (b) removeItem(b.dataset.removeCompare);
  });
  clearBtn.addEventListener('click', function () {
    items = []; save(); renderBar();
    if (modal.classList.contains('show')) renderModal();
  });

  function signature(item) {
    return (item.product.productName || '') + '|' + ((item.recipe && item.recipe.baseName) || item.product.baseName || '') + '|' + ((item.recipe && item.recipe.canSize) || item.size.size || '');
  }

  function recipeTable(item) {
    if (!(item.recipe && item.recipe.recipe && item.recipe.recipe.length)) {
      return '<p class="muted">' + e(item.error || 'Rezept wird geladen …') + '</p>';
    }
    return '<table class="paintCompareRecipe"><thead><tr><th>Paste</th><th>Einheiten</th><th>ml</th></tr></thead><tbody>' +
      item.recipe.recipe.map(function (r) {
        return '<tr><td><b>' + e(r.code) + '</b> ' + e(r.description || '') + '</td><td>' + Number(r.machineUnits == null ? 0 : r.machineUnits).toFixed(2) + '</td><td>' + Number(r.ml == null ? 0 : r.ml).toFixed(2) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderModal() {
    if (!items.length) {
      warningEl.innerHTML = '';
      gridEl.innerHTML = '<p class="muted">Noch keine Farben im Vergleich.</p>';
      return;
    }
    var sig = new Set(items.map(signature));
    warningEl.innerHTML = sig.size > 1 ? '<div class="paintCompareWarning"><b>Achtung:</b> Produkt, Basis oder Gebinde sind nicht bei allen Farben identisch. Die Rezepte bleiben sichtbar, sind aber technisch nur eingeschränkt direkt vergleichbar.</div>' : '';
    gridEl.innerHTML = items.map(function (item) {
      var r = item.recipe;
      var calibration = r ? '<div class="paintCompareCalibration">Formel ' + e(r.formulaId) + ' · 1 Einheit ≈ ' + Number(r.recipeUnitMl || 0).toFixed(5) + ' ml' + (r.calibrationNote ? '<br>' + e(r.calibrationNote) : '') + '</div>' : '';
      return '<article class="paintCompareCard"><div class="paintCompareSwatch" style="' + swatch(item) + '"></div><div class="paintCompareBody"><div class="paintCompareName">' + e(item.color.name || item.color.code || 'Farbe') + '</div><div class="paintCompareMeta">' + e(item.color.system || '') + (item.color.code ? ' · ' + e(item.color.code) : '') + '<br><b>' + e(item.product.productName || '') + '</b><br>' + e((r && r.baseName) || item.product.baseName || '') + ' · ' + e((r && r.canSize) || item.size.size || '') + '</div>' + recipeTable(item) + calibration + '<button class="btn paintCompareRemove" type="button" data-modal-remove="' + e(item.key) + '">Aus Vergleich entfernen</button></div></article>';
    }).join('');
  }

  openBtn.addEventListener('click', function () { renderModal(); modal.classList.add('show'); });
  closeBtn.addEventListener('click', function () { modal.classList.remove('show'); });
  modal.addEventListener('click', function (ev) {
    if (ev.target === modal) modal.classList.remove('show');
    var b = ev.target.closest('[data-modal-remove]');
    if (b) removeItem(b.dataset.modalRemove);
  });

  async function addItem(color, product, size) {
    var key = makeKey(color, product, size);
    if (items.some(function (item) { return item.key === key; })) {
      removeItem(key);
      return;
    }
    var item = {
      key: key,
      color: {id:color.id, system:color.system || system, name:color.name || color.code || '', code:color.code || '', rgb:color.rgb || null},
      product: {productId:product.productId, productName:product.productName || '', baseName:product.baseName || product.baseCode || ''},
      size: {canSizeId:size.canSizeId, size:size.size || ''},
      recipe: null,
      error: ''
    };
    items.push(item); save(); renderBar();
    try {
      item.recipe = await api('/admin/api/paint/recipe?colourId=' + encodeURIComponent(color.id) + '&productId=' + encodeURIComponent(product.productId) + '&canSizeId=' + encodeURIComponent(size.canSizeId));
    } catch (err) {
      item.error = (err && err.message) || 'Rezept konnte nicht geladen werden.';
    }
    save(); renderBar();
    if (modal.classList.contains('show')) renderModal();
  }

  function preferredSize(sizes) {
    var valid = (sizes || []).filter(function (s) { return s && s.canSizeId; });
    return valid.find(function (s) { return /^5\s*l$/i.test(String(s.size || '').trim()); }) ||
           valid.find(function (s) { return /^1\s*l$/i.test(String(s.size || '').trim()); }) ||
           valid[0] || null;
  }

  async function enhanceDetail() {
    var rev = ++enhanceRevision;
    var current = selected;
    if (!current || detailEl.classList.contains('hidden')) return;
    try {
      var data = await api('/admin/api/paint/color/' + encodeURIComponent(current.id) + '?system=' + encodeURIComponent(system));
      if (rev !== enhanceRevision || selected !== current) return;
      var rows = Array.prototype.slice.call(detailEl.querySelectorAll('.product'));
      rows.forEach(function (row, index) {
        if (row.querySelector('.compareAddBtn')) return;
        var product = data.products && data.products[index];
        var size = preferredSize(product && product.sizes);
        if (!(product && product.recipeAvailable && size)) return;
        var head = row.querySelector('.prodhead');
        if (!head) return;
        var button = document.createElement('button');
        var key = makeKey(data.color, product, size);
        button.type = 'button';
        button.className = 'recipeBtn compareAddBtn';
        button.dataset.compareKey = key;
        button.title = 'Vergleich mit ' + size.size;
        button.textContent = items.some(function (item) { return item.key === key; }) ? 'Im Vergleich ✓' : '+ Vergleich';
        if (items.some(function (item) { return item.key === key; })) button.classList.add('inCompare');
        button.addEventListener('click', function (ev) {
          ev.preventDefault(); ev.stopPropagation(); addItem(data.color, product, size);
        });
        head.appendChild(button);
      });
      renderBar();
    } catch (_) {}
  }

  var observer = new MutationObserver(function () {
    if (!detailEl.classList.contains('hidden')) Promise.resolve().then(enhanceDetail);
  });
  observer.observe(detailEl, {childList:true, subtree:true});
  restore();
  renderBar();
  if (!detailEl.classList.contains('hidden')) enhanceDetail();
})();