"use strict";
const express=require("express");
const {archiveInvoice}=require("./issued-invoice-project-archive");

function registerInvoiceArchiveRoute(app,{dataDir,requireAdmin}){
  if(!dataDir||typeof requireAdmin!=="function")throw TypeError("Archive requires dataDir and admin authorization");
  app.post("/admin/api/job/:jobId/documentation/issued-invoice",
    (req,res,next)=>{if(!requireAdmin(req,res,{allowBrowserSession:false}))return;next()},
    express.raw({type:"application/pdf",limit:"20mb"}),
    async(req,res)=>{
      const h=req.headers;
      try {
        const result=await archiveInvoice(dataDir,{
          project:req.params.jobId,
          number:h["x-invoice-number"],
          invoiceId:h["x-invoice-id"],
          source:h["x-invoice-source"],
          kind:h["x-invoice-kind"],
          date:h["x-invoice-date"],
          digest:h["x-invoice-sha256"],
        },req.body);
        res.status(result.created?201:200).json({ok:true,...result});
      }catch(error){
        const detail=String(error.message||"Archivierung fehlgeschlagen");
        const status=detail.includes("nicht angelegt")?404:detail.includes("Abweichend")?409:400;
        res.status(status).json({ok:false,error:detail});
      }
    }
  );
}
module.exports={registerInvoiceArchiveRoute};
