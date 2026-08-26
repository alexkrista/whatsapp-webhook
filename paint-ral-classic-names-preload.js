"use strict";

const express = require("express");

// Offizielle deutsche RAL CLASSIC Farbnamen (216 Farbtöne).
// Es werden bewusst nur Namen/Nummern verwendet, keine geschützten Farbwerte.
const RAL_CLASSIC_NAMES = Object.freeze({
  "1000":"Grünbeige","1001":"Beige","1002":"Sandgelb","1003":"Signalgelb","1004":"Goldgelb","1005":"Honiggelb","1006":"Maisgelb","1007":"Narzissengelb","1011":"Braunbeige","1012":"Zitronengelb","1013":"Perlweiß","1014":"Elfenbein","1015":"Hellelfenbein","1016":"Schwefelgelb","1017":"Safrangelb","1018":"Zinkgelb","1019":"Graubeige","1020":"Olivgelb","1021":"Rapsgelb","1023":"Verkehrsgelb","1024":"Ockergelb","1026":"Leuchtgelb","1027":"Currygelb","1028":"Melonengelb","1032":"Ginstergelb","1033":"Dahliengelb","1034":"Pastellgelb","1035":"Perlbeige","1036":"Perlgold","1037":"Sonnengelb",
  "2000":"Gelborange","2001":"Rotorange","2002":"Blutorange","2003":"Pastellorange","2004":"Reinorange","2005":"Leuchtorange","2007":"Leuchthellorange","2008":"Hellrotorange","2009":"Verkehrsorange","2010":"Signalorange","2011":"Tieforange","2012":"Lachsorange","2013":"Perlorange","2017":"RAL Orange",
  "3000":"Feuerrot","3001":"Signalrot","3002":"Karminrot","3003":"Rubinrot","3004":"Purpurrot","3005":"Weinrot","3007":"Schwarzrot","3009":"Oxidrot","3011":"Braunrot","3012":"Beigerot","3013":"Tomatenrot","3014":"Altrosa","3015":"Hellrosa","3016":"Korallenrot","3017":"Rosé","3018":"Erdbeerrot","3020":"Verkehrsrot","3022":"Lachsrot","3024":"Leuchtrot","3026":"Leuchthellrot","3027":"Himbeerrot","3028":"Reinrot","3031":"Orientrot","3032":"Perlrubinrot","3033":"Perlrosa",
  "4001":"Rotlila","4002":"Rotviolett","4003":"Erikaviolett","4004":"Bordeauxviolett","4005":"Blaulila","4006":"Verkehrspurpur","4007":"Purpurviolett","4008":"Signalviolett","4009":"Pastellviolett","4010":"Telemagenta","4011":"Perlviolett","4012":"Perlbrombeer",
  "5000":"Violettblau","5001":"Grünblau","5002":"Ultramarinblau","5003":"Saphirblau","5004":"Schwarzblau","5005":"Signalblau","5007":"Brillantblau","5008":"Graublau","5009":"Azurblau","5010":"Enzianblau","5011":"Stahlblau","5012":"Lichtblau","5013":"Kobaltblau","5014":"Taubenblau","5015":"Himmelblau","5017":"Verkehrsblau","5018":"Türkisblau","5019":"Capriblau","5020":"Ozeanblau","5021":"Wasserblau","5022":"Nachtblau","5023":"Fernblau","5024":"Pastellblau","5025":"Perlenzian","5026":"Perlnachtblau",
  "6000":"Patinagrün","6001":"Smaragdgrün","6002":"Laubgrün","6003":"Olivgrün","6004":"Blaugrün","6005":"Moosgrün","6006":"Grauoliv","6007":"Flaschengrün","6008":"Braungrün","6009":"Tannengrün","6010":"Grasgrün","6011":"Resedagrün","6012":"Schwarzgrün","6013":"Schilfgrün","6014":"Gelboliv","6015":"Schwarzoliv","6016":"Türkisgrün","6017":"Maigrün","6018":"Gelbgrün","6019":"Weißgrün","6020":"Chromoxidgrün","6021":"Blaßgrün","6022":"Braunoliv","6024":"Verkehrsgrün","6025":"Farngrün","6026":"Opalgrün","6027":"Lichtgrün","6028":"Kieferngrün","6029":"Minzgrün","6032":"Signalgrün","6033":"Minttürkis","6034":"Pastelltürkis","6035":"Perlgrün","6036":"Perlopalgrün","6037":"Reingrün","6038":"Leuchtgrün","6039":"Fasergrün",
  "7000":"Fehgrau","7001":"Silbergrau","7002":"Olivgrau","7003":"Moosgrau","7004":"Signalgrau","7005":"Mausgrau","7006":"Beigegrau","7008":"Khakigrau","7009":"Grüngrau","7010":"Zeltgrau","7011":"Eisengrau","7012":"Basaltgrau","7013":"Braungrau","7015":"Schiefergrau","7016":"Anthrazitgrau","7021":"Schwarzgrau","7022":"Umbragrau","7023":"Betongrau","7024":"Graphitgrau","7026":"Granitgrau","7030":"Steingrau","7031":"Blaugrau","7032":"Kieselgrau","7033":"Zementgrau","7034":"Gelbgrau","7035":"Lichtgrau","7036":"Platingrau","7037":"Staubgrau","7038":"Achatgrau","7039":"Quarzgrau","7040":"Fenstergrau","7042":"Verkehrsgrau A","7043":"Verkehrsgrau B","7044":"Seidengrau","7045":"Telegrau 1","7046":"Telegrau 2","7047":"Telegrau 4","7048":"Perlmausgrau",
  "8000":"Grünbraun","8001":"Ockerbraun","8002":"Signalbraun","8003":"Lehmbraun","8004":"Kupferbraun","8007":"Rehbraun","8008":"Olivbraun","8011":"Nußbraun","8012":"Rotbraun","8014":"Sepiabraun","8015":"Kastanienbraun","8016":"Mahagonibraun","8017":"Schokoladenbraun","8019":"Graubraun","8022":"Schwarzbraun","8023":"Orangebraun","8024":"Beigebraun","8025":"Blaßbraun","8028":"Terrabraun","8029":"Perlkupfer",
  "9001":"Cremeweiß","9002":"Grauweiß","9003":"Signalweiß","9004":"Signalschwarz","9005":"Tiefschwarz","9006":"Weißaluminium","9007":"Graualuminium","9010":"Reinweiß","9011":"Graphitschwarz","9012":"Reinraumweiß","9016":"Verkehrsweiß","9017":"Verkehrsschwarz","9018":"Papyrusweiß","9022":"Perlhellgrau","9023":"Perldunkelgrau"
});

