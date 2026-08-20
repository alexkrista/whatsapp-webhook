"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("/kristine"))return;

  let installed=false;
  let suppressClickUntil=0;
  let activeDragAssignmentId="";

  function assignmentById(assignmentId){
    try{return (data?.assignments||[]).find(row=>String(row?.id||"")===String(assignmentId||""))||null}catch{return null}
  }
  function employeeForId(employeeId){
    try{if(typeof employeeById==="function"){const row=employeeById(employeeId);if(row)return row}}catch{}
    try{return (masterEmployees||[]).find(row=>String(row?.id||"")===String(employeeId||""))||null}catch{return null}
  }
  function assignmentIdFromSegmentRow(row){
    const button=row?.querySelector("button[onclick*='removeAssignment']");
    const match=String(button?.getAttribute("onclick")||"").match(/removeAssignment\('([^']+)'\)/);
    return match?.[1]||"";
  }
  function clickedAssignmentId(target){
    const segment=target?.closest?.(".segment-row");
    if(segment){const id=assignmentIdFromSegmentRow(segment);if(id)return id}
    const card=target?.closest?.(".assignment[data-assignment-id],.monthitem[data-assignment-id]");
    if(!card||card.classList.contains("segment-split"))return "";
    return String(card.dataset.assignmentId||"");
  }
  function parseEmployeeDropCell(cell){
    if(!cell)return null;
    if(cell.dataset.kristaPlanningDate&&cell.dataset.kristaPlanningEmployee){
      return {cell,date:cell.dataset.kristaPlanningDate,employeeId:cell.dataset.kristaPlanningEmployee};
    }
    const code=String(cell.getAttribute("ondrop")||"");
    const match=code.match(/planningEmployeeDrop\s*\(\s*event\s*,\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)/i);
    if(!match)return null;
    cell.dataset.kristaPlanningDate=match[1];
    cell.dataset.kristaPlanningEmployee=match[2];
    return {cell,date:match[1],employeeId:match[2]};
  }

  function installStyle(){
    if(document.getElementById("kristaPlanningCardToolsStyle"))return;
    const style=document.createElement("style");
    style.id="kristaPlanningCardToolsStyle";
    style.textContent=`
      .krista-planning-editable{cursor:pointer!important}
      .krista-planning-editable:hover{box-shadow:0 4px 14px rgba(39,113,61,.16)!important;outline:1px solid rgba(39,113,61,.16)}
      .krista-planning-editable-segment{cursor:pointer;border-radius:7px}
      .krista-planning-editable-segment:hover{background:#edf6ef}
    `;
    document.head.appendChild(style);
  }

  async function editAssignmentWindow(assignmentId){
    const source=assignmentById(assignmentId);if(!source)return;
    let type="";try{type=typeof cardTypeOf==="function"?cardTypeOf(source):String(source.cardType||"")}catch{}
    if(type!=="site")return;
    const employee=employeeForId(source.employeeId);if(!employee)return;
    if(typeof askSegmentWindow!=="function"||typeof validateSegmentWindow!=="function")return;

    const windowRule=typeof modelDayWindow==="function"?modelDayWindow(employee.id,source.date):{from:"07:00",to:"17:00"};
    const selected=await askSegmentWindow({employee,date:source.date,jobName:source.jobName||source.jobId||"Baustelle",excludeId:source.id,suggestion:{from:source.from||windowRule.from,to:source.to||windowRule.to}});
    if(!selected)return;
    const check=validateSegmentWindow(employee.id,source.date,selected.from,selected.to);
    if(!check?.ok){alert(check?.message||"Bitte ein gültiges Zeitfenster eingeben.");return}
    if(check.warning&&!confirm(check.warning))return;
    if(typeof subtractWindowFromExisting==="function")subtractWindowFromExisting(employee.id,source.date,selected.from,selected.to,source.id);
    source.from=selected.from;source.to=selected.to;
    if(typeof rawCardHours==="function")source.hours=rawCardHours(source);
    if(typeof normalizeEmployeeDaySegments==="function")normalizeEmployeeDaySegments(employee.id,source.date);
    if(typeof saveAssignments==="function")await saveAssignments(true);else if(typeof renderPlanning==="function")renderPlanning();
  }

  function exactDuplicate(source,targetEmployee,date,from,to){
    try{return (data?.assignments||[]).some(row=>String(row?.employeeId||"")===String(targetEmployee?.id||"")&&String(row?.date||"")===String(date||"")&&String(row?.jobId||"")===String(source?.jobId||"")&&String(row?.from||"")===String(from||"")&&String(row?.to||"")===String(to||""))}catch{return false}
  }

  function cleanTargetIdentity(source,targetEmployee){
    const clone={...source};
    // Der Server löst Mitarbeiter zuerst über Fink-/Personalnummer auf und erst
    // danach über employeeId. Beim Kopieren auf einen anderen Mitarbeiter dürfen
    // deshalb keinerlei Identitätsfelder der Quellperson mitwandern.
    delete clone.finkzeitPersonnelNumber;
    delete clone.finkzeitPersonalNumber;
    delete clone.personalnummerFinkzeit;
    delete clone.personnelNumber;
    delete clone.personalNumber;
    delete clone.personnelNo;
    delete clone.employeeNumber;
    delete clone.persNr;
    delete clone.employeeIdentityKey;
    clone.employeeId=String(targetEmployee?.id||targetEmployee?.employeeId||"");
    clone.employeeName=String(targetEmployee?.name||targetEmployee?.employeeName||clone.employeeId);
    return clone;
  }

  async function createCopyForTarget(source,targetEmployee,date){
    let type="site";try{type=typeof cardTypeOf==="function"?cardTypeOf(source):String(source.cardType||"site")}catch{}
    if(type!=="site"){
      if(typeof createSpecialAssignment!=="function")return null;
      return createSpecialAssignment(type,targetEmployee,date,cleanTargetIdentity(source,targetEmployee));
    }

    let from=String(source.from||""),to=String(source.to||"");
    const rule=typeof modelDayWindow==="function"?modelDayWindow(targetEmployee.id,date):{from:"07:00",to:"17:00"};
    if(!from)from=rule.from;if(!to)to=rule.to;

    const existing=typeof siteSegments==="function"?siteSegments(targetEmployee.id,date):[];
    if(existing.length&&typeof askSegmentWindow==="function"){
      const selected=await askSegmentWindow({employee:targetEmployee,date,jobName:source.jobName||source.jobId||"Baustelle",suggestion:{from,to}});
      if(!selected)return null;from=selected.from;to=selected.to;
    }
    if(typeof validateSegmentWindow==="function"){
      const check=validateSegmentWindow(targetEmployee.id,date,from,to);
      if(!check?.ok){alert(check?.message||"Bitte ein gültiges Zeitfenster eingeben.");return null}
      if(check.warning&&!confirm(check.warning))return null;
    }
    if(exactDuplicate(source,targetEmployee,date,from,to)){
      try{if(typeof toast==="function")toast(`${targetEmployee.name||"Mitarbeiter"} ist für dieses Zeitfenster bereits auf der Baustelle eingeplant.`)}catch{}
      return {duplicate:true};
    }

    if(typeof subtractWindowFromExisting==="function")subtractWindowFromExisting(targetEmployee.id,date,from,to);
    const clone={
      ...cleanTargetIdentity(source,targetEmployee),
      id:typeof id==="function"?id():`${Date.now()}_${Math.random().toString(36).slice(2)}`,
      date:String(date),
      from,
      to
    };
    if(typeof rawCardHours==="function")clone.hours=rawCardHours(clone);
    try{data.assignments.push(clone)}catch{return null}
    if(typeof normalizeEmployeeDaySegments==="function")normalizeEmployeeDaySegments(targetEmployee.id,date);
    return clone;
  }

  async function handleEmployeeCellDrop(event,meta){
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    meta.cell.classList.remove("dragover");
    suppressClickUntil=Date.now()+700;

    let payload=activeDragAssignmentId;
    if(!payload){try{payload=String(event.dataTransfer?.getData("text/plain")||"")}catch{}}
    if(!payload)return;

    // Pool-Karten sollen weiterhin exakt durch die bewährte Grundlogik laufen.
    if(payload.startsWith("pooljob:")||payload.startsWith("pooltype:")){
      if(typeof window.planningEmployeeDrop==="function")await window.planningEmployeeDrop(event,meta.date,meta.employeeId);
      return;
    }

    const source=assignmentById(payload);if(!source)return;
    if(String(source.employeeId)===String(meta.employeeId)&&String(source.date)===String(meta.date))return;

    const targetEmployee=employeeForId(meta.employeeId);if(!targetEmployee)return;
    const created=await createCopyForTarget(source,targetEmployee,meta.date);
    if(created&&!created.duplicate&&typeof saveAssignments==="function")await saveAssignments(true);
    else if(typeof renderPlanning==="function")renderPlanning();
  }

  function bindEmployeeDropCells(){
    document.querySelectorAll(".matrix-cell.dropzone").forEach(cell=>{
      const meta=parseEmployeeDropCell(cell);if(!meta)return;
      if(cell.dataset.kristaDirectEmployeeDrop==="1")return;

      // Entscheidend: der alte Inline-Handler wird entfernt. Ab hier existiert
      // für diese Mitarbeiter-Zelle nur noch EIN Drop-Weg mit der Ziel-ID.
      cell.removeAttribute("ondrop");
      cell.dataset.kristaDirectEmployeeDrop="1";
      cell.addEventListener("drop",event=>{
        handleEmployeeCellDrop(event,{cell,date:cell.dataset.kristaPlanningDate,employeeId:cell.dataset.kristaPlanningEmployee})
          .catch(error=>console.error("Planung: Mitarbeiter-Kopie fehlgeschlagen:",error));
      });
    });
  }

  function decorateCards(){
    document.querySelectorAll(".assignment[data-assignment-id],.monthitem[data-assignment-id]").forEach(card=>{
      if(card.classList.contains("segment-split"))return;
      card.classList.add("krista-planning-editable");
      card.title="Klicken: Zeitfenster bearbeiten · Ziehen: kopieren";
    });
    document.querySelectorAll(".segment-row").forEach(row=>{
      if(!assignmentIdFromSegmentRow(row))return;
      row.classList.add("krista-planning-editable-segment");
      row.title="Klicken: Zeitfenster bearbeiten";
    });
    bindEmployeeDropCells();
  }

  function install(){
    installStyle();decorateCards();
    if(installed)return;installed=true;

    document.addEventListener("dragstart",event=>{
      const card=event.target?.closest?.(".assignment[data-assignment-id],.monthitem[data-assignment-id]");
      if(!card)return;
      activeDragAssignmentId=String(card.dataset.assignmentId||"");
      suppressClickUntil=Date.now()+900;
    },true);
    document.addEventListener("dragend",event=>{
      if(event.target?.closest?.(".assignment[data-assignment-id],.monthitem[data-assignment-id]"))suppressClickUntil=Date.now()+350;
      activeDragAssignmentId="";
    },true);
    document.addEventListener("click",event=>{
      if(Date.now()<suppressClickUntil)return;
      if(event.target?.closest?.("button,a,input,select,textarea,label"))return;
      const assignmentId=clickedAssignmentId(event.target);if(!assignmentId)return;
      const assignment=assignmentById(assignmentId);if(!assignment)return;
      let type="";try{type=typeof cardTypeOf==="function"?cardTypeOf(assignment):String(assignment.cardType||"")}catch{}
      if(type!=="site")return;
      event.preventDefault();event.stopPropagation();
      editAssignmentWindow(assignmentId).catch(error=>console.error("Planungszeit konnte nicht bearbeitet werden:",error));
    });
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{install();setTimeout(decorateCards,250)},{once:true});
  else{install();setTimeout(decorateCards,250)}
  setInterval(decorateCards,700);
})();
