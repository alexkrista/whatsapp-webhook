# coding: utf-8
"""The Brain · Materialhistorie / Preisentwicklung aus bestehenden Materialtreffern.

Bewusst konservativ: Nur klar erkennbare Einzelpreise fließen in die Preisstatistik ein.
Unsichere Zeilen bleiben sichtbar und verlinken weiterhin auf die Originalrechnung.
"""
from __future__ import annotations

import re

_PRICE_NUM = r"(?:\d{1,3}(?:[.\s]\d{3})*|\d+)[,.]\d{2}"
_UNIT = r"(?:stk|st\.?|kg|g|l|lt|liter|m|lfm|m2|m²|m3|m³|rolle|gebinde|dose|eimer)"


def _money_number(raw):
    s = str(raw or "").strip().replace(" ", "")
    if not s:
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        value = float(s)
        return value if 0 < value < 100000 else None
    except Exception:
        return None


def _clean_line(value):
    return " ".join(str(value or "").replace("\u00a0", " ").split())[:500]


def _price_from_line(line):
    text = _clean_line(line)
    if not text:
        return {"price": None, "unit": "", "quantity": None, "confidence": "none", "kind": ""}

    patterns = [
        rf"(?P<price>{_PRICE_NUM})\s*(?:€|eur)?\s*(?:/|je\s+)\s*(?P<unit>{_UNIT})\b",
        rf"(?:€|eur)\s*(?P<price>{_PRICE_NUM})\s*(?:/|je\s+)\s*(?P<unit>{_UNIT})\b",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.I)
        if m:
            price = _money_number(m.group("price"))
            if price is not None:
                return {"price": price, "unit": m.group("unit"), "quantity": None, "confidence": "high", "kind": "Einzelpreis"}

    m = re.search(
        rf"(?P<qty>\d+(?:[,.]\d{{1,3}})?)\s*(?P<unit>{_UNIT})\b.{0,26}?(?P<unitprice>{_PRICE_NUM})\s+(?P<total>{_PRICE_NUM})(?:\s|$)",
        text,
        re.I,
    )
    if m:
        price = _money_number(m.group("unitprice"))
        total = _money_number(m.group("total"))
        qty_raw = str(m.group("qty") or "").replace(",", ".")
        try:
            qty = float(qty_raw)
        except Exception:
            qty = None
        if price is not None and total is not None and total + 0.02 >= price:
            return {"price": price, "unit": m.group("unit"), "quantity": qty, "confidence": "high", "kind": "Einzelpreis"}

    currency_hits = list(re.finditer(rf"(?P<price>{_PRICE_NUM})\s*(?:€|eur)\b|(?:€|eur)\s*(?P<price2>{_PRICE_NUM})", text, re.I))
    if len(currency_hits) == 1:
        raw = currency_hits[0].group("price") or currency_hits[0].group("price2")
        price = _money_number(raw)
        if price is not None:
            return {"price": price, "unit": "", "quantity": None, "confidence": "medium", "kind": "Betrag in Zeile"}

    return {"price": None, "unit": "", "quantity": None, "confidence": "none", "kind": ""}


