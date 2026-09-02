"use strict";

(function(){
  const VERSION="2026-08-23-gallery-1";
  const token=new URLSearchParams(location.search).get("token")||"";
  let currentJobId="";
  let media=[];
  let lightboxIndex=-1;
  let loadSerial=0;

  const esc=v=>String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token&&u.origin===location.origin)u.searchParams.set("token",token);return u.origin===location.origin?u.pathname+u.search+u.hash:u.href};
  const fmtDate=v=>{if(!v)return"–";try{return new Date(String(v).slice(0,10)+"T12:00:00").toLocaleDateString("de-AT",{weekday:"short",day:"2-digit",month:"2-digit",year:"numeric"})}catch{return String(v)}};
  async function api(p){const r=await fetch(tokenUrl(p));const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok)throw new Error(d?.error||t||r.statusText);return d}

  function installCss(){
    if(document.getElementById("baustellenFotoGalleryCss"))return;
    const s=document.createElement("style");s.id="baustellenFotoGalleryCss";s.textContent=`
      .bf-wrap{grid-column:1/-1;background:#fff;border:1px solid #ddd9cf;border-radius:15px;padding:15px;box-shadow:0 5px 18px rgba(23,33,27,.045);margin-bottom:2px}.bf-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:13px}.bf-head h3{margin:0;font-size:15px}.bf-head p{margin:3px 0 0;color:#707670;font-size:10.5px}.bf-count{display:inline-flex;border-radius:999px;background:#eef5ef;color:#295f39;padding:5px 8px;font-size:10px;font-weight:900;white-space:nowrap}.bf-days{display:grid;gap:15px}.bf-day{border-top:1px solid #ebe7df;padding-top:12px}.bf-day:first-child{border-top:0;padding-top:0}.bf-day-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px}.bf-day-head strong{font-size:12px}.bf-day-head span{color:#777;font-size:9.5px}.bf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:8px}.bf-item{position:relative;border:1px solid #e0dcd3;border-radius:11px;background:#f7f5ef;overflow:hidden;min-width:0}.bf-open{display:block;width:100%;padding:0;border:0;background:#ece9e1;cursor:pointer;aspect-ratio:4/3;overflow:hidden}.bf-open img,.bf-open video{display:block;width:100%;height:100%;object-fit:cover;transition:transform .18s ease}.bf-open:hover img,.bf-open:hover video{transform:scale(1.025)}.bf-video-badge{position:absolute;left:7px;top:7px;background:rgba(20,25,21,.78);color:#fff;border-radius:999px;padding:4px 7px;font-size:9px;font-weight:900;pointer-events:none}.bf-meta{padding:7px 8px;min-height:47px}.bf-meta strong{display:block;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bf-meta p{margin:3px 0 0;font-size:9.5px;color:#646a64;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.bf-empty{padding:18px;border:1px dashed #d5d0c6;border-radius:11px;background:#faf9f5;color:#707670;text-align:center;font-size:10.5px}.bf-error{color:#8f3e38;background:#fff2f0;border-color:#e7c7c4}
      .bf-lightbox{position:fixed;inset:0;z-index:900;display:none;background:rgba(11,14,12,.94);color:#fff}.bf-lightbox.open{display:grid;grid-template-rows:auto minmax(0,1fr) auto}.bf-lb-head{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 15px}.bf-lb-title{font-size:12px;font-weight:850}.bf-lb-close{border:0;background:transparent;color:#fff;font-size:27px;cursor:pointer;padding:2px 8px}.bf-lb-stage{position:relative;display:grid;place-items:center;min-height:0;padding:6px 58px}.bf-lb-stage img,.bf-lb-stage video{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}.bf-lb-nav{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:58px;border:1px solid rgba(255,255,255,.18);border-radius:11px;background:rgba(255,255,255,.08);color:#fff;font-size:25px;cursor:pointer}.bf-lb-prev{left:10px}.bf-lb-next{right:10px}.bf-lb-foot{padding:12px 16px 17px;text-align:center}.bf-lb-foot strong{font-size:11px}.bf-lb-foot p{margin:4px auto 0;max-width:900px;color:rgba(255,255,255,.7);font-size:10.5px;line-height:1.4}.bf-lb-counter{margin-top:5px;color:rgba(255,255,255,.45);font-size:9.5px}
      @media(max-width:700px){.bf-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bf-wrap{padding:11px}.bf-lb-stage{padding:5px 42px}.bf-lb-nav{width:34px;height:52px}.bf-lb-prev{left:4px}.bf-lb-next{right:4px}}
    `;document.head.appendChild(s);
  }

  function installLightbox(){
    if(document.getElementById("bfLightbox"))return;
    document.body.insertAdjacentHTML("beforeend",`<div id="bfLightbox" class="bf-lightbox" aria-hidden="true"><div class="bf-lb-head"><div id="bfLbTitle" class="bf-lb-title">Foto</div><button id="bfLbClose" class="bf-lb-close" type="button" aria-label="Schließen">×</button></div><div id="bfLbStage" class="bf-lb-stage"><button id="bfLbPrev" class="bf-lb-nav bf-lb-prev" type="button" aria-label="Vorheriges">‹</button><div id="bfLbMedia"></div><button id="bfLbNext" class="bf-lb-nav bf-lb-next" type="button" aria-label="Nächstes">›</button></div><div class="bf-lb-foot"><strong id="bfLbMeta"></strong><p id="bfLbCaption"></p><div id="bfLbCounter" class="bf-lb-counter"></div></div></div>`);
    document.getElementById("bfLbClose").onclick=closeLightbox;
    document.getElementById("bfLbPrev").onclick=()=>moveLightbox(-1);
    document.getElementById("bfLbNext").onclick=()=>moveLightbox(1);
    document.getElementById("bfLightbox").addEventListener("click",e=>{if(e.target.id==="bfLightbox")closeLightbox()});
    document.addEventListener("keydown",e=>{if(!document.getElementById("bfLightbox")?.classList.contains("open"))return;if(e.key==="Escape")closeLightbox();if(e.key==="ArrowLeft")moveLightbox(-1);if(e.key==="ArrowRight")moveLightbox(1)});
  }

  function openLightbox(index){
    if(!media.length)return;lightboxIndex=Math.max(0,Math.min(media.length-1,Number(index)||0));renderLightbox();const box=document.getElementById("bfLightbox");box.classList.add("open");box.setAttribute("aria-hidden","false");
  }
  function closeLightbox(){const box=document.getElementById("bfLightbox");if(!box)return;box.classList.remove("open");box.setAttribute("aria-hidden","true");document.getElementById("bfLbMedia").innerHTML=""}
  function moveLightbox(delta){if(!media.length)return;lightboxIndex=(lightboxIndex+delta+media.length)%media.length;renderLightbox()}
  function renderLightbox(){
    const item=media[lightboxIndex];if(!item)return;const url=tokenUrl(item.url),host=document.getElementById("bfLbMedia");host.innerHTML=item.kind==="video"?`<video src="${esc(url)}" controls autoplay playsinline></video>`:`<img src="${esc(url)}" alt="Baustellenfoto ${esc(item.date||"")}">`;
    document.getElementById("bfLbTitle").textContent=item.kind==="video"?"Video":"Foto";
    document.getElementById("bfLbMeta").textContent=[fmtDate(item.date),item.at,item.employeeName].filter(Boolean).join(" · ")||"Baustellenmedium";
    document.getElementById("bfLbCaption").textContent=item.content||"";
    document.getElementById("bfLbCounter").textContent=`${lightboxIndex+1} / ${media.length}`;
  }

  function groupByDay(items){const map=new Map();for(const item of items){const day=String(item.date||"Ohne Datum");if(!map.has(day))map.set(day,[]);map.get(day).push(item)}return [...map.entries()]}

  function renderGallery(){
    const host=document.getElementById("bkProtocols");if(!host||host.querySelector(".bf-wrap"))return;
    const wrap=document.createElement("section");wrap.className="bf-wrap";
    if(!media.length){wrap.innerHTML='<div class="bf-head"><div><h3>Fotos & Videos</h3><p>Direkt aus der Baustellendokumentation.</p></div><span class="bf-count">0 Medien</span></div><div class="bf-empty">Für diese Baustelle sind derzeit keine einzelnen Fotos oder Videos gespeichert.</div>';host.prepend(wrap);return}
    const groups=groupByDay(media);wrap.innerHTML=`<div class="bf-head"><div><h3>Fotos & Videos</h3><p>Direkt sichtbar · nach Bautag geordnet · Klick zum Vergrößern.</p></div><span class="bf-count">${media.length} Medien</span></div><div class="bf-days">${groups.map(([day,items])=>`<section class="bf-day" data-bf-day="${esc(day)}"><div class="bf-day-head"><strong>${fmtDate(day)}</strong><span>${items.filter(x=>x.kind==='photo').length} Fotos · ${items.filter(x=>x.kind==='video').length} Videos</span></div><div class="bf-grid">${items.map(item=>{const index=media.indexOf(item),url=tokenUrl(item.url),meta=[item.at,item.employeeName].filter(Boolean).join(' · ');return `<article class="bf-item"><button type="button" class="bf-open" data-bf-index="${index}" aria-label="${item.kind==='video'?'Video':'Foto'} öffnen">${item.kind==='video'?`<video src="${esc(url)}" muted preload="metadata" playsinline></video><span class="bf-video-badge">▶ Video</span>`:`<img src="${esc(url)}" loading="lazy" alt="Baustellenfoto ${esc(day)}">`}</button><div class="bf-meta"><strong>${esc(meta||item.source||'Baustellendokumentation')}</strong>${item.content?`<p>${esc(item.content)}</p>`:''}</div></article>`}).join('')}</div></section>`).join('')}</div>`;
    host.prepend(wrap);wrap.querySelectorAll("[data-bf-index]").forEach(el=>el.addEventListener("click",()=>openLightbox(Number(el.dataset.bfIndex))));
  }

  function watchProtocolHost(){
    const host=document.getElementById("bkProtocols");if(!host||host.dataset.bfObserved)return;host.dataset.bfObserved="1";new MutationObserver(()=>{if(media.length&&!host.querySelector(".bf-wrap"))setTimeout(renderGallery,0)}).observe(host,{childList:true,subtree:false});
  }

  async function load(jobId){
    const id=String(jobId||"").trim();if(!id)return;const my=++loadSerial;currentJobId=id;media=[];
    try{const result=await api(`/admin/api/job/${encodeURIComponent(id)}/media`);if(my!==loadSerial)return;media=Array.isArray(result.media)?result.media:[];await waitForProtocols();if(my!==loadSerial)return;watchProtocolHost();document.querySelector("#bkProtocols .bf-wrap")?.remove();renderGallery()}catch(e){if(my!==loadSerial)return;await waitForProtocols();const host=document.getElementById("bkProtocols");if(host&&!host.querySelector('.bf-wrap')){const wrap=document.createElement('section');wrap.className='bf-wrap';wrap.innerHTML=`<div class="bf-head"><div><h3>Fotos & Videos</h3></div></div><div class="bf-empty bf-error">Galerie konnte nicht geladen werden: ${esc(e.message)}</div>`;host.prepend(wrap)}}
  }

  function waitForProtocols(){return new Promise(resolve=>{const ready=()=>document.getElementById("bkProtocols");if(ready())return resolve();const obs=new MutationObserver(()=>{if(ready()){obs.disconnect();resolve()}});obs.observe(document.documentElement,{subtree:true,childList:true});setTimeout(()=>{obs.disconnect();resolve()},8000)})}

  function hook(){document.addEventListener("click",e=>{const row=e.target.closest?.(".job-row[data-job]");if(row)setTimeout(()=>load(row.dataset.job),750)},true);window.addEventListener("hashchange",()=>{const id=decodeURIComponent(location.hash.slice(1));if(id)setTimeout(()=>load(id),800)});const hash=decodeURIComponent(location.hash.slice(1));if(hash)setTimeout(()=>load(hash),1300)}
  function init(){installCss();installLightbox();hook();window.BaustellenFotoGallery={version:VERSION,reload:()=>currentJobId&&load(currentJobId)}}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
