# coding: utf-8
"""KRISTINE Eingangsrechnungen: Scroll-Isolation fuer den Pruefplatz.

Wenn die Erfassungsseite bereits ohne geladene Rechnung beim normalen Body-Scroll
haengt, ist nicht OCR/Netzwerk der Engpass, sondern Paint/Layout des langen DOM.
Darum wird der eigentliche Pruefplatz am Desktop in einen eigenen, begrenzten
Scrollbereich gelegt. Kostenentwicklung und "Zuletzt erfasst" bleiben initial
komplett aus dem Paint und werden nur auf Wunsch eingeblendet.
"""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaCaptureScrollIsolationV1" in page:
        return

    css = r'''
<style id="kristaCaptureScrollIsolationV1">
body.capture-wide{scroll-behavior:auto!important}
body.capture-wide #captureSection *{animation:none!important}
body.capture-wide #captureSection .card,
body.capture-wide #captureSection .capture-kpi,
body.capture-wide #captureSection .capture-cost-card{box-shadow:none!important}

.capture-lazy-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 0;padding:12px 14px;border:1px solid #343d47;border-radius:12px;background:#151a20}
.capture-lazy-bar .sub{margin:0}.capture-lazy-bar button{min-height:38px;padding:8px 12px}
.capture-lazy-section[hidden]{display:none!important}

@media(min-width:921px){
  body.capture-wide .capture-workbench{
    height:calc(100vh - 150px)!important;
    min-height:620px!important;
    max-height:860px!important;
    overflow:hidden!important;
    align-items:stretch!important;
  }
  body.capture-wide .capture-preview-column,
  body.capture-wide .capture-editor-column{
    height:100%!important;
    min-height:0!important;
    overflow-y:auto!important;
    overflow-x:hidden!important;
    overscroll-behavior:contain!important;
    scrollbar-gutter:stable!important;
    contain:layout paint style!important;
  }
  body.capture-wide .capture-preview-column{
    position:static!important;
    top:auto!important;
  }
  body.capture-wide .capture-preview-card{
    min-height:100%!important;
    height:auto!important;
  }
  body.capture-wide .capture-pdf-shell{
    min-height:240px!important;
    max-height:calc(100vh - 300px)!important;
    overflow:auto!important;
    contain:layout paint!important;
  }
  body.capture-wide .capture-pdf-empty{min-height:240px!important}
}

@media(max-width:920px){
  .capture-lazy-bar{margin-top:12px}
}
</style>
'''

    script = r'''
<script id="kristaCaptureScrollIsolationV1">
(function(){
  function installLazySections(){
    if(document.getElementById('captureLazyBottomBar'))return;
    const cost=document.getElementById('captureCostSummary');
    const recent=document.getElementById('captureRecent');
    const workbench=document.querySelector('.capture-workbench');
    if(!cost||!recent||!workbench)return;
    const costSection=cost.closest('.section');
    const recentSection=recent.closest('.section');
    if(!costSection||!recentSection)return;
    costSection.classList.add('capture-lazy-section');
    recentSection.classList.add('capture-lazy-section');
    costSection.hidden=true;recentSection.hidden=true;

    const bar=document.createElement('div');
    bar.id='captureLazyBottomBar';bar.className='capture-lazy-bar';
    bar.innerHTML='<div><strong>Auswertung & Verlauf</strong><div class="sub">Bleibt fuer einen fluessigen Pruefplatz zuerst ausgeblendet.</div></div><button type="button">Kosten + zuletzt erfasst anzeigen</button>';
    workbench.insertAdjacentElement('afterend',bar);
    bar.querySelector('button').onclick=()=>{
      costSection.hidden=false;recentSection.hidden=false;bar.remove();
      requestAnimationFrame(()=>costSection.scrollIntoView({behavior:'auto',block:'start'}));
    };
  }

  function markVersion(){
    const banner=document.getElementById('captureAreaBanner');
    if(!banner||banner.querySelector('[data-scroll-build]'))return;
    const tag=document.createElement('span');tag.dataset.scrollBuild='1';tag.style.cssText='display:inline-block;margin-left:8px;opacity:.72;font-size:10px';tag.textContent='UI 0.14.5-scroll';banner.appendChild(tag);
  }

  function start(){installLazySections();markVersion()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  setTimeout(start,120);
})();
</script>
'''

    page = page.replace("</head>", css + "\n</head>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Eingangsrechnungen Scroll-Isolation: Pruefplatz eigener Scrollbereich · Verlauf lazy")
