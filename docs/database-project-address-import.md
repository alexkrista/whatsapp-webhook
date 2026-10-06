# Baustellenadressen

Migration 006 ergänzt Hausnummer und Adresszusatz als getrennte Textfelder sowie eine mandantengesicherte externe Quellenreferenz für Adressen. Postleitzahlen und Hausnummern bleiben Text einschließlich führender Nullen. Es wird kein Land aus einer Ortsbezeichnung geraten.

`importProjectAddresses` zerlegt die bereits vollständig archivierten Baustellen-Metadaten in Adressen. Es liest den geprüften SQL-Quellstand, nicht einen neuen Stand der aktiven JSON-Dateien. Zu jeder Adresse werden Baustellenzuordnung (`site`), vollständiger Originaltext und Prüfsumme erhalten. Es gibt keinen Adress- oder Namensabgleich zwischen verschiedenen Baustellen; eine gleiche Anschrift kann mehreren eigenständigen Baustellen gehören.

Alle Datenänderungen und Feldprüfungen laufen in einer Transaktion. Wiederholung erzeugt keine weitere Adresse. Abweichende Quellenhistorie, bestehende unzugeordnete Baustellenadresse oder veränderte Zielfelder brechen ab. Die vorausgehende Schemaänderung ist eine getrennte Transaktion. Die Anwendung arbeitet weiterhin mit JSON; vor einer SQL-Umschaltung muss der aktuelle Dateistand erneut abgeglichen werden.

Der Importtest prüft führende Nullen, Hausnummer/Adresszusatz, exakte Originaltexte, Wiederholung, Mandantengrenzen und Rückrollen nach einer Zielabweichung.

Kontaktvorprüfung vom 06.10.2026: zentraler Kontaktstamm enthält 26 Datensätze mit eindeutigen IDs. 51 projektbezogene Rolleneinträge besitzen eine Stamm-ID. Die Rollen und Verweise müssen gegen diesen Stamm geprüft werden; es darf kein Namensabgleich Personen oder Firmen automatisch zusammenführen. Kontakte wurden mit diesem Adressmodul noch nicht importiert.
