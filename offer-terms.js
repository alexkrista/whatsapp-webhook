"use strict";

const OFFER_TERMS = Object.freeze({
  version: "2026-09-18",
  title: "Allgemeine Geschäftsbedingungen",
  subtitle: "Für Maler-, Verputz- und kleinere Baumeisterarbeiten",
  company: [
    "Farben Krista GmbH & Co KG",
    "Feldkircherstraße 45",
    "6820 Frastanz",
    "T +43 5522 53940 · office@krista.at",
  ],
  register: [
    "Farben Krista GmbH & Co KG · FN 15539b · Firmenbuchgericht Feldkirch",
    "Unbeschränkt haftender Gesellschafter: Farben Krista GmbH · FN 77707a · Firmenbuchgericht Feldkirch",
  ],
  sections: [
    {
      number: 1,
      title: "Geltungsbereich",
      paragraphs: [
        "Diese Allgemeinen Geschäftsbedingungen gelten für Maler-, Beschichtungs-, Verputz-, Ausbesserungs- und kleinere Baumeisterarbeiten, die unser Unternehmen im Rahmen seiner Gewerbeberechtigung übernimmt.",
        "Sie werden Vertragsbestandteil, wenn sie dem Auftraggeber vor Vertragsabschluss zur Verfügung gestellt werden und ihre Geltung vereinbart wird. Individuelle Vereinbarungen gehen diesen AGB vor.",
        "Die Bestimmungen gelten für Privat- und Geschäftskunden. Ob ein Verbrauchergeschäft oder ein Unternehmensgeschäft vorliegt, richtet sich nach den gesetzlichen Voraussetzungen und dem Zweck des konkreten Auftrags.",
      ],
    },
    {
      number: 2,
      title: "Angebot und Vertragsabschluss",
      paragraphs: [
        "An unsere Angebote halten wir uns ab dem Angebotsdatum 30 Kalendertage gebunden, sofern im jeweiligen Angebot keine andere Frist genannt ist.",
        "Der Vertrag kommt zustande, sobald uns das innerhalb der Bindungsfrist unverändert unterschriebene Angebot zugeht. Änderungen durch den Auftraggeber bedürfen unserer Zustimmung.",
        "Grundlage des Auftrags sind das angenommene Angebot, die darin bezeichneten Leistungsbeschreibungen und ausdrücklich vereinbarte Ergänzungen.",
        "Änderungen und Zusatzaufträge sollen zur Nachvollziehbarkeit schriftlich, beispielsweise per E-Mail, dokumentiert werden. Die Wirksamkeit zulässiger mündlicher Individualvereinbarungen bleibt unberührt.",
      ],
    },
    {
      number: 3,
      title: "Leistungsumfang und Ausführung",
      paragraphs: [
        "Art und Umfang der Arbeiten, Materialien, Farbtöne und Oberflächenqualitäten ergeben sich aus dem Angebot und den ergänzenden Vereinbarungen.",
        "Im Angebot wird festgelegt, in welchem Umfang insbesondere Untergrundvorbereitung, Abdeckarbeiten, Möbelrücken, Gerüste, Materialtransport, Entsorgung und Reinigung enthalten sind. Arbeiten, die zur fachgerechten Erbringung der vereinbarten Leistung notwendig sind, werden nicht allein dadurch zu gesondert verrechenbaren Zusatzleistungen, dass sie nicht einzeln angeführt sind.",
        "Die Ausführung erfolgt fachgerecht und in der vereinbarten Qualität. Besondere Anforderungen an Farbtöne, Strukturen oder Oberflächen werden vor der Ausführung vereinbart, gegebenenfalls anhand freigegebener Muster.",
        "Erforderliche Planungs-, Statik- und Genehmigungsleistungen sowie die Zuständigkeit für deren Beschaffung werden im Angebot festgelegt. Gesetzliche Prüf-, Hinweis- und sonstige Pflichten bleiben unberührt.",
      ],
    },
    {
      number: 4,
      title: "Preise und Kostenvoranschläge",
      paragraphs: [
        "Das Angebot legt fest, ob nach Pauschalpreisen, Einheitspreisen oder tatsächlichem Zeit- und Materialaufwand abgerechnet wird.",
        "Pauschalpreise gelten für den vereinbarten Leistungsumfang. Bei Einheitspreisen erfolgt die Abrechnung nach den tatsächlich ausgeführten, nachvollziehbar dokumentierten Mengen und den vereinbarten Messregeln.",
        "Gegenüber Verbrauchern werden Preise einschließlich gesetzlich anfallender Umsatzsteuer und sonstiger vorhersehbarer Preisbestandteile ausgewiesen. Gegenüber Unternehmern können ausdrücklich als solche bezeichnete Nettopreise vereinbart werden. Die umsatzsteuerliche Behandlung erfolgt nach den gesetzlichen Vorschriften.",
        "Kostenvoranschläge für Verbraucher gelten als verbindlich, sofern nicht vor Vertragsabschluss ausdrücklich ihre Unverbindlichkeit erklärt wird.",
        "Die Erstellung eines Kostenvoranschlags wird nur verrechnet, wenn die Kostenpflicht und das Entgelt oder dessen Berechnungsgrundlage vorab ausdrücklich vereinbart wurden.",
      ],
    },
    {
      number: 5,
      title: "Regiearbeiten und tägliche Dokumentation",
      paragraphs: [
        "Regiearbeiten werden nach dem tatsächlich angefallenen Zeit- und Materialaufwand zu den vor Ausführung vereinbarten Verrechnungssätzen abgerechnet. Verrechenbare Nebenleistungen und Nebenkosten werden ebenfalls vorab vereinbart.",
        "Im Angebot ausdrücklich als Schätzung bezeichnete Stunden, Mengen und Gesamtkosten für Regiearbeiten sind unverbindliche Kostenschätzungen. Sie stellen weder einen Pauschalpreis noch eine verbindliche Kostenobergrenze dar.",
        "Wir dokumentieren die ausgeführten Leistungen, Arbeitsstunden und eingesetzten Materialien täglich in Regieberichten und stellen diese dem Auftraggeber täglich zur Verfügung. Dabei werden auch die bisher angefallenen Kosten ausgewiesen, damit der Auftraggeber laufend einen Überblick über Aufwand und Kostenstand erhält.",
        "Zeichnet sich eine beträchtliche Überschreitung der geschätzten Gesamtkosten ab, informieren wir den Auftraggeber unverzüglich über die Gründe und die voraussichtlichen Mehrkosten. Dies erfolgt zusätzlich zur täglichen Leistungs- und Kostendokumentation. Die gesetzlichen Rechte des Auftraggebers bleiben unberührt.",
      ],
    },
    {
      number: 6,
      title: "Zusatzarbeiten und unerwartete Untergrundprobleme",
      paragraphs: [
        "Zusätzliche oder geänderte Leistungen werden vor ihrer Ausführung hinsichtlich Umfang, Preis beziehungsweise Berechnungsgrundlage und allfälliger Auswirkungen auf Termine abgestimmt und beauftragt.",
        "Werden nicht vorher erkennbare Probleme festgestellt, insbesondere nicht tragfähige Altbeschichtungen, Feuchtigkeit, Hohlstellen oder schadhafter Putz, informieren wir den Auftraggeber über die Feststellungen und erforderlichen Maßnahmen.",
        "Soweit fachlich notwendig, werden die betroffenen Arbeiten bis zur Klärung unterbrochen. Schweigen gilt nicht als Beauftragung zusätzlicher Leistungen.",
        "Die Verrechnung von Mehraufwand setzt eine vertragliche oder gesetzliche Grundlage voraus. Vereinbarte Pauschalpreise und verbindliche Kostenvoranschläge werden durch diese Bestimmung nicht einseitig geändert.",
      ],
    },
    {
      number: 7,
      title: "Prüfpflichten, Mitwirkung und Schutzmaßnahmen",
      paragraphs: [
        "Wir prüfen vorhandene Untergründe sowie vom Auftraggeber bereitgestellte Materialien und Anweisungen im Rahmen unserer fachlichen Prüf- und Warnpflichten. Erkennbare Bedenken teilen wir rechtzeitig mit.",
        "Der Auftraggeber ermöglicht den vereinbarten Zugang zu den Arbeitsbereichen und informiert uns über ihm bekannte Schäden, Gefahren und relevante Leitungsverläufe.",
        "Sofern im Angebot nicht ausdrücklich als von uns zu erbringende Leistung angeführt, obliegen das Freimachen der Räume, das Bewegen von Möbeln sowie die Bereitstellung von Wasser, Strom und geeigneten Lagerflächen dem Auftraggeber und erfolgen auf dessen Kosten.",
        "Wir treffen die für unsere Arbeiten erforderlichen Schutzmaßnahmen für angrenzende Bauteile und Einrichtungsgegenstände. Unsere Schutz- und Sorgfaltspflichten bleiben unabhängig von der Mitwirkung des Auftraggebers bestehen.",
      ],
    },
    {
      number: 8,
      title: "Termine und Behinderungen",
      paragraphs: [
        "Vereinbarte Ausführungs- und Fertigstellungstermine sind einzuhalten. Im Angebot ausdrücklich als voraussichtlich bezeichnete Termine dienen der Planung.",
        "Behindern ungeeignete Witterung oder andere nicht von uns zu vertretende Umstände die Ausführung, informieren wir den Auftraggeber unverzüglich über Ursache und voraussichtliche Dauer.",
        "Technisch erforderliche Trocknungs- und Aushärtungszeiten werden bei der Terminplanung berücksichtigt. Werden unvorhersehbar längere Zeiten erforderlich, wird der Auftraggeber darüber informiert.",
        "Notwendige Terminverschiebungen beschränken sich auf die tatsächlichen Auswirkungen der Behinderung. Zusätzliche Kosten entstehen dadurch nicht automatisch, sondern bedürfen einer vertraglichen oder gesetzlichen Grundlage. Gesetzliche Rechte bei Verzug bleiben unberührt.",
      ],
    },
    {
      number: 9,
      title: "Zahlung, Teilrechnungen und Schlussrechnung",
      paragraphs: [
        "Es gilt die im Angebot vereinbarte Zahlungsoption:",
        "a) Zahlung innerhalb von 14 Kalendertagen ab Rechnungseingang ohne Abzug;",
        "b) Zahlung innerhalb von 5 Kalendertagen ab Rechnungseingang mit 2 % Skonto auf den jeweiligen Rechnungsbetrag; bei späterer Zahlung ist der volle Rechnungsbetrag spätestens innerhalb von 14 Kalendertagen ab Rechnungseingang zu bezahlen;",
        "c) 4 % Skonto auf die gesamte vereinbarte Auftragssumme bei einer Anzahlung von 50 % dieser Auftragssumme vor Skontoabzug, fällig bei Auftragserteilung. Die Anzahlungsrechnung wird bei Auftragserteilung übergeben. Bei fristgerechter Anzahlung wird der Skontoabzug in der Schlussrechnung berücksichtigt. Weitere Rechnungen sind innerhalb von 14 Kalendertagen ab Rechnungseingang zu bezahlen.",
        "Es gilt jeweils nur eine Zahlungsoption. Wird keine Option vereinbart, gilt die Zahlung innerhalb von 14 Kalendertagen ohne Abzug.",
        "Teilrechnungen werden entsprechend dem nachgewiesenen Baufortschritt gelegt. Eine geleistete Anzahlung wird dabei angerechnet und nicht zusätzlich zum bereits abgerechneten Leistungsstand verlangt. Anzahlung und Teilrechnungen dürfen zusammen höchstens 90 % der vereinbarten Auftragssumme zuzüglich allfälliger beauftragter Nachträge, jeweils vor Skontoabzug, erreichen.",
        "Bei Regiearbeiten bezieht sich diese Grenze auf die vereinbarte geschätzte Auftragssumme. Eine Anpassung der für diese Grenze maßgeblichen Summe bedarf einer ausdrücklichen Vereinbarung. Die Abrechnung des tatsächlichen Aufwands in der Schlussrechnung bleibt davon unberührt.",
        "Die Schlussrechnung erfolgt nach vollständiger vertragsgemäßer Fertigstellung. Sämtliche geleisteten Zahlungen und vereinbarten Skontoabzüge werden berücksichtigt.",
        "Für nachträglich beauftragte Zusatzleistungen wird festgelegt, ob sie in die Auftragssumme und eine vereinbarte Skontobasis einbezogen werden.",
        "Gesetzliche Leistungsverweigerungs- und Zurückbehaltungsrechte bleiben unberührt. Bei Zahlungsverzug gelten die gesetzlichen Bestimmungen über Verzugszinsen und den Ersatz von Betreibungskosten.",
      ],
    },
    {
      number: 10,
      title: "Fertigstellung, Gewährleistung und Haftung",
      paragraphs: [
        "Nach Fertigstellung wird eine gemeinsame Besichtigung angeboten. Offene Arbeiten und festgestellte Mängel können in einem Protokoll festgehalten werden.",
        "Weder die Nutzung der bearbeiteten Räume noch die unterbliebene Teilnahme an einer Besichtigung gilt als Verzicht auf Mängelrechte.",
        "Für Gewährleistung und Schadenersatz gelten die gesetzlichen Bestimmungen. Gesetzliche Gewährleistungsfristen werden nicht verkürzt.",
        "Der Auftraggeber wird gebeten, festgestellte Mängel möglichst zeitnah mitzuteilen und nach Abstimmung Zugang zur Prüfung und gegebenenfalls Verbesserung zu ermöglichen. Diese Bitte begründet keine zusätzliche Ausschlussfrist.",
      ],
    },
    {
      number: 11,
      title: "Abbestellung und unterbliebene Ausführung",
      paragraphs: [
        "Eine einvernehmliche Aufhebung des Vertrags ist möglich. Ihre finanziellen Folgen werden gesondert vereinbart.",
        "Unterbleibt die Ausführung aus Gründen aufseiten des Auftraggebers, richten sich allfällige Entgeltansprüche nach den gesetzlichen Voraussetzungen, insbesondere § 1168 ABGB. Ersparte Aufwendungen sowie anderweitiger Erwerb und absichtlich versäumter anderweitiger Erwerb sind anzurechnen.",
        "Gegenüber Verbrauchern erfüllen wir auch die gesetzliche Informationspflicht nach § 27a KSchG, soweit deren Voraussetzungen vorliegen.",
        "Eine pauschale Stornogebühr wird nicht vereinbart. Gesetzliche Rücktrittsrechte bleiben unberührt.",
      ],
    },
    {
      number: 12,
      title: "Gesetzliche Rücktrittsrechte für Verbraucher",
      paragraphs: [
        "Bei außerhalb unserer Geschäftsräume oder im Fernabsatz geschlossenen Verträgen können gesetzliche Rücktrittsrechte bestehen. Soweit anwendbar, erhält der Auftraggeber gesondert die erforderlichen Informationen, die Rücktrittsbelehrung und das Muster-Widerrufsformular.",
        "Ein gewünschter Arbeitsbeginn vor Ablauf einer anwendbaren Rücktrittsfrist wird gesondert unter Einhaltung der gesetzlichen Voraussetzungen vereinbart.",
        "Weder die Unterzeichnung des Angebots noch die Leistung einer Anzahlung gilt für sich allein als Verzicht auf ein gesetzliches Rücktrittsrecht.",
      ],
    },
    {
      number: 13,
      title: "Anwendbares Recht und Gerichtsstand",
      paragraphs: [
        "Es gilt österreichisches Recht. Bei Verbrauchern bleibt ein gegebenenfalls anwendbarer zwingender Schutz des Rechts ihres gewöhnlichen Aufenthaltsstaats unberührt.",
        "Für Streitigkeiten aus oder im Zusammenhang mit diesem Vertrag mit Unternehmern, für die der Auftrag zum Betrieb ihres Unternehmens gehört, wird die ausschließliche Zuständigkeit des sachlich zuständigen Gerichts in Feldkirch vereinbart.",
        "Für Verbraucher gelten die gesetzlichen Gerichtsstände. Insbesondere bleiben die zwingenden Bestimmungen des § 14 KSchG unberührt.",
        "ÖNORMEN werden durch diese AGB nicht pauschal als Vertragsbedingungen vereinbart. Ihre ausdrückliche Vereinbarung im Einzelfall und ihre Bedeutung für die Beurteilung fachgerechter Arbeiten bleiben unberührt.",
      ],
    },
  ],
});

module.exports = { OFFER_TERMS };
