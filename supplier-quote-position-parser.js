"use strict";
function money(raw){
 const x=String(raw||"").trim().replace(/\s/g,"").replace(/[^0-9.,-]/g,"");if(!x)return NaN;
 const c=x.lastIndexOf(","),p=x.lastIndexOf(".");
 let normalized=x;
 if(c>=0&&p>=0)normalized=c>p?x.replace(/\./g,"").replace(",","."):x.replace(/,/g,"");
 else if(c>=0)normalized=x.replace(",",".");
 else if(p>=0&&/^\d{1,3}(\.\d{3})+$/.test(x))normalized=x.replace(/\./g,"");
 const result=Number(normalized);return Number.isFinite(result)&&result>=0?result:NaN;
}
function parse(text){
 const lines=String(text||"").replace(/\r/g,"").split("\n").map(s=>s.trim()).filter(Boolean);
 const results=[];
 for(let i=0;i<lines.length;i++){
  const row=lines[i].replace(/\s+/g," ");
  if(/^(?:summe|gesamt|zwischensumme|nettobetrag|bruttobetrag|umsatzsteuer|mehrwertsteuer|rabatt|lieferbedingungen|transportkosten)\b/i.test(row))continue;
  // Rows of the form: Position / article number / description / quantity unit / unit price / total
  const numeric=row.match(/^(?:(\d{1,3})[.)]?\s+)?(?:(\d{4,}[\w./-]*)\s+)?(.+?)\s+(\d+(?:[.,]\d+)?)\s*(m2|m²|m|lfm|kg|g|Stk\.?|Stück|Sack|Pak\.?|VE|Platte|Rolle|Eimer)\s+([\d.,]+)(?:\s*(?:€|EUR))?(?:\s+([\d.,]+))?(?:\s*(?:€|EUR))?$/i);
  if(numeric){
   const qty=money(numeric[4]),price=money(numeric[6]);
   if(Number.isFinite(qty)&&Number.isFinite(price)&&qty>0&&numeric[3].length>=3){
    results.push({positionNumber:numeric[1]||"",articleNumber:numeric[2]||"",name:numeric[3].slice(0,180),quantity:qty,unit:numeric[5].replace(/\.$/,""),unitPrice:price,lineTotal:Number.isFinite(money(numeric[7]))?money(numeric[7]):null,sourceLine:row.slice(0,400),confidence:"medium"});
   }
  }
 }
 return results.slice(0,150);
}
module.exports={parse,money};
