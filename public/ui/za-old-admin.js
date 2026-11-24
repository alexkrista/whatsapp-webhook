"use strict";
(() => {
  const button=document.getElementById("openZaOldAdmin"),panel=document.getElementById("zaOldAdminContent");
  if(!button||!panel)return;
  const format=n=>(Number(n||0)/60).toLocaleString("de-AT",{minimumFractionDigits:2,maximumFractionDigits:2});
  async function load(){
    const ledger=await api("/kristine/api/za-old-ledger");
    const employees=(employeeMasters||[]).filter(e=>e.active!==false);
    panel.innerHTML='<h3>ZA alt</h3><label>Umbuchungsmonat <input type="month" id="zaOldTransferMonth"></label><table class="employee-table"><thead><tr><th>Mitarbeiter</th><th>Stand (Std.)</th><th>Stunden</th><th></th></tr></thead><tbody>'+employees.map(e=>`<tr><td>${esc(e.name)}</td><td>${format(ledger.balances?.[e.id])}</td><td><input type="number" min="0" step="0.25" data-za-hours="${esc(e.id)}"></td><td><button type="button" class="secondary" data-za-pay="${esc(e.id)}">Auszahlung</button> <button type="button" class="secondary" data-za-transfer="${esc(e.id)}">Umbuchen</button></td></tr>`).join("")+'</tbody></table><h3>Buchungen</h3><table class="employee-table"><thead><tr><th>Datum</th><th>Mitarbeiter</th><th>Std.</th><th>Info</th></tr></thead><tbody>'+ (ledger.entries||[]).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.employeeName||r.employeeId)}</td><td>${format(r.minutes)}</td><td>${esc(r.note||r.type)}</td></tr>`).join("")+'</tbody></table>';
  }
  button.onclick=async()=>{panel.hidden=!panel.hidden;if(!panel.hidden){try{await load()}catch(e){panel.textContent=e.message}}};
  panel.addEventListener("click",async e=>{
    const b=e.target.closest("[data-za-pay],[data-za-transfer]");if(!b)return;
    const transfer=Boolean(b.dataset.zaTransfer),id=b.dataset.zaPay||b.dataset.zaTransfer,input=panel.querySelector(`[data-za-hours="${CSS.escape(id)}"]`),hours=Number(input?.value);
    const month=panel.querySelector("#zaOldTransferMonth")?.value;
    if(!(hours>0)||transfer&&!month||!confirm(hours+(transfer?" Stunden vom Zeitkonto in ZA alt umbuchen?":" Stunden auszahlen und vom ZA-alt-Konto abziehen?")))return;
    b.disabled=true;
    try{await api("/kristine/api/za-old-ledger/"+(transfer?"transfer-balance":"payout"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:crypto.randomUUID(),month,employeeId:id,employeeName:employeeMasters.find(x=>String(x.id)===id)?.name||id,date:new Date().toISOString().slice(0,10),minutes:Math.round(hours*60),note:"Auszahlung"})});await load()}catch(error){alert(error.message)}finally{b.disabled=false}
  });
})();