def _history(ns, query, limit=140):
    search = ns.get("global_material_search")
    if not callable(search):
        raise RuntimeError("Materialsuche ist nicht verfügbar.")
    data = search(query, limit)
    rows = []
    seen = set()
    for hit in data.get("results") or []:
        if str(hit.get("matchType") or "") == "similar":
            continue
        for line in hit.get("materialMatches") or []:
            line = _clean_line(line)
            if not line:
                continue
            key = (str(hit.get("path") or ""), line)
            if key in seen:
                continue
            seen.add(key)
            parsed = _price_from_line(line)
            rows.append({
                "date": hit.get("invoiceDate") or "",
                "supplier": hit.get("supplierName") or "Lieferant nicht sicher erkannt",
                "material": line,
                "price": parsed["price"],
                "unit": parsed["unit"],
                "quantity": parsed["quantity"],
                "confidence": parsed["confidence"],
                "priceKind": parsed["kind"],
                "path": hit.get("path") or "",
                "matchType": hit.get("matchType") or "",
            })

    rows.sort(key=lambda r: str(r.get("date") or ""), reverse=True)
    reliable = [r for r in rows if r.get("confidence") == "high" and r.get("price") is not None]
    reliable_oldest = sorted(reliable, key=lambda r: str(r.get("date") or ""))
    prices = [float(r["price"]) for r in reliable_oldest]
    last = reliable[0] if reliable else None
    previous = reliable[1] if len(reliable) > 1 else None
    change = None
    if last and previous and float(previous.get("price") or 0) > 0:
        change = round((float(last["price"]) / float(previous["price"]) - 1) * 100, 2)

    return {
        "query": str(query or "").strip(),
        "rows": rows,
        "rowCount": len(rows),
        "reliableCount": len(reliable),
        "lastPrice": last.get("price") if last else None,
        "lastUnit": last.get("unit") if last else "",
        "previousPrice": previous.get("price") if previous else None,
        "changePercent": change,
        "minPrice": min(prices) if prices else None,
        "maxPrice": max(prices) if prices else None,
        "series": [{"date": r.get("date") or "", "price": r.get("price")} for r in reliable_oldest[-24:]],
        "scanned": data.get("scanned") or 0,
    }


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    app = ns.get("app")
    if not page or app is None:
        return

    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.add("/material-history")

    if "brain_material_history_api" not in app.view_functions:
        from flask import request, jsonify

        @app.get("/material-history")
        def brain_material_history_api():
            q = str(request.args.get("q") or "").strip()
            if len(q) < 2:
                return jsonify({"ok": False, "error": "Bitte mindestens 2 Zeichen eingeben."}), 400
            try:
                return jsonify({"ok": True, **_history(ns, q)})
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

    if "kristaMaterialHistoryV2" in page:
        ns["MOBILE_PAGE"] = page
        return

    panel = r'''
    <section id="materialHistoryPanel" class="material-history-panel" hidden>
      <div class="material-history-head">
        <div><strong>Materialhistorie</strong><div id="materialHistoryMeta" class="sub">Preisverlauf aus sicheren Rechnungszeilen</div></div>
        <button id="materialHistoryCsv" type="button">CSV / Excel</button>
      </div>
      <div class="material-history-filterbar">
        <div id="materialHistorySuppliers" class="material-history-suppliers" aria-label="Lieferant filtern"></div>
        <div id="materialHistorySort" class="material-history-sort" aria-label="Materialhistorie sortieren">
          <button type="button" class="active" data-history-sort="date-desc">Datum ↓</button>
          <button type="button" data-history-sort="price-asc">Preis ↑</button>
          <button type="button" data-history-sort="price-desc">Preis ↓</button>
          <button type="button" data-history-sort="supplier">Lieferant</button>
        </div>
      </div>
      <div id="materialHistoryKpis" class="material-history-kpis"></div>
      <div id="materialHistoryChart" class="material-history-chart"></div>
      <div class="material-history-table-wrap"><table class="material-history-table"><thead><tr><th>Datum</th><th>Lieferant</th><th>Material / Rechnungszeile</th><th>Menge</th><th>Preis</th><th>Sicherheit</th><th></th></tr></thead><tbody id="materialHistoryBody"></tbody></table></div>
    </section>
'''

    css = r'''
.material-history-panel{margin:12px 0 18px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
.material-history-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.material-history-head strong{font-size:17px}
.material-history-filterbar{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin:11px 0 2px;flex-wrap:wrap}
.material-history-suppliers{display:flex;gap:6px;align-items:center;overflow-x:auto;max-width:100%;padding:1px 1px 5px;scrollbar-width:thin}
.material-history-chip,.material-history-sort button{border:1px solid var(--line);background:rgba(127,127,127,.06);color:inherit;border-radius:999px;padding:6px 9px;font-size:11px;font-weight:800;white-space:nowrap;cursor:pointer;height:auto;min-height:30px}
.material-history-chip.active,.material-history-sort button.active{background:#fff;color:#111;border-color:#fff}
.material-history-chip small{font-size:10px;font-weight:650;opacity:.72;margin-left:4px}.material-history-chip .chip-price{font-weight:900;opacity:1}
.material-history-sort{display:flex;gap:5px;flex-wrap:wrap}.material-history-sort button{border-radius:9px}
.material-history-kpis{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:8px;margin:12px 0}.material-history-kpi{padding:10px;border:1px solid var(--line);border-radius:11px;background:rgba(127,127,127,.07)}
.material-history-kpi small{display:block;color:var(--muted);margin-bottom:3px}.material-history-kpi strong{font-size:16px}.material-history-chart{height:76px;margin:8px 0 12px;border-radius:10px;background:rgba(127,127,127,.06);overflow:hidden}
.material-history-chart svg{width:100%;height:100%;display:block}.material-history-table-wrap{overflow:auto}.material-history-table{width:100%;border-collapse:collapse;font-size:12px}.material-history-table th,.material-history-table td{padding:8px 9px;border-top:1px solid var(--line);text-align:left;vertical-align:top}.material-history-table th{white-space:nowrap;color:var(--muted)}
.material-history-price{font-weight:900;white-space:nowrap}.material-history-confidence{display:inline-flex;padding:3px 7px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}.material-history-confidence.high{font-weight:850}.material-history-confidence.none{opacity:.55}.material-history-material{min-width:260px;max-width:620px}.material-history-note{font-size:11px;color:var(--muted)}
@media(max-width:900px){.material-history-filterbar{display:block}.material-history-suppliers{width:100%;flex-wrap:nowrap}.material-history-sort{margin-top:6px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px}.material-history-kpis{grid-template-columns:1fr 1fr}.material-history-table{min-width:850px}}
'''

    script = r'''
<script id="kristaMaterialHistoryV2">
(function(){
  const q=document.getElementById('materialQ'),go=document.getElementById('materialGo');
  const panel=document.getElementById('materialHistoryPanel'),meta=document.getElementById('materialHistoryMeta'),kpis=document.getElementById('materialHistoryKpis'),body=document.getElementById('materialHistoryBody'),chart=document.getElementById('materialHistoryChart'),csv=document.getElementById('materialHistoryCsv'),suppliers=document.getElementById('materialHistorySuppliers'),sortBar=document.getElementById('materialHistorySort');
  if(!q||!go||!panel||!body)return;
  let allRows=[],current=[],supplierFilter='__all__',sortMode='date-desc';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>n===null||n===undefined?'–':new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(n));
  const date=s=>{const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]+'.'+m[1]:'–'};
  const unit=u=>String(u||'').replace(/^st\.?$/i,'Stk');
  const reliable=r=>r&&r.confidence==='high'&&r.price!==null&&r.price!==undefined&&Number.isFinite(Number(r.price));
  function spark(series){
    if(!Array.isArray(series)||series.length<2)return '<div class="material-history-note" style="padding:22px 10px">Für einen Preisverlauf brauchen wir mindestens zwei sichere Einzelpreise.</div>';
    const vals=series.map(x=>Number(x.price)).filter(Number.isFinite),min=Math.min(...vals),max=Math.max(...vals),span=Math.max(.01,max-min),w=900,h=70,p=8;
    const pts=series.map((x,i)=>{const xx=p+(w-2*p)*(i/Math.max(1,series.length-1)),yy=h-p-(h-2*p)*((Number(x.price)-min)/span);return xx.toFixed(1)+','+yy.toFixed(1)}).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Preisverlauf"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2.2" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function supplierStats(){
    const map=new Map();
    allRows.forEach(r=>{const name=String(r.supplier||'Lieferant nicht sicher erkannt');let x=map.get(name);if(!x){x={name,count:0,last:null};map.set(name,x)}x.count++;if(reliable(r)&&(!x.last||String(r.date||'')>String(x.last.date||'')))x.last=r});
    return [...map.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'de',{sensitivity:'base'}));
  }
  function renderSupplierChips(){
    const stats=supplierStats();
    suppliers.innerHTML=`<button type="button" class="material-history-chip ${supplierFilter==='__all__'?'active':''}" data-history-supplier="__all__">Alle <small>${allRows.length}</small></button>`+stats.map(s=>`<button type="button" class="material-history-chip ${supplierFilter===s.name?'active':''}" data-history-supplier="${esc(s.name)}" title="${esc(s.name)}">${esc(s.name)} <small>${s.count}</small>${s.last?` <small class="chip-price">· ${esc(money(s.last.price))}${s.last.unit?' / '+esc(unit(s.last.unit)):''}</small>`:''}</button>`).join('');
    suppliers.querySelectorAll('[data-history-supplier]').forEach(b=>b.addEventListener('click',()=>{supplierFilter=b.dataset.historySupplier||'__all__';renderView()}));
  }
  function visibleRows(){
    let rows=supplierFilter==='__all__'?[...allRows]:allRows.filter(r=>String(r.supplier||'Lieferant nicht sicher erkannt')===supplierFilter);
    if(sortMode==='price-asc')rows.sort((a,b)=>{const ap=reliable(a)?Number(a.price):Number.POSITIVE_INFINITY,bp=reliable(b)?Number(b.price):Number.POSITIVE_INFINITY;return ap-bp||String(b.date||'').localeCompare(String(a.date||''))});
    else if(sortMode==='price-desc')rows.sort((a,b)=>{const ap=reliable(a)?Number(a.price):Number.NEGATIVE_INFINITY,bp=reliable(b)?Number(b.price):Number.NEGATIVE_INFINITY;return bp-ap||String(b.date||'').localeCompare(String(a.date||''))});
    else if(sortMode==='supplier')rows.sort((a,b)=>String(a.supplier||'').localeCompare(String(b.supplier||''),'de',{sensitivity:'base'})||String(b.date||'').localeCompare(String(a.date||'')));
    else rows.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||String(a.supplier||'').localeCompare(String(b.supplier||''),'de',{sensitivity:'base'}));
    return rows;
  }
  function summary(rows){
    const rel=rows.filter(reliable).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    const oldest=[...rel].sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
    const prices=oldest.map(r=>Number(r.price));const last=rel[0]||null,previous=rel[1]||null;
    let change=null;if(last&&previous&&Number(previous.price)>0)change=(Number(last.price)/Number(previous.price)-1)*100;
    return {reliable:rel,last,previous,change,min:prices.length?Math.min(...prices):null,max:prices.length?Math.max(...prices):null,series:oldest.slice(-24).map(r=>({date:r.date,price:r.price}))};
  }
  function renderView(){
    current=visibleRows();const s=summary(current);panel.hidden=false;renderSupplierChips();
    sortBar.querySelectorAll('[data-history-sort]').forEach(b=>b.classList.toggle('active',b.dataset.historySort===sortMode));
    const scope=supplierFilter==='__all__'?'alle Lieferanten':supplierFilter;
    meta.textContent=`${current.length} von ${allRows.length} Materialzeilen · ${s.reliable.length} sichere Einzelpreise · ${scope}`;
    const change=s.change===null?'–':(Number(s.change)>0?'+':'')+Number(s.change).toFixed(1)+' %';
    kpis.innerHTML=`<div class="material-history-kpi"><small>Letzter sicherer Preis</small><strong>${esc(money(s.last?.price))}${s.last?.unit?' / '+esc(unit(s.last.unit)):''}</strong></div><div class="material-history-kpi"><small>Davor</small><strong>${esc(money(s.previous?.price))}</strong></div><div class="material-history-kpi"><small>Veränderung</small><strong>${esc(change)}</strong></div><div class="material-history-kpi"><small>Günstigster</small><strong>${esc(money(s.min))}</strong></div><div class="material-history-kpi"><small>Teuerster</small><strong>${esc(money(s.max))}</strong></div>`;
    chart.innerHTML=spark(s.series);
    body.innerHTML=current.length?current.map(r=>{const conf=r.confidence==='high'?'✓ sicher':r.confidence==='medium'?'~ prüfen':'? kein Preis';const qty=r.quantity!==null&&r.quantity!==undefined?String(r.quantity).replace('.',',')+(r.unit?' '+unit(r.unit):''):'–';const price=r.price!==null&&r.price!==undefined?money(r.price)+(r.confidence==='high'&&r.unit?' / '+unit(r.unit):''): '–';return `<tr><td>${esc(date(r.date))}</td><td>${esc(r.supplier)}</td><td class="material-history-material">${esc(r.material)}${r.priceKind?`<div class="material-history-note">${esc(r.priceKind)}</div>`:''}</td><td>${esc(qty)}</td><td class="material-history-price">${esc(price)}</td><td><span class="material-history-confidence ${esc(r.confidence)}">${esc(conf)}</span></td><td>${r.path?`<a class="action" href="/pdf?path=${encodeURIComponent(r.path)}">Rechnung</a>`:''}</td></tr>`}).join(''):'<tr><td colspan="7">Für diesen Lieferanten keine Materialzeilen gefunden.</td></tr>';
  }
  async function load(){
    const query=String(q.value||'').trim();if(query.length<2){panel.hidden=true;return}
    panel.hidden=false;meta.textContent='Materialhistorie wird aufgebaut …';kpis.innerHTML='';chart.innerHTML='';suppliers.innerHTML='';body.innerHTML='<tr><td colspan="7">Rechnungszeilen werden geprüft …</td></tr>';
    try{const r=await fetch('/material-history?q='+encodeURIComponent(query),{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Materialhistorie fehlgeschlagen');allRows=Array.isArray(d.rows)?d.rows:[];supplierFilter='__all__';sortMode='date-desc';renderView()}catch(e){meta.textContent=e.message;body.innerHTML='<tr><td colspan="7">Materialhistorie konnte nicht geladen werden.</td></tr>'}
  }
  go.addEventListener('click',()=>setTimeout(load,20));q.addEventListener('keydown',e=>{if(e.key==='Enter')setTimeout(load,20)});
  sortBar.querySelectorAll('[data-history-sort]').forEach(b=>b.addEventListener('click',()=>{sortMode=b.dataset.historySort||'date-desc';renderView()}));
  csv?.addEventListener('click',()=>{if(!current.length)return;const sep=';';const lines=[['Datum','Lieferant','Material','Menge','Einheit','Preis','Sicherheit','Rechnung'].join(sep),...current.map(r=>[r.date||'',r.supplier||'',r.material||'',r.quantity??'',r.unit||'',r.price??'',r.confidence||'',r.path||''].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(sep))];const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='Materialhistorie_'+String(q.value||'Material').replace(/[^a-z0-9äöüß_-]+/gi,'_')+(supplierFilter==='__all__'?'':'_'+supplierFilter.replace(/[^a-z0-9äöüß_-]+/gi,'_'))+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)});
})();
</script>
'''

    marker = '<div id="materialResults" class="material-global-results"></div>'
    if marker in page:
        page = page.replace(marker, panel + "\n" + marker, 1)
    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain Materialhistorie V2 aktiv: Lieferantenfilter + Sortierung + Preisentwicklung + CSV")
