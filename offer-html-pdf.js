"use strict";

const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const fs = require("node:fs");
const path = require("node:path");
const {readLayout,layoutCss}=require("./document-layout");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const applyInvoiceTemplate=require("./public/ui/document-template");
const { renderOfferLegalHtml } = require("./offer-terms");

async function browserExecutable() {
  if(process.platform!=="win32")return chromium.executablePath();
  const candidates=[process.env.PUPPETEER_EXECUTABLE_PATH,"C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].filter(Boolean);
  const executable=candidates.find(file=>fs.existsSync(file));
  if(!executable)throw new Error("Für die lokale PDF-Prüfung wurde kein Chrome/Edge gefunden.");
  return executable;
}

function cleanRecipient(value) {
  if (!value || typeof value !== "object") return null;
  const lines = key => (Array.isArray(value[key]) ? value[key] : []).map(line => String(line ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const recipient = { nameLines:lines("nameLines"), addressLines:lines("addressLines") };
  if (!recipient.nameLines.length) throw Object.assign(new Error("Der PDF-Empfänger ist unvollständig."), { status:409 });
  return recipient;
}

async function applyDocumentRecipient(page, options) {
  let recipient = cleanRecipient(options.recipient);
  if (!recipient && typeof options.resolveRecipient === "function") {
    let jobId = String(options.jobId || "").trim();
    if (!jobId && options.inferRecipientJobId) {
      const project = await page.$eval(".koffer-paper-project strong", node => node.textContent || "").catch(() => "");
      const match = project.match(/^\s*Projekt:\s*([A-Za-z0-9_-]+)\s*$/);
      jobId = match?.[1] || "";
    }
    if (jobId) recipient = cleanRecipient(await options.resolveRecipient(jobId));
  }
  if (!recipient) {
    if (options.requireRecipient) throw Object.assign(new Error("Der PDF-Empfänger konnte nicht aus den Stammdaten ermittelt werden."), { status:409 });
    return;
  }
  const replaced = await page.evaluate(model => {
    const node = document.querySelector(".koffer-paper-recipient");
    if (!node) return false;
    node.replaceChildren();
    for (const line of model.nameLines) {
      const element = document.createElement("strong");
      element.textContent = line;
      node.append(element);
    }
    for (const line of model.addressLines) {
      const element = document.createElement("span");
      element.textContent = line;
      node.append(element);
    }
    return true;
  }, recipient);
  if (!replaced) throw Object.assign(new Error("Das PDF enthält kein Empfängerfeld."), { status:400 });
}

async function renderOfferHtmlPdf(html,options={}) {
  let source=String(html||"");
  if(!source.includes("koffer-paper")||source.length>5*1024*1024)throw new Error("Ungültige Angebotsansicht.");
  source=source.replace(/@page(?:\s*:[\w-]+)?\s*\{[^}]*\}/g, "");
  const layout=options.layout||await readLayout(process.env.DATA_DIR||path.join(process.cwd(),"data"));
  const base=process.env.PUBLIC_BASE_URL||"https://protokoll.krista.at";
  if(!source.includes("<base "))source=source.replace("<head>",`<head><base href="${base}/">`);
  source=source.replace("</head>",`<style>${layoutCss(layout)}</style></head>`);
  const browser=await puppeteer.launch({
    args:process.platform==="win32"?["--no-sandbox","--disable-setuid-sandbox"]:chromium.args,
    defaultViewport:{width:1280,height:1800,deviceScaleFactor:1},
    executablePath:await browserExecutable(),
    headless:true,
  });
  try{
    const page=await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request",request=>{
      const pathname=new URL(request.url()).pathname;
      // Old editor windows still reference this retired stylesheet. The server's
      // common invoice layout is authoritative for every generated document.
      if(pathname==="/public/ui/order-confirmation-print.css")return request.respond({status:200,contentType:"text/css",body:""});
      if(pathname==="/public/document-layout.css")return request.respond({status:200,contentType:"text/css",body:layoutCss(layout)});
      const local=pathname==="/public/document-logo.png"?path.join(__dirname,"assets/krista_invoice_logo.png"):pathname.startsWith("/public/fonts/")?path.join(__dirname,"public/fonts",path.basename(pathname)):null;
      if(local&&fs.existsSync(local))return request.respond({status:200,contentType:local.endsWith(".png")?"image/png":"font/ttf",body:fs.readFileSync(local)});
      request.continue();
    });
    await page.setContent(source,{waitUntil:["load","networkidle0"],timeout:30000});
    await applyDocumentRecipient(page,options);
    await page.emulateMediaType("print");
    await page.evaluate(()=>document.fonts.ready);
    await page.evaluate(applyInvoiceTemplate, await page.$(".koffer-paper"));
    const letterhead=await page.$(".koffer-paper-page-one");
    const footer=await page.evaluate(()=>{
      const node=document.querySelector(".koffer-paper-company-footer");
      return {bank:node?.querySelector(".krista-document-bank")?.innerText||"",columns:[...(node?.querySelectorAll(".krista-document-company>div")||[])].map(cell=>cell.innerText.split("\n"))};
    });
    await page.evaluate(()=>document.documentElement.classList.add("krista-pdf-render"));
    const pdf=await page.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false,
      margin:{top:`${layout.firstPage.topMm}mm`,right:`${layout.firstPage.rightMm}mm`,bottom:`${layout.firstPage.bottomMm}mm`,left:`${layout.firstPage.leftMm}mm`}});
    const document=await PDFDocument.load(pdf),logo=await document.embedPng(fs.readFileSync(path.join(__dirname,"assets/krista_invoice_logo.png"))),pages=document.getPages(),font=await document.embedFont(StandardFonts.Helvetica);
    // Same absolute letterhead, logo crop and footer positions as the existing invoice.
    const {pushGraphicsState,popGraphicsState,rectangle,clip,endPath}=require("pdf-lib"),mm=72/25.4;
    for(const [index,sheet] of pages.entries()){
      const p=index===0?layout.firstPage:layout.followingPages,w=p.logoWidthMm*mm,fullWidth=w/.42,h=fullWidth*235/1260,x=sheet.getWidth()-p.rightMm*mm-w+3.748,y=sheet.getHeight()-(index===0?114:20*mm);
      if(letterhead){sheet.pushOperators(pushGraphicsState(),rectangle(x,y,w,h),clip(),endPath());sheet.drawImage(logo,{x:x-.58*fullWidth,y,width:fullWidth,height:h});sheet.pushOperators(popGraphicsState())}
      sheet.drawText(`Seite ${index+1}/${pages.length}`,{x:layout.firstPage.leftMm*mm,y:sheet.getHeight()-10*mm,font,size:8.2});
      if(footer.bank)sheet.drawText(footer.bank,{x:36.7,y:48,font,size:7.92});
      footer.columns.forEach((lines,column)=>lines.slice(0,2).forEach((line,row)=>sheet.drawText(line,{x:[36.5,168.6,249.1,334.1][column],y:row===0?32.5:22.7,font,size:6.84})));
    }
    document.setSubject(`KRISTA Formularvorlage ${layout.revision||"Standardrechnung"}`);
    return Buffer.from(await document.save());
  }finally{await browser.close()}
}

async function appendOfferLegalAnnex(offerPdf) {
  const [offer,annex]=await Promise.all([PDFDocument.load(offerPdf),renderOfferHtmlPdf(renderOfferLegalHtml()).then(PDFDocument.load)]);
  const pages=await offer.copyPages(annex,annex.getPageIndices());
  for(const page of pages)offer.addPage(page);
  return Buffer.from(await offer.save());
}

module.exports={renderOfferHtmlPdf,appendOfferLegalAnnex};
