# coding: utf-8
"""Kleiner Brain-Hotfix: Im Dunja-Prüfplatz nur einen PDF-Viewer anzeigen."""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaBrainViewerSingleSurface" in page:
        return

    css = r'''
/* Brain Viewer Hotfix: alter Browser-PDF-Viewer / Leertext nie unter dem Superviewer anzeigen */
#capturePdfPreview.brain-super-hidden,
#capturePdfEmpty.brain-super-hidden{
  display:none!important;
  visibility:hidden!important;
  height:0!important;
  min-height:0!important;
  margin:0!important;
  padding:0!important;
  border:0!important;
}
'''

    script = r'''
<script id="kristaBrainViewerSingleSurface">
(function(){
  const frame=document.getElementById('capturePdfPreview');
  const empty=document.getElementById('capturePdfEmpty');
  const tools=document.getElementById('captureSuperTools');
  const image=document.getElementById('capturePdfPageImage');
  if(!frame||!empty||!tools)return;

  function syncSingleViewer(){
    const superActive=!tools.hidden && !!(image && !image.hidden && image.getAttribute('src'));
    frame.classList.toggle('brain-super-hidden',superActive);
    empty.classList.toggle('brain-super-hidden',superActive);
    if(superActive){
      frame.hidden=true;
      empty.hidden=true;
    }
  }

  const observer=new MutationObserver(syncSingleViewer);
  observer.observe(tools,{attributes:true,attributeFilter:['hidden']});
  observer.observe(frame,{attributes:true,attributeFilter:['hidden','src']});
  observer.observe(empty,{attributes:true,attributeFilter:['hidden']});
  if(image)observer.observe(image,{attributes:true,attributeFilter:['hidden','src']});

  document.addEventListener('change',e=>{
    if(e.target?.id==='captureFile')setTimeout(syncSingleViewer,0);
  });
  setInterval(syncSingleViewer,500);
  syncSingleViewer();
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain Viewer Hotfix aktiv: nur ein PDF-Viewer im Dunja-Prüfplatz")
