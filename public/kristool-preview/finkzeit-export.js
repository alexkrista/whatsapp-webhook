"use strict";

const FINK_ABSENCE = {
  "pause": ["Pause","003"], "mittag": ["Pause","003"],
  "büro": ["Büro","022"], "buero": ["Büro","022"],
  "urlaub": ["Urlaub","900"], "krank": ["Krank","901"], "krankenstand": ["Krank","901"],
  "arzt": ["Arzt","902"], "berufsschule": ["Berufsschule","903"], "feiertag": ["Feiertag","904"],
  "schulung extern": ["Schulung extern","905"], "schulung intern": ["Schulung intern","909"],
  "sonderurlaub": ["Sonderurlaub (Geburt, Todesfall)","911"], "musterung": ["Musterung","912"],
  "werkstatt": ["Werkstatt","913"], "firma aufräumen": ["Firma aufräumen","917"], "firma aufraeumen": ["Firma aufräumen","917"],
  "lehrlingswettbewerb": ["Lehrlingswettbewerb","918"], "betriebsausflug": ["Betriebsausflug","927"],
  "zeitausgleich": ["Zeitausgleich","930"], "quarantäne": ["Quarantäne","945"], "quarantaene": ["Quarantäne","945"],
  "kurzarbeit": ["Kurzarbeit","946"], "sanierung": ["Sanierung","9999"]
};
const fnorm = v => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
function fmap(reason) {
  const n = fnorm(reason);
  if (FINK_ABSENCE[n]) return FINK_ABSENCE[n];
  const key = Object.keys(FINK_ABSENCE).find(k => n.includes(k));
  return key ? FINK_ABSENCE[key] : [String(reason || "Unproduktiv").trim(), ""];
}
function fperson(e) { return String(e.finkzeitPersonnelNumber || e.finkzeitPersonalNumber || e.personalnummerFinkzeit || e.personnelNumber || "").trim(); }
function fname(name) { const p=String(name||"").trim().split(/\s+/).filter(Boolean); return p.length<2?(p[0]||""):`${p.slice(1).join(" ")}, ${p[0]}`; }
function fmins(hm) { const m=String(hm||"").match(/^(\d{1,2}):(\d{2})$/); return m?Number(m[1])*60+Number(m[2]):null; }
function fhours(from,to) { const a=fmins(from),b=fmins(to); return a===null||b===null||b<a?"":((b-a)/60).toFixed(2).replace(".",","); }
function fdate(iso) { const [y,m,d]=String(iso).split("-"); return `${d}.${m}.${y}`; }
function fadd(iso,n) { const d=new Date(`${iso}T12:00:00`); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function fmonday(iso) { const d=new Date(`${iso}T12:00:00`); d.setDate(d.getDate()-((d.getDay()+6)%7)); return d.toISOString().slice(0,10); }
function fdates(from,to) { const out=[]; for(let d=from;d<=to;d=fadd(d,1)) out.push(d); return out; }
function fcell(v) { return String(v??"").replace(/[\r\n]+/g," ").replace(/;/g,","); }
function assignmentAbsence(employeeId,date) {
  const rows=state.bootstrap?.assignments||[];
  const row=rows.find(a=>String(a.employeeId)===String(employeeId)&&String(a.date||a.day||"").slice(0,10)===date);
  if(!row) return null;
  const n=fnorm([row.absenceType,row.assignmentType,row.type,row.category,row.status,row.reason,row.jobName,row.name].filter(Boolean).join(" "));
  const key=Object.keys(FINK_ABSENCE).find(k=>n.includes(k)&&k!=="pause"&&k!=="mittag");
  return key?FINK_ABSENCE[key]:null;
}
async function buildFinkRows(from,to) {
  const employees=(state.bootstrap?.employees||[]).filter(e=>e.active!==false);
  const rows=[],missing=[],unknown=[];
  for(const e of employees) {
    const nr=fperson(e); if(!nr){missing.push(e.name||e.nickname||e.id); continue;}
    for(const date of fdates(from,to)) {
      let segments=[];
      try { const data=await request(`/kristine/api/segments/${encodeURIComponent(e.id||e.employeeId)}/${date}`); segments=data.segments||[]; } catch (_) {}
      const closed=segments.filter(s=>s.from&&s.to);
      if(closed.length) {
        for(const s of closed) {
          let abw="",code="";
          if(s.type==="pause"||s.type==="lunch") { abw="Pause"; code="003"; }
          else if(s.type==="up") { [abw,code]=fmap(s.reason||s.jobName); if(!code) unknown.push(`${e.name}: ${s.reason||s.jobName||"Unproduktiv"}`); }
          rows.push([nr,fname(e.name||e.employeeName),fdate(date),s.from,s.to,fhours(s.from,s.to),abw||" ",code||" "]);
        }
      } else {
        const absence=assignmentAbsence(e.id||e.employeeId,date);
        if(absence) rows.push([nr,fname(e.name||e.employeeName),fdate(date),"07:00","14:48","7,80",absence[0],absence[1]]);
      }
    }
  }
  return {rows,missing:[...new Set(missing)],unknown:[...new Set(unknown)]};
}
function updateFinkPreview(){const f=$("finkFrom")?.value,t=$("finkTo")?.value;if(f&&t)$("finkPreview").textContent=`Export ${fdate(f)} bis ${fdate(t)} · Personalnummer Finkzeit wird verwendet.`;}
$("openFinkzeitExport")?.addEventListener("click",()=>{const today=state.activeDate||new Date().toISOString().slice(0,10),mon=fmonday(today);$("finkFrom").value=mon;$("finkTo").value=fadd(mon,6);$("finkzeitModal").hidden=false;updateFinkPreview();});
$("closeFinkzeitExport")?.addEventListener("click",()=>$("finkzeitModal").hidden=true);
$("finkzeitModal")?.addEventListener("click",e=>{if(e.target.id==="finkzeitModal")e.currentTarget.hidden=true;});
document.querySelectorAll("[data-fink-range]").forEach(b=>b.addEventListener("click",()=>{const today=state.activeDate||new Date().toISOString().slice(0,10);let f=today,t=today;if(b.dataset.finkRange==="week"){f=fmonday(today);t=fadd(f,6);}if(b.dataset.finkRange==="lastweek"){f=fadd(fmonday(today),-7);t=fadd(f,6);}$("finkFrom").value=f;$("finkTo").value=t;updateFinkPreview();}));
$("finkFrom")?.addEventListener("change",updateFinkPreview); $("finkTo")?.addEventListener("change",updateFinkPreview);
$("downloadFinkzeitCsv")?.addEventListener("click",async()=>{
  const from=$("finkFrom").value,to=$("finkTo").value; if(!from||!to||from>to)return toast("Zeitraum prüfen.",true);
  const btn=$("downloadFinkzeitCsv"); btn.disabled=true; btn.textContent="CSV wird erstellt …";
  try {
    const result=await buildFinkRows(from,to); if(!result.rows.length)throw new Error("Keine exportierbaren Buchungen gefunden. Sind die Personalnummern Finkzeit eingetragen?");
    const lines=[["MA-Nr","Mitarbeiter","Datum","Von","Bis","Stunden","Abwesenheit","Abw.-Nr."],...result.rows].map(r=>r.map(fcell).join(";"));
    const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=`Finkzeit_${from}_${to}.csv`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    let msg=`${result.rows.length} Zeilen exportiert.`;if(result.missing.length)msg+=` Ohne Personalnummer: ${result.missing.join(", ")}.`;if(result.unknown.length)msg+=` Unbekannte Abw.-Nr.: ${result.unknown.join(", ")}.`;$("finkPreview").textContent=msg;toast("Finkzeit CSV erstellt.");
  } catch(e) { toast(e.message,true); } finally { btn.disabled=false;btn.textContent="CSV erstellen"; }
});
