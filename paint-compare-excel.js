"use strict";

// Excel-Export fuer den aktuell ausgewaehlten KRISTINE-Farbvergleich.
// Keine Datenbank-/Lagerbuchung: Das Workbook wird ausschliesslich aus den
// angezeigten, vollstaendigen Rezeptdaten des Browsers erzeugt.
const XLSX = require("xlsx");
const {requireAdmin} = require("./admin-auth");

function cleanText(value, max = 180) {
  const raw = String(value == null ? "" : value).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0,max);
  // Spreadsheet/CSV formula injection vermeiden: Nutzereingaben sind Text,
  // nur unsere fest definierten Matrix-Formeln duerfen Formeln sein.
  return /^[=+@-]/.test(raw) ? "'" + raw : raw;
}

function numeric(value, field) {
  if (value === null || value === undefined || value === "") throw Error(field + " fehlt");
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 100000000) throw Error(field + " ungueltig");
  return n;
}

function normalizeItems(payload) {
  const raw = payload && payload.items;
  if (!Array.isArray(raw) || !raw.length) throw Error("Keine Farben fuer den Excel-Export ausgewaehlt.");
  if (raw.length > 40) throw Error("Maximal 40 Farben pro Export.");
  let count = 0;
  return raw.map((entry,index) => {
    const colour = entry && entry.color || {};
    const product = entry && entry.product || {};
    const size = entry && entry.size || {};
    const recipe = entry && entry.recipe || {};
    const name = cleanText(colour.name || colour.code,120);
    if (!name) throw Error("Farbe " + (index+1) + " hat keinen Namen.");
    if (!Array.isArray(recipe.recipe) || !recipe.recipe.length) {
      throw Error("Rezept fuer " + name + " fehlt. Bitte zuerst laden.");
    }
    if (recipe.recipe.length > 100) throw Error("Zu viele Rezeptpositionen fuer " + name);
    const rows = recipe.recipe.map((p,position) => {
      const code = cleanText(p && p.code,60);
      if (!code) throw Error("Pasten-Code fehlt bei " + name + " (Position "+(position+1)+").");
      const units = numeric(p && p.machineUnits,"Einheiten: "+name+" / "+code);
      const ml = numeric(p && p.ml,"ml: "+name+" / "+code);
      return {code, description:cleanText(p.description,140), units, ml};
    });
    count += rows.length;
    if (count > 2500) throw Error("Zu viele Pastenpositionen.");
    const rgb = Array.isArray(colour.rgb) && colour.rgb.length>=3
      ? colour.rgb.slice(0,3).map(Number) : [];
    const hex = rgb.length===3 && rgb.every(n=>Number.isFinite(n)&&n>=0&&n<=255)
      ? "#"+rgb.map(n=>Math.round(n).toString(16).padStart(2,"0")).join("").toUpperCase() : "";
    const unit = Number(recipe.recipeUnitMl);
    return {
      number:index+1, name, code:cleanText(colour.code,120),
      system:cleanText(colour.system,32),
      product:cleanText(product.productName,160),
      base:cleanText(recipe.baseName || product.baseName,140),
      size:cleanText(recipe.canSize || size.size,75),
      formula:cleanText(recipe.formulaId,80),
      factor:Number.isFinite(unit)&&unit>0?unit:null,
      calibration:cleanText(recipe.calibrationNote,300),
      hex, rows,
    };
  });
}

