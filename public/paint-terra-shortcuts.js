"use strict";
(() => {
  const host = document.getElementById("tab-search");
  if (!host || document.getElementById("paintTerraShortcuts")) return;
  const panel=document.createElement("section");
  panel.id="paintTerraShortcuts";
  panel.className="card";
  panel.innerHTML='<h2>Mischungen &amp; Terra-Rechner</h2><p class="muted">Direkt zu den gespeicherten Mischungen oder zum Terra-Mischrechner mit Icon Fein, Icon Mittel und POWER.</p><div class="systems"><button type="button" class="btn primary" id="paintOpenMixHistory">Mischungen öffnen</button><button type="button" class="btn" id="paintOpenTerraCalc">Terra-Mischrechner öffnen</button></div>';
  host.appendChild(panel);
  panel.querySelector("#paintOpenMixHistory").addEventListener("click",()=>{
    const btn=document.querySelector('.tabs [data-tab="mixes"]');
    if (btn) {btn.click(); document.getElementById("mixHistoryCard")?.scrollIntoView({block:"start",behavior:"smooth"});}
    else alert("Mischhistorie ist auf dieser Seite nicht verfügbar.");
  });
  panel.querySelector("#paintOpenTerraCalc").addEventListener("click",()=>{
    window.location.href="/public/kristine-go.html#kgTerraMix";
  });
})();
