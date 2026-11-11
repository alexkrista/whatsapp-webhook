"use strict";
function money(raw){
 const x=String(raw??"").trim().replace(/\s/g,"").replace(/[^0-9.,-]/g,"");if(!x)return NaN;
 const c=x.lastIndexOf(","),p=x.lastIndexOf(".");let normalized=x;
 if(c>=0&&p>=0)normalized=c>p?x.replace(/\./g,"").replace(",","."):x.replace(/,/g,"");
 else if(c>=0)normalized=x.replace(",",".");
 else if(p>=0&&/^\d{1,3}(\.\d{3})+$/.test(x))normalized=x.replace(/\./g,"");
 const result=Number(normalized);return Number.isFinite(result)&&result>=0?result:NaN;
}
function packaging(description,unit,pricePerUnit){
 const text=String(description||"").replace(/\s+/g," ");
 // 'A 25KG', '20 KG EIMER', '100 STK.', '50X1M' and similar common supplier pack descriptions.
 const kg=text.match(/\b(?:A\s*)?(\d+(?:[,.]\d+)?)\s*KG\b/i);
 const count=text.match(/\b(?:A\s*)?(\d+(?:[,.]\d+)?)\s*STK\.?\b/i);
 const grams=text.match(/\b(?:A\s*)?(\d+(?:[,.]\d+)?)\s*G\b/i);
 const upper=String(unit||"").toUpperCase().replace(/\.$/,"");
 if(pricePerUnit==='KG'||upper==='KG')return{packContent:1,calcUnit:'KG'};
 if(pricePerUnit==='QMT'||upper==='QMT'||upper==='M²'||upper==='M2')return{packContent:1,calcUnit:'m²'};
 if(pricePerUnit==='STK'||upper==='STK')return{packContent:1,calcUnit:'STK'};
 if(kg)return{packContent:money(kg[1]),calcUnit:'KG'};
 if(count)return{packContent:money(count[1]),calcUnit:'STK'};
 if(grams)return{packContent:money(grams[1])/1000,calcUnit:'KG'};
 return{packContent:1,calcUnit:upper||'Stk'};
}
function parse(text){
 const lines=String(text||"").replace(/\r/g,"").split("\n").map(v=>v.trim()).filter(Boolean);
 const results=[],unit='(?:QMT|M2|M²|m²|lfm|KG|GEB|GEB\.|STK\.?|Stück|SACK|PAK\.?|ROL|Rolle|Eimer|VE|m|g)';
 // Allow either '20 16610235 LEHMKLEBER 8,000 SACK 32,63 261,04' or alternative row without position index.
 const rowPattern=new RegExp('^(?:(\\d{1,3})[.)]?\\s+)?(\\d{5,}[A-Za-z0-9./-]*)\\s+(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*('+unit+')\\s+([\\d.,]+)(?:\\s+([\\d.,]+))?(?:\\s*(?:EUR|€))?$','i');
 const fallbackPattern=new RegExp('^(?:(\\d{1,3})[.)]?\\s+)?(?:(\\d{4,}[A-Za-z0-9./-]*)\\s+)?(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*('+unit+')\\s+([\\d.,]+)(?:\\s+([\\d.,]+))?(?:\\s*(?:EUR|€))?$','i');
 const stops=/^(?:Variante|[_=]{3,}|PosNr|Menge\s+ME|Nettobetrag|MWST|Endbetrag|Summe|Sehr geehrte|Wir danken|Preis|Telefon|Telefax|Angebot|Firma|Seite\b)/i;
 const likelyExtra=/^(?:\d+[.,]\d+\s+(?:KG|GEB|ROL|STK|PAK|SACK|QMT)|1\s+(?:KG|GEB|ROL|STK|PAK|SACK|QMT)|\(?\d+[-–]\d+\s*m²\b)/i;
 for(let i=0;i<lines.length;i++){
  const row=lines[i].replace(/\s+/g,' ');
  if(stops.test(row))continue;
  const m=row.match(rowPattern)||row.match(fallbackPattern);if(!m)continue;
  const qty=money(m[4]),price=money(m[6]);
  if(!Number.isFinite(qty)||!Number.isFinite(price)||qty<=0||m[3].length<3)continue;
  let name=m[3],basis='',continuation=[];
  for(let j=i+1;j<Math.min(lines.length,i+7);j++){
   const next=lines[j].replace(/\s+/g,' ');
   if(stops.test(next)||rowPattern.test(next)||fallbackPattern.test(next))break;
   if(/(?:^|\s)1(?:[.,]0+)?\s*(KG|QMT|STK|SACK|PAK|GEB|ROL)(?:\s|$)/i.test(next)){const b=next.match(/1(?:[.,]0+)?\s*(KG|QMT|STK|SACK|PAK|GEB|ROL)/i);basis=b?.[1]?.toUpperCase()||basis}
   // Retain actual product continuation, remove price basis annotations.
   const cleaned=next.replace(/\b1(?:[.,]0+)?\s*(?:KG|QMT|STK|SACK|PAK|GEB|ROL)\s*$/i,'').trim();
   if(cleaned&& !/^(?:\d+\s*EUR|\d+\s*QMT)$/i.test(cleaned))continuation.push(cleaned);
   i=j;
  }
  name=[name,...continuation].join(' ').replace(/\s+/g,' ').trim();
  const conversion=packaging(name,m[5],basis);
  // Price 'per 1 unit' is from supplier; pack content is separate for costing.
  const each=Math.max(0,conversion.packContent)||1;
  const priceByUnit=+(price/each).toFixed(6);
  results.push({positionNumber:m[1]||'',articleNumber:m[2]||'',name:name.slice(0,500),quantity:qty,unit:m[5].replace(/\.$/,''),unitPrice:price,lineTotal:Number.isFinite(money(m[7]))?money(m[7]):null,packContent:each,calcUnit:conversion.calcUnit,calcUnitPrice:priceByUnit,sourceLine:row.slice(0,400),confidence:'medium'});
 }
 return results.slice(0,150);
}
module.exports={parse,money,packaging};