function buildCompareWorkbook(payload, date = new Date()) {
  const colours = normalizeItems(payload);
  const book = XLSX.utils.book_new();
  const allPastes = new Map();
  colours.forEach(c=>c.rows.forEach(r=>{if(!allPastes.has(r.code))allPastes.set(r.code,r.description);}));
  const recipes = [[
    "Vergleich-Nr.","Farbe / Farbton","Farbcode","System","Produkt","Basis","Gebinde",
    "Paste","Bezeichnung","Einheiten","ml","Formel-Nr.","Faktor ml/Einheit","RGB / HEX",
  ]];
  colours.forEach(c=>c.rows.forEach(p=>recipes.push([
    c.number,c.name,c.code,c.system,c.product,c.base,c.size,p.code,p.description,
    p.units,p.ml,c.formula,c.factor,c.hex,
  ])));
  const dataSheet=XLSX.utils.aoa_to_sheet(recipes);
  const dataLast=recipes.length;
  dataSheet["!cols"]=[{wch:14},{wch:26},{wch:21},{wch:11},{wch:25},{wch:19},
    {wch:14},{wch:15},{wch:22},{wch:14},{wch:14},{wch:16},{wch:19},{wch:16}];
  dataSheet["!autofilter"]={ref:"A1:N"+dataLast};
  for(let row=2;row<=dataLast;row++){
    ["J","K"].forEach(col=>{const cell=dataSheet[col+row];if(cell)cell.z=col==="J"?"0.00":"0.000";});
    if(dataSheet["M"+row])dataSheet["M"+row].z="0.00000";
  }
  XLSX.utils.book_append_sheet(book,dataSheet,"Rezeptdaten");

  const dateText=new Intl.DateTimeFormat("de-AT",{dateStyle:"medium",timeStyle:"short",timeZone:"Europe/Vienna"}).format(date);
  const sig=new Set(colours.map(c=>[c.product,c.base,c.size].join("|")));
  const inconsistent=sig.size>1;
  const ncols=2+colours.length*2;
  const matrix=Array.from({length:18+allPastes.size},()=>Array(ncols).fill(null));
  matrix[0][0]="KRISTINE  |  FARBVERGLEICH - MISCHREZEPTE";
  matrix[1][0]="Export: "+dateText+"  |  "+colours.length+" Farben  |  "+allPastes.size+" verschiedene Pasten";
  matrix[2][0]=inconsistent
    ? "ACHTUNG: Produkt, Basis oder Gebinde unterscheiden sich. Rezepte nur eingeschraenkt direkt vergleichbar."
    : "Produkt, Basis und Gebinde stimmen bei allen ausgewaehlten Farben ueberein.";
  matrix[3][0]="Einheiten/ml im Blatt 'Rezeptdaten' bearbeiten; der Vergleich berechnet sich daraus in Excel automatisch.";
  matrix[6][0]="Vergleich-Nr.";
  [["Produkt",7],["Basis",8],["Gebinde",9],["Formel-Nr.",10],["1 Einheit = ml",11]].forEach(([s,r])=>{matrix[r][0]=s;});
  matrix[13][0]="Pasten-Code";
  matrix[13][1]="Bezeichnung";
  const merges=[];
  colours.forEach(c=>{
    const start=2+(c.number-1)*2;
    matrix[5][start]=c.name;
    merges.push({s:{r:5,c:start},e:{r:5,c:start+1}});
    matrix[6][start]=c.number;
    [c.product,c.base,c.size,c.formula,c.factor].forEach((v,i)=>{
      matrix[7+i][start]=v;
      merges.push({s:{r:7+i,c:start},e:{r:7+i,c:start+1}});
    });
    matrix[13][start]="Einheiten";
    matrix[13][start+1]="ml";
  });
  const pasteRows=Array.from(allPastes.entries());
  pasteRows.forEach(([code,description],idx)=>{
    matrix[14+idx][0]=code;
    matrix[14+idx][1]=description;
  });
  const sumRow=15+pasteRows.length;
  matrix[sumRow-1][0]="SUMME";
  const matrixSheet=XLSX.utils.aoa_to_sheet(matrix);
  matrixSheet["!merges"]=merges;
  matrixSheet["!cols"]=[{wch:17},{wch:25},...colours.flatMap(()=>[{wch:14},{wch:14}])];
  const makeCol=idx=>XLSX.utils.encode_col(idx);
  for(let colorIndex=0;colorIndex<colours.length;colorIndex++){
    const first=2+colorIndex*2;
    for(let row=15;row<sumRow;row++){
      const colorColumn=makeCol(first)+"$7";
      for(let x=0;x<2;x++){
        const out=makeCol(first+x)+row;
        const source=x===0?"J":"K";
        matrixSheet[out]={
          t:"n", f:"SUMIFS('Rezeptdaten'!$"+source+"$2:$"+source+"$"+dataLast+
            ",'Rezeptdaten'!$A$2:$A$"+dataLast+","+colorColumn+
            ",'Rezeptdaten'!$H$2:$H$"+dataLast+",$A"+row+")",
          z:x===0?"0.00":"0.000",
        };
      }
    }
    for(let x=0;x<2;x++){
      const col=makeCol(first+x);
      matrixSheet[col+sumRow]={
        t:"n", f:"SUM("+col+"15:"+col+(sumRow-1)+")",
        z:x===0?"0.00":"0.000",
      };
    }
  }
  XLSX.utils.book_append_sheet(book,matrixSheet,"Rezeptvergleich");

  const noteSheet=XLSX.utils.aoa_to_sheet([
    ["KRISTINE | Farben vergleichen | Excel-Export"],
    ["Stand",dateText],
    ["Farben",colours.length],
    ["Datenquelle","KRISTINE Farbsuche > Farben vergleichen > Als Excel exportieren"],
    [],
    ["Blatt","Verwendung"],
    ["Rezeptdaten","Vollstaendige Einzelrezepturen. Einheiten und ml sind echte Excel-Zahlen und koennen hier bearbeitet werden."],
    ["Rezeptvergleich","Alle ausgewaehlten Farben mit jeweils Einheiten und ml nebeneinander; die Summen sind Excel-Formeln."],
    ["Aktualisierung","Aenderungen in Rezeptdaten werden im Vergleich bei automatischer Excel-Neuberechnung sichtbar."],
    ["Pasten ohne Eintrag","In der Vergleichsmatrix als 0 dargestellt (die Paste ist im betreffenden Rezept nicht enthalten)."],
    ["Unterschiedliche Basen","Beim Vergleich von Produkten, Basen oder Gebinden sind Einheiten-/ml-Mengen nur eingeschraenkt direkt vergleichbar."],
    ["Farbwirkung","RGB/HEX-Werte, soweit vorhanden, stehen zur Weiterverarbeitung in Rezeptdaten."],
    ["Original","Nur exportiert: keine Aenderung an Innovatint, KRISTINE-Lager oder den Originalrezepten."],
    ["Hinweis","Dieser Export enthaelt "+colours.length+" ausgewählte Farbe(n). Jedes Rezept ist vollstaendig exportiert."],
  ]);
  noteSheet["!cols"]=[{wch:27},{wch:120}];
  XLSX.utils.book_append_sheet(book,noteSheet,"Hinweise");
  book.Workbook=book.Workbook || {};
  book.Workbook.CalcPr={calcMode:"auto",fullCalcOnLoad:true,forceFullCalc:true};
  return {workbook:book,buffer:XLSX.write(book,{bookType:"xlsx",type:"buffer"}),colourCount:colours.length,recipeCount:recipes.length-1,inconsistent};
}

function registerPaintCompareExcel(app) {
  app.post("/admin/api/paint/compare/export-xlsx",(req,res)=>{
    if(!requireAdmin(req,res))return;
    try {
      const result=buildCompareWorkbook(req.body||{});
      const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const filename="KRISTINE_Farbvergleich_"+today+"_"+result.colourCount+"_Farben.xlsx";
      res.set("Cache-Control","no-store");
      res.set("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.set("Content-Disposition",'attachment; filename="'+filename+'"');
      res.send(result.buffer);
    } catch(error) {
      res.status(400).json({ok:false,error:String(error.message||error)});
    }
  });
}

module.exports={buildCompareWorkbook,registerPaintCompareExcel};
