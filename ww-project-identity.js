"use strict";

const GENERIC = new Set([
  "gmbh","gesmbh","gesellschaft","company","firma","projekt","baustelle","auftrag",
  "arbeiten","malen","maler","fenster","sanierung","umbau","neubau","haus",
  "wohnung","privat","herr","frau","krista","installation","einrichtung","material"
]);

function words(value) {
  return new Set(String(value||"").normalize("NFKD").toLocaleLowerCase("de-AT")
    .replace(/[\u0300-\u036f]/g,"").split(/[^a-z0-9]+/)
    .filter(word=>word.length>=4&&!GENERIC.has(word)));
}

function checkWwProjectIdentity(project, meta, projectNumber) {
  if(!meta||typeof meta!=="object")
    return {ok:false,reason:"KRISTINE-Kundendaten fehlen; keine automatische WinWorker-Zuordnung."};
  const number=String(projectNumber||"").trim();
  if(number&&number!==String(project?.projectNumber||"").trim())
    return {ok:false,reason:"WinWorker-Projektnummer widerspricht der KRISTINE-Baustelle."};
  const index=Number(project?.projectIndex||0);
  if(!index)return {ok:false,reason:"Eindeutiger WinWorker-Projektindex fehlt."};
  const explicit=[...(Array.isArray(meta.wwProjectLinks)?meta.wwProjectLinks:[]),
    {projectNumber:meta.wwProjectNumber,projectIndex:meta.wwProjectIndex}]
    .filter(link=>String(link?.projectNumber||"").trim()===number&&Number(link?.projectIndex)>0);
  if(explicit.length) {
    if(explicit.some(link=>Number(link.projectIndex)===index))return {ok:true,source:"explicit-project-index"};
    return {ok:false,reason:"WinWorker-Projektindex passt nicht zur ausdrücklich zugeordneten KRISTINE-Akte."};
  }
  const wwCustomerIndex=Number(project?.customerIndex||0);
  const expectedCustomerIndex=Number(meta.projectContacts?.owner?.wwAddressId||meta.customerMaster?.wwAddressId||0);
  if(expectedCustomerIndex>0&&wwCustomerIndex>0&&expectedCustomerIndex!==wwCustomerIndex)
    return {ok:false,reason:"WinWorker-Kunden-ID passt nicht zum Kunden der KRISTINE-Baustelle."};
  const expected=new Set();
  for(const text of [meta.name,meta.contactName,meta.customerMaster?.name,
    meta.customerMaster?.company,meta.projectContacts?.owner?.customer])
    for(const part of words(text))expected.add(part);
  const actual=new Set();
  for(const text of [project.title,project.company,project.customer])
    for(const part of words(text))actual.add(part);
  if([...expected].some(part=>actual.has(part)))return {ok:true,source:"verified-customer-name"};
  const current=String(meta.name||meta.contactName||"ohne Kundenname").slice(0,90);
  const foreign=String(project.company||project.title||"ohne Kundenname").slice(0,90);
  return {ok:false,reason:
    "Nummernkollision: KRISTINE "+number+" ("+current+") und WinWorker "+
    number+" ("+foreign+") gehören nicht nachweisbar zusammen. Automatische Übernahme gesperrt."};
}

module.exports={words,checkWwProjectIdentity};
