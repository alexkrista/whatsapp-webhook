"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("/kristine"))return;

  let installed=false;
  let suppressClickUntil=0;

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
    if(segment){
      const id=assignmentIdFromSegmentRow(segment);
      if(id)return id;
    }
    const card=target?.closest?.(".assignment[data-assignment-id],.monthitem[data-assignment-id]");
    if(!card||card.classList.contains("segment-split"))return "";
    return String(card.dataset.assignmentId||"");
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
    const source=assignmentById(assignmentId);
    if(!source)return;
    let type="";
    try{type=typeof cardTypeOf==="function"?cardTypeOf(source):String(source.cardType||"")}catch{}
    if(type!=="site")return;

    const employee=employeeForId(source.employeeId);
    if(!employee)return;
    if(typeof askSegmentWindow!=="function"||typeof validateSegmentWindow!=="function")return;

    const windowRule=typeof modelDayWindow==="function"?modelDayWindow(employee.id,source.date):{from:"07:00",to:"17:00"};
    const selected=await askSegmentWindow({
      employee,
      date:source.date,
      jobName:source.jobName||source.jobId||"Baustelle",
      excludeId:source.id,
      suggestion:{from:source.from||windowRule.from,to:source.to||windowRule.to}
    });
    if(!selected)return;

    const check=validateSegmentWindow(employee.id,source.date,selected.from,selected.to);
    if(!check?.ok){alert(check?.message||"Bitte ein gültiges Zeitfenster eingeben.");return}
    if(check.warning&&!confirm(check.warning))return;

    if(typeof subtractWindowFromExisting==="function")subtractWindowFromExisting(employee.id,source.date,selected.from,selected.to,source.id);
    source.from=selected.from;
    source.to=selected.to;
    if(typeof rawCardHours==="function")source.hours=rawCardHours(source);
    if(typeof normalizeEmployeeDaySegments==="function")normalizeEmployeeDaySegments(employee.id,source.date);
    if(typeof saveAssignments==="function")await saveAssignments(true);
    else if(typeof renderPlanning==="function")renderPlanning();
  }

  async function copyExistingToEmployee(event,date,employeeId,original){
    const payload=(()=>{try{return typeof droppedPayload==="function"?String(droppedPayload(event)||""):String(event?.dataTransfer?.getData("text/plain")||"")}catch{return ""}})();
    if(!payload||payload.startsWith("pooljob:")||payload.startsWith("pooltype:"))return original.apply(this,arguments);

    const source=(()=>{try{return typeof droppedAssignment==="function"?droppedAssignment(event):assignmentById(payload)}catch{return assignmentById(payload)}})();
    if(!source)return original.apply(this,arguments);

    const targetEmployee=employeeForId(employeeId);
    if(!targetEmployee)return;
    if(String(source.employeeId)===String(employeeId)&&String(source.date)===String(date))return;

    event.preventDefault();
    event.currentTarget?.classList?.remove("dragover");
    suppressClickUntil=Date.now()+500;

    let type="";
    try{type=typeof cardTypeOf==="function"?cardTypeOf(source):String(source.cardType||"site")}catch{type="site"}
    let created=null;

    if(type==="site"){
      if(typeof placeSiteAssignment!=="function")return original.apply(this,arguments);
      const template={...source,id:(typeof id==="function"?id():`${Date.now()}_${Math.random()}`)};
      const hasExisting=typeof siteSegments==="function"?siteSegments(targetEmployee.id,date).length>0:false;
      created=await placeSiteAssignment(template,targetEmployee,date,{forceDialog:hasExisting});
    }else{
      if(typeof createSpecialAssignment!=="function")return original.apply(this,arguments);
      created=await createSpecialAssignment(type,targetEmployee,date,source);
    }

    if(created&&typeof saveAssignments==="function")await saveAssignments(true);
    else if(typeof renderPlanning==="function")renderPlanning();
  }

  function wrapEmployeeDrop(){
    if(typeof window.planningEmployeeDrop!=="function"||window.planningEmployeeDrop.__kristaCardTools)return;
    const original=window.planningEmployeeDrop;
    const wrapped=async function(event,date,employeeId){return copyExistingToEmployee.call(this,event,date,employeeId,original)};
    wrapped.__kristaCardTools=true;
    wrapped.__kristaOriginal=original;
    window.planningEmployeeDrop=wrapped;
  }

  function install(){
    installStyle();
    wrapEmployeeDrop();
    decorateCards();
    if(installed)return;
    installed=true;

    document.addEventListener("dragstart",event=>{
      if(event.target?.closest?.(".assignment[data-assignment-id],.monthitem[data-assignment-id]"))suppressClickUntil=Date.now()+900;
    },true);
    document.addEventListener("dragend",event=>{
      if(event.target?.closest?.(".assignment[data-assignment-id],.monthitem[data-assignment-id]"))suppressClickUntil=Date.now()+350;
    },true);
    document.addEventListener("click",event=>{
      if(Date.now()<suppressClickUntil)return;
      if(event.target?.closest?.("button,a,input,select,textarea,label"))return;
      const assignmentId=clickedAssignmentId(event.target);
      if(!assignmentId)return;
      const assignment=assignmentById(assignmentId);
      if(!assignment)return;
      let type="";try{type=typeof cardTypeOf==="function"?cardTypeOf(assignment):String(assignment.cardType||"")}catch{}
      if(type!=="site")return;
      event.preventDefault();
      event.stopPropagation();
      editAssignmentWindow(assignmentId).catch(error=>{console.error("Planungszeit konnte nicht bearbeitet werden:",error)});
    });
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{install();setTimeout(install,250)},{once:true});
  else{install();setTimeout(install,250)}
  setInterval(()=>{wrapEmployeeDrop();decorateCards()},1500);
})();
