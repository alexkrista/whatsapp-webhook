"use strict";
(function () {
  if (document.getElementById("paintInventoryReadability")) return;
  const style = document.createElement("style");
  style.id = "paintInventoryReadability";
  style.textContent = `
    /* Lager / Inventur: mehr Ruhe, bessere Zeilenorientierung */
    .inv-headrow{
      background:#e9ece8!important;
      color:#465149!important;
      padding:7px 8px!important;
      margin:0 -8px!important;
      border-radius:7px!important;
      font-size:12px!important;
    }
    .inv-row{
      padding:9px 8px!important;
      margin:0 -8px!important;
      border-top:1px solid #e4e7e2!important;
      font-size:14px!important;
    }
    .inv-size > .inv-row:nth-child(even){background:#f3f4f1!important}
    .inv-size > .inv-row:nth-child(odd){background:#fff!important}
    .inv-base{font-size:14px!important}
    .inv-code{font-size:11px!important;color:#747b75!important}
    .inventory-suggest{
      min-height:36px!important;
      display:flex!important;
      align-items:center!important;
      justify-content:flex-end!important;
      font-size:15px!important;
    }
    /* 0 ist neutral. Nur echter Bestellbedarf wird farblich hervorgehoben. */
    .inventory-suggest.ok{color:#69726c!important;font-weight:750!important}
    .inventory-suggest.need{color:#a85408!important;font-weight:950!important}

    /* Soll-/Mindest-Schnellliste */
    .plan-list-head{
      background:#e9ece8!important;
      color:#3f4942!important;
      padding:9px 10px!important;
      margin:0 -10px!important;
      font-size:12px!important;
      border-bottom:1px solid #cfd5cf!important;
    }
    .plan-list-row{
      padding:9px 10px!important;
      margin:0 -10px!important;
      border-bottom:1px solid #e2e5e0!important;
      font-size:14px!important;
    }
    .plan-list-row:nth-child(even){background:#f3f4f1!important}
    .plan-list-row:nth-child(odd){background:#fff!important}
    .plan-list-row.dirty{background:#fff1cf!important}
    .plan-list-num{
      min-height:36px!important;
      font-size:15px!important;
      background:#fff!important;
      border-color:#9fa8a0!important;
    }
    .plan-list-code{font-size:11px!important;color:#707871!important}

    @media(max-width:860px){
      .inventory-suggest{justify-content:flex-start!important}
      .inv-row{padding:11px 9px!important;margin:0 -9px!important}
    }
    @media(max-width:760px){
      .plan-list-row{padding:11px 9px!important;margin:0 -9px!important}
      .plan-list-num{font-size:16px!important}
    }
  `;
  document.head.appendChild(style);
})();
