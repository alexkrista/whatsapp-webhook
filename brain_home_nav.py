# coding: utf-8
"""The Brain Startnavigation: 2 klare Reihen fuer die taegliche Arbeit."""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaBrainHomeNavV1" in page:
        return

    css = r'''
.brain-home-nav-rows{display:grid;gap:10px;margin-bottom:2px}
.brain-home-nav-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.brain-home-nav-row>*{margin:0!important}
@media(max-width:700px){.brain-home-nav-row>*{flex:1 1 auto}}
'''

    script = r'''
<script id="kristaBrainHomeNavV1">
(function(){
  function text(el){return String(el?.textContent||'').replace(/\s+/g,' ').trim()}
  function find(label){return [...document.querySelectorAll('button,a')].find(el=>text(el).includes(label))||null}
  function commonAncestor(nodes){
    if(!nodes.length)return null;
    let node=nodes[0].parentElement;
    while(node){if(nodes.every(x=>node.contains(x)))return node;node=node.parentElement}
    return null;
  }
  function install(){
    if(document.getElementById('brainHomeNavRows'))return;
    const project=find('Projekte / Firmenwissen');
    const incoming=find('Eingangsrechnungen');
    const material=[...document.querySelectorAll('button,a')].find(el=>/^\s*[^A-Za-z0-9]*Material\s*$/.test(text(el)))||find('Material');
    const paint=find('Farben & Lager');
    const capture=find('Erfassen');
    if(!project||!material||!capture)return;

    if(paint)paint.remove();
    if(incoming)incoming.remove();
    capture.textContent='📥 Erfassen';

    const nodes=[project,material,capture];
    const host=commonAncestor(nodes);
    if(!host)return;

    const wrapper=document.createElement('div');wrapper.id='brainHomeNavRows';wrapper.className='brain-home-nav-rows';
    const top=document.createElement('div');top.className='brain-home-nav-row';
    const bottom=document.createElement('div');bottom.className='brain-home-nav-row';
    const first=nodes.map(n=>({n,idx:[...host.children].indexOf(n)})).filter(x=>x.idx>=0).sort((a,b)=>a.idx-b.idx)[0]?.n;
    if(first&&first.parentElement===host)host.insertBefore(wrapper,first);else host.insertBefore(wrapper,host.firstChild);
    wrapper.append(top,bottom);
    top.append(project,material);
    bottom.append(capture);

    const op=capture.cloneNode(true);
    op.id='modePayments';op.classList.remove('active');op.removeAttribute('onclick');op.textContent='💶 OP';
    op.addEventListener('click',e=>{e.preventDefault();window.location.href='/incoming/payments'});
    bottom.appendChild(op);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain Startnavigation: Projekte + Material / Erfassen + OP")
