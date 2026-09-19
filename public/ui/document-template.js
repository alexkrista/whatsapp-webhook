/* The invoice is the common letterhead. This changes presentation only. */
(function(root,factory){const apply=factory();if(typeof module==="object"&&module.exports)module.exports=apply;else root.KristaDocumentTemplate=apply})(typeof window==="object"?window:globalThis,()=>function applyInvoiceTemplate(paper){
  if(!paper||paper.dataset.invoiceTemplate)return paper;
  paper.dataset.invoiceTemplate="1";
  const doc=paper.ownerDocument,logo=paper.querySelector(".koffer-paper-brand img");
  if(logo)logo.setAttribute("src","/public/document-logo.png");
  for(const table of paper.querySelectorAll("table")){
    const heads=table.querySelector("thead tr"),count=heads?.cells.length;
    if(![4,6].includes(count))continue;
    table.classList.add("krista-invoice-positions");
    const order=count===6?[0,2,3,1,4,5]:[0,1,2,3],keys=count===6?["position","quantity","unit","description","unitPrice","total"]:["position","description","unitPrice","total"];
    for(const row of table.rows){
      const cells=[...row.cells];
      if(cells.length===count&&cells.every(cell=>cell.colSpan===1)){
        order.forEach((index,i)=>{const cell=cells[index];cell.dataset.invoiceCol=keys[i];row.appendChild(cell)});
        for(const cell of row.querySelectorAll('[data-invoice-col="unitPrice"],[data-invoice-col="total"]'))if(cell.tagName==="TD")cell.textContent=cell.textContent.replace(/€\s*/g,"");
      }else if(row.classList.contains("koffer-paper-group")){
        const cell=cells[0],number=cell.querySelector(".koffer-paper-group-number"),prefix=doc.createElement("td");
        prefix.textContent=number?.textContent||"";number?.remove();prefix.colSpan=count===6?3:1;cell.colSpan=count-prefix.colSpan;row.prepend(prefix);
      }
    }
    const labels=count===6?["Pos","Menge","Einh.","Leistung","EP [EUR]","GP [EUR]"]:["Pos","Leistung","EP [EUR]","GP [EUR]"];
    [...heads.cells].forEach((cell,i)=>cell.textContent=labels[i]);
    for(const cell of table.querySelectorAll("td"))if(/^[-−]?\s*€\s*[\d.]+,\d{2}$/.test(cell.textContent.trim()))cell.textContent=cell.textContent.replace(/€\s*/g,"");
    table.querySelector("colgroup")?.remove();const columns=doc.createElement("colgroup");
    for(const width of (count===6?[19.5,12,19,82.5,21,21]:[19.5,113.5,21,21])){const col=doc.createElement("col");col.style.width=`${width/175*100}%`;columns.appendChild(col)}
    table.prepend(columns);
  }
  for(const footer of paper.querySelectorAll(".koffer-paper-company-footer"))footer.innerHTML=`<div class="krista-document-bank">Hypo Vorarlberg Bank AG | IBAN AT82 5800 0104 9932 3013 | BIC HYPVAT2B | ATU36511805 | EORI-Nr. ATEOS1000017548 | DG-Nr. 401425536</div><div class="krista-document-company"><div>Farben Krista GmbH &amp; Co KG<br>Feldkircherstraße 45 | A 6820 Frastanz</div><div>T +43 5522 53940<br>office@krista.at</div><div>FN 15539b<br>www.krista.at</div><div>Unbeschränkt haftender Gesellschafter: Farben Krista GmbH<br>Feldkircherstraße 45, 6820 Frastanz, FN 77707a, Firmenbuchgericht Feldkirch</div></div>`;
  return paper;
});
