"use strict";

const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const fs = require("node:fs");
const { PDFDocument } = require("pdf-lib");
const { renderOfferLegalHtml } = require("./offer-terms");

async function browserExecutable() {
  if(process.platform!=="win32")return chromium.executablePath();
  const candidates=[process.env.PUPPETEER_EXECUTABLE_PATH,"C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].filter(Boolean);
  const executable=candidates.find(file=>fs.existsSync(file));
  if(!executable)throw new Error("Für die lokale PDF-Prüfung wurde kein Chrome/Edge gefunden.");
  return executable;
}

async function renderOfferHtmlPdf(html) {
  const source=String(html||"");
  if(!source.includes("koffer-paper")||source.length>5*1024*1024)throw new Error("Ungültige Angebotsansicht.");
  const browser=await puppeteer.launch({
    args:process.platform==="win32"?["--no-sandbox","--disable-setuid-sandbox"]:chromium.args,
    defaultViewport:{width:1280,height:1800,deviceScaleFactor:1},
    executablePath:await browserExecutable(),
    headless:true,
  });
  try{
    const page=await browser.newPage();
    await page.setContent(source,{waitUntil:["load","networkidle0"],timeout:30000});
    await page.emulateMediaType("print");
    const pdf=await page.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,margin:{top:0,right:0,bottom:0,left:0}});
    return Buffer.from(pdf);
  }finally{await browser.close()}
}

async function appendOfferLegalAnnex(offerPdf) {
  const [offer,annex]=await Promise.all([PDFDocument.load(offerPdf),renderOfferHtmlPdf(renderOfferLegalHtml()).then(PDFDocument.load)]);
  const pages=await offer.copyPages(annex,annex.getPageIndices());
  for(const page of pages)offer.addPage(page);
  return Buffer.from(await offer.save());
}

module.exports={renderOfferHtmlPdf,appendOfferLegalAnnex};