function ralNumber(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/(?:^|\b)RAL\s*[-:]?\s*(\d{4})(?:\b|$)/i) || text.match(/^\s*(\d{4})\s*$/);
  return match && RAL_CLASSIC_NAMES[match[1]] ? match[1] : "";
}

function enrichRal(row) {
  if (!row || typeof row !== "object") return row;
  const number = ralNumber(row.code) || ralNumber(row.name) || ralNumber(row.altCode);
  if (!number) return row;
  const name = RAL_CLASSIC_NAMES[number];
  row.ralNumber = number;
  row.ralName = name;
  row.code = `RAL ${number}`;
  row.name = name;
  return row;
}

if (!express.response.__kristineRalNamesInstalled) {
  express.response.__kristineRalNamesInstalled = true;
  const previousJson = express.response.json;
  express.response.json = function kristineRalNamesJson(body) {
    try {
      const reqPath = String(this.req?.path || this.req?.originalUrl || "").split("?")[0];
      if (reqPath === "/admin/api/paint/search" && Array.isArray(body?.results)) {
        const system = String(this.req?.query?.system || "").toUpperCase();
        if (system === "RAL") body.results.forEach(enrichRal);
      } else if (/^\/admin\/api\/paint\/color\/[^/]+$/.test(reqPath) && body?.color) {
        const system = String(body.color.system || this.req?.query?.system || "").toUpperCase();
        if (system === "RAL" || ralNumber(body.color.code) || ralNumber(body.color.name)) enrichRal(body.color);
      }
    } catch {}
    return previousJson.call(this, body);
  };
}

module.exports = { RAL_CLASSIC_NAMES, ralNumber, enrichRal };
