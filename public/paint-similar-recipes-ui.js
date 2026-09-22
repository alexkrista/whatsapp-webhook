/* Similarity search stays inside Brain > Farben and only uses read-only endpoints. */
(() => {
  'use strict';
  const host = document.getElementById('tab-search');
  if (!host) return;
  const panel = document.createElement('div');
  panel.className = 'card';
  panel.id = 'similar-recipes';
  panel.innerHTML = `<h2>Ähnliche Rezepte</h2>
    <form id="similar-form"><label for="similar-query">Referenzfarbton</label>
    <div class="searchbox"><input id="similar-query" placeholder="z. B. NCS 2050Y20R" required maxlength="120"><button class="btn primary" type="submit">Referenz suchen</button></div></form>
    <div id="similar-options" hidden><label for="similar-reference">Farbton · Produktvariante · Basis · Gebinde</label><select class="field" id="similar-reference"></select>
    <label for="similar-threshold">Treffer bis</label><select class="field" id="similar-threshold"><option value="1">1 % · dieselben Mischfarben</option><option value="3">3 % · höchstens eine zusätzliche Mischfarbe</option><option value="5" selected>5 % · höchstens eine zusätzliche oder ersetzte Mischfarbe</option></select>
    <button class="btn primary" id="similar-run" type="button" style="margin-top:10px">Ähnliche Rezepte suchen</button></div>
    <details style="margin:12px 0"><summary>Wie wird verglichen?</summary><p>Nur aktuelle Rezepte derselben Produktvariante, Basis und Gebinde-ID. Jede Rezeptur wird auf 100 % ihrer gesamten Mischfarbenmenge normiert. Die Abweichung ist die halbe Summe der absoluten Anteilsdifferenzen. Gleiches Mischverhältnis ergibt daher auch bei unterschiedlicher Gesamtmenge 0 %.</p><p>1 %: identische Mischfarben. 3 %: alle Referenzfarben bleiben erhalten, höchstens eine zusätzliche Paste mit maximal 3 % Anteil. 5 %: höchstens eine zusätzliche und eine entfallende Paste, jeweils maximal 5 % Anteil. Die Gesamtabweichung muss ebenfalls innerhalb der gewählten Grenze liegen. Engere Klassen sind eingeschlossen. Das ist Rezeptähnlichkeit, keine gemessene Farbgleichheit.</p></details>
    <div id="similar-status" class="status" role="status" aria-live="polite"></div><div id="similar-results"></div>`;
  host.appendChild(panel);
  const get = id => panel.querySelector('#similar-' + id);
  const esc = text => String(text ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = n => Number(n).toLocaleString('de-DE',{maximumFractionDigits:4});
  const api = async params => {
    const token = new URLSearchParams(location.search).get('token');
    const response = await fetch('/admin/api/paint/similar-recipes?' + new URLSearchParams(params), {headers: token ? {'x-admin-token':token} : {}});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Suche fehlgeschlagen.');
    return data;
  };
  let references = [], revision = 0;
  const invalidate = () => { revision++; get('results').replaceChildren(); get('status').textContent=''; get('run').disabled=false; };
  get('query').addEventListener('input', () => { invalidate(); references=[]; get('options').hidden=true; });
  get('reference').addEventListener('change', invalidate);
  get('threshold').addEventListener('change', invalidate);
  get('form').addEventListener('submit', async event => {
    event.preventDefault(); invalidate(); const current=revision;
    get('options').hidden=true; get('status').textContent='Referenz wird gesucht …';
    try {
      const data=await api({q:get('query').value.trim()});
      if (current!==revision) return;
      references=data.references;
      get('reference').replaceChildren(...references.map((r,i)=>new Option(`${r.name} · ${r.productName} · ${r.baseCode} · ${r.canSize}`,String(i))));
      const preferred=references.findIndex(r=>/absolut[e]? matt/i.test(r.productName) && /^1\s*l$/i.test(r.canSize));
      if(preferred>=0) get('reference').value=String(preferred);
      get('options').hidden=!references.length;
      get('status').textContent=references.length ? 'Referenz prüfen und Suche starten.' : 'Keine aktuelle, auswertbare Rezeptur gefunden. Bitte Farbcode prüfen.';
    } catch(error) { if(current===revision) get('status').textContent=error.message; }
  });
  get('run').addEventListener('click',async()=>{
    const ref=references[Number(get('reference').value)]; if(!ref)return;
    invalidate(); const current=revision; get('run').disabled=true; get('status').textContent='Rezepte werden verglichen …';
    try {
      const data=await api({colourId:ref.colourId,productId:ref.productId,canSizeId:ref.canSizeId,threshold:get('threshold').value});
      if(current!==revision)return;
      get('status').textContent=`${data.results.length} Treffer · ${data.reference.name} · ${data.reference.productName} · ${data.reference.baseCode} · ${data.reference.canSize}. Nach Abweichung sortiert.`;
      const fragment=document.createDocumentFragment();
      if(!data.results.length){const p=document.createElement('p');p.textContent='Keine ähnlichen Rezepte innerhalb dieser Grenze.';fragment.appendChild(p);}
      for(const hit of data.results){
        const item=document.createElement('details'); item.className='product';
        const changed=hit.changedColorants.map(r=>`${r.code}${r.change==='added'?' (zusätzlich)':r.change==='removed'?' (entfällt)':''}`).join(', ') || 'keine';
        item.innerHTML=`<summary><b>${esc(hit.name)}</b> · ${fmt(hit.deviation)} % Abweichung · Klasse ${hit.matchClass} %</summary><p>Abweichende Mischfarben: ${esc(changed)}</p><p>${esc(hit.productName)} · ${esc(hit.baseCode)} · ${esc(hit.canSize)} · Formel ${hit.formulaId}</p><div style="overflow:auto"><table class="rtable"><thead><tr><th scope="col">Mischfarbe</th><th scope="col">Referenz ml</th><th scope="col">Treffer ml</th><th scope="col">Referenz %</th><th scope="col">Treffer %</th><th scope="col">Differenz %-Punkte</th></tr></thead><tbody>${hit.rows.map(r=>`<tr><th scope="row">${esc(r.code)}${r.change==='added'?' · zusätzlich':r.change==='removed'?' · entfällt':''}</th><td>${fmt(r.referenceMl)}</td><td>${fmt(r.candidateMl)}</td><td>${fmt(r.referencePercent)}</td><td>${fmt(r.candidatePercent)}</td><td>${fmt(r.deltaPercent)}</td></tr>`).join('')}</tbody></table></div>`;
        fragment.appendChild(item);
      }
      get('results').replaceChildren(fragment);
    } catch(error) { if(current===revision)get('status').textContent=error.message; }
    finally { if(current===revision)get('run').disabled=false; }
  });
})();
