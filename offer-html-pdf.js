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
    const isConfirmation=!!(await page.$(".koffer-paper[data-order-confirmation]"));
    let confirmationOptions={};
    if(isConfirmation){
      const footer=await page.evaluate(()=>{
        const node=document.querySelector(".koffer-paper-company-footer")?.cloneNode(true);
        if(!node)throw new Error("Fußzeile der Auftragsbestätigung fehlt.");
        node.querySelector(".koffer-paper-footer-page").innerHTML='Seite <span class="pageNumber"></span> / <span class="totalPages"></span>';
        return node.outerHTML;
      });
      const footerCss='<style>.koffer-paper-company-footer{box-sizing:border-box;width:100%;margin:0 14mm;padding-top:2mm;border-top:1px solid #222;font:7.5px Arial,sans-serif;color:#333;line-height:1.3}.koffer-paper-footer-page{text-align:right;margin-bottom:4px;font-size:8px}.koffer-paper-bank-warning{color:#e21b23;text-align:center;font-size:8px;font-weight:600}.koffer-paper-company-main{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:5px;font-size:7px}.koffer-paper-company-main span+span:before{content:"|";margin-right:6px}.koffer-paper-company-columns{display:grid;grid-template-columns:1.35fr .85fr .75fr 2fr;gap:2mm;margin-top:5px}.koffer-paper-company-columns>div{white-space:normal}</style>';
      confirmationOptions={displayHeaderFooter:true,headerTemplate:"<div></div>",footerTemplate:footerCss+footer,margin:{top:"14mm",right:"14mm",bottom:"34mm",left:"14mm"}};
    }
    const pdf=await page.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,margin:{top:0,right:0,bottom:0,left:0},...confirmationOptions});
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
