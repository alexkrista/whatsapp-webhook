(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.KristaProjectAddress=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const text=value=>String(value??'').replace(/\s+/g,' ').trim();
  function formatted(value){
    const parts=String(value||'').split(/[,\r\n]+/).map(text).filter(Boolean);
    if(parts.length>=3&&/^\d+[A-Za-z]?(?:[\/-]\d+[A-Za-z]?)?$/.test(parts[1])&&/^\d{4,6}\s+/.test(parts[2]))parts.splice(0,2,parts[0]+' '+parts[1]);
    let streetLine=parts[0]||'',placeLine=parts[1]||'';
    if(!placeLine){const match=streetLine.match(/^(.*?)\s+(?:[A-Za-z]{1,3}-)?(\d{4,6})\s+([^\d].*)$/);if(match){streetLine=match[1];placeLine=match[2]+' '+match[3]}}
    const place=placeLine.match(/^(?:[A-Za-z]{1,3}-)?(\d{4,6})\s+(.+)$/),street=streetLine.match(/^(.*?)\s+(\d+[A-Za-z]?(?:[\/-]\d+[A-Za-z]?)?)$/);
    return {street:text(street?.[1]||streetLine),houseNumber:text(street?.[2]),postalCode:text(place?.[1]),city:text(place?.[2]||placeLine)};
  }
  function parse(value){
    const row=typeof value==='string'?{address:value}:value||{},address=formatted(row.address),street=formatted(row.street||row.streetName);
    return {street:street.street||address.street,houseNumber:text(row.houseNumber||row.houseNo)||street.houseNumber||address.houseNumber,postalCode:text(row.postalCode||row.zip||row.postcode)||street.postalCode||address.postalCode,city:text(row.city||row.town)||street.city||address.city};
  }
  return {parse};
});
