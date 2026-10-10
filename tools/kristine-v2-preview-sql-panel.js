'use strict';

const {CUTOFF}=require('../storage/kristine-v2-sql-read-model');
const STATUSES=Object.freeze({
  1:'Angebot',2:'Auftrag',3:'Laufend',4:'Fertig, nicht abgerechnet',5:'Geschlossen',
});
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[char]));

function placeholder(title, detail) {
  return '<section class="fixture" data-sql-state="waiting"><h2>'+escape(title)+'</h2>'+
    '<p>'+escape(detail)+'</p>'+
    '<p class="preview-note">Keine Verbindung zu Live-Kristine oder OBELISK. Keine Daten werden geändert.</p>'+
    '</section>';
}

function listRows(headers,rows) {
  return '<div class="fixture-grid" role="table">' +
    headers.map(cell=>'<strong>'+escape(cell)+'</strong>').join('')+
    (rows.length?rows.map(row=>row.map(cell=>'<span>'+escape(cell)+'</span>').join('')).join('') :
      '<span>In der SQL-Testdatenbank noch keine Einträge</span>')+
    '</div>';
}

function sqlPanel(overview,world) {
  if(!overview) return placeholder('SQL-Testdaten', 'Die Datenbankverbindung ist noch nicht eingerichtet. Aktuell nur eine sichere Oberflächenvorschau.');
  if(overview.state==='connection_error') return placeholder('SQL-Testdaten', 'Die Verbindung zur Testdatenbank konnte nicht gelesen werden. Die Produktivdaten bleiben unberührt.');
  if(overview.state==='schema_missing') return placeholder('SQL-Testdatenbank erreichbar', 'Die erforderlichen KRISTINE-SQL-Tabellen wurden noch nicht in der isolierten Testdatenbank angelegt.');
  if(overview.state==='empty_database') return placeholder('SQL-Struktur erreichbar', 'Noch keine Firma oder geschäftliche Daten in der Testdatenbank importiert.');
  if(overview.state==='company_selection_required') return placeholder('SQL-Daten vorhanden', 'Mehrere Firmen sind gespeichert; für die Anzeige ist eine eindeutig geprüfte Firmen-ID nötig.');
  if(overview.state!=='ready'||!overview.counts) return placeholder('SQL-Testdaten', 'Noch kein verifizierter SQL-Datenstand verfügbar.');

  const c=overview.counts,company=escape(overview.company?.name||'Testdaten');
  const kpis=[
    ['Baustellen',c.projects],['Mitarbeiter',c.employees],
    ['Einteilungen',c.assignments],['Zeitereignisse ab '+CUTOFF,c.time_events_since_cutoff],
    ['Dokumenteinträge',c.document_records],['Validierte Importe',c.validated_imports],
  ];
  let content='<section class="fixture" data-sql-state="ready">'+
    '<h2>Echte SQL-Daten – isolierter Testbestand</h2>'+
    '<p><strong>'+company+'</strong> · PostgreSQL-Testdatenbank · ausschließlich lesender Zugriff.</p>'+
    '<div class="preview-grid">'+kpis.map(([label,value])=>
      '<div class="preview-card"><strong>'+escape(value)+'</strong><small>'+escape(label)+'</small></div>').join('')+'</div>';
  const showPeople=['kriszeit','krisadmin'].includes(world);
  if(showPeople) {
    content+='<h3>Personalstamm in SQL</h3>'+listRows(['Personal-Nr.','Mitarbeiter','Aktiv'],
      overview.employees.map(p=>[p.personalNumber||'–',p.name,p.active?'Ja':'Nein']));
  } else {
    content+='<h3>Baustellen in SQL</h3>'+listRows(['Nummer','Baustelle','Status'],
      overview.projects.map(p=>[p.number,p.name,STATUSES[p.status]||'Ungeklärt']));
  }
  content+='<p class="preview-note">Dieser Datenstand enthält nur bereits in die Testdatenbank importierte Datensätze; keine Behauptung vollständiger Live-Synchronität. OBELISK-Personalzeiten werden nicht importiert.</p></section>';
  return content;
}
module.exports={sqlPanel,escape};
