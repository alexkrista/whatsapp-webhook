# KRISTINE Arbeitssicherheit – SDB v0.1

Der Admin-Eingang verarbeitet PDF-Sicherheitsdatenblätter, extrahiert Kerndaten und ordnet sie als `bereits_vorhanden`, `neue_version`, `aelter`, `neues_produkt` oder `unklar` ein. Jede Übernahme erzeugt ausschließlich einen **Prüffall**. Sicherheitsrelevante Änderungen werden nie automatisch fachlich freigegeben.

## Physische Source of Truth

`N:\\SdB` bleibt die physische Wahrheit. KRISTINE speichert im Masterindex Metadaten, Hashes und relative Verknüpfungen. Der lokale Agent benötigt Zugriff auf `N:`; der KRISTINE-Server benötigt keinen eingehenden Zugriff ins Firmennetz.

## Agent starten

```powershell
$env:SDB_AGENT_TOKEN = "ein-langes-zufaelliges-geheimnis"
python tools/sdb-agent.py --root "N:\SdB" --url "https://testinstanz.example"
```

Auf dem Server wird dasselbe Geheimnis als `SDB_AGENT_TOKEN` gesetzt. Der Agent scannt rekursiv, cached Größe/Änderungszeit und berechnet SHA-256 nur für neue oder geänderte PDFs. Er sendet ausschließlich relative Pfade, Hashes, Größe und Änderungszeit über HTTPS; PDFs verlassen `N:` in diesem Flow nicht.

## Grenzen des ersten Stands

Textbasierte PDFs werden verarbeitet. Scans ohne Textebene und exotische SDB-Layouts können als `unklar` enden und benötigen später OCR bzw. manuelle Nachpflege. Die Felder Erste Hilfe und PSA werden abschnittsweise extrahiert; die Anzeige dient als Prüfgrundlage, nicht als automatische Sicherheitsfreigabe.
