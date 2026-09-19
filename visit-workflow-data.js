"use strict";
const {structuredAddress,projectContactsFromMaster}=require("./workflow-contacts");
const nonempty=value=>value!==undefined&&value!==null&&value!=="";
const first=(...values)=>String(values.find(value=>nonempty(value)&&String(value).trim())||"").trim();
function mergeMaster(...sources){
  return Object.assign({},...sources.filter(row=>row&&typeof row==="object").map(row=>Object.fromEntries(Object.entries(row).filter(([,value])=>nonempty(value)))));
}
function visitWorkflowData(row={},task={},input={}){
  const master=mergeMaster(task.customerMaster,row.customerMaster,input.customerMaster);
  const customer=first(input.customer,input.contactName,input.customerMaster?.name,row.customer,row.customerMaster?.name,task.contactName,task.customerMaster?.name);
  const contactPhone=first(input.contactPhone,input.customerMaster?.phone,row.contactPhone,row.customerMaster?.phone,task.contactPhone,task.customerMaster?.phone);
  const contactEmail=first(input.contactEmail,input.customerMaster?.email,row.contactEmail,row.customerMaster?.email,task.contactEmail,task.customerMaster?.email);
  const address=first(input.address,row.address,task.address,structuredAddress(input.customerMaster||{}).formatted,structuredAddress(row.customerMaster||{}).formatted,structuredAddress(task.customerMaster||{}).formatted);
  const location=structuredAddress(address&&address!==master.address?{address}:{...master,address},address);
  const customerMaster={...master,...location,name:customer,phone:contactPhone,email:contactEmail,address:address||location.formatted};
  return {...row,customer,contactPhone,contactEmail,address:address||location.formatted,customerMaster,projectContacts:projectContactsFromMaster(customerMaster,{projectContacts:input.projectContacts||row.projectContacts||task.projectContacts}),appointment:input.appointment||row.appointment||task.appointment||null};
}
module.exports={visitWorkflowData};
