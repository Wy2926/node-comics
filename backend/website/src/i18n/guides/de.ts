import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Lokale Manga-Übersetzung: manga-translator-ui mit NodeLane verbinden",
    "description": "Richten Sie den Webdienst manga-translator-ui ein, verbinden Sie ihn mit NodeLane und übersetzen Sie Ihre erste Comic-Seite. Beinhaltet Verbindungs-, Anmelde-, Warte- und Cache-Fehlerbehebung.",
    "category": "Tutorial zur lokalen Übersetzung",
    "minutes": 8,
    "published": "2026-09-28",
    "updated": "2026-10-08",
    "related": [
      "local-manga-translator",
      "local-comics",
      "translation-troubleshooting"
    ],
    "sections": [
      {
        "title": "Bevor Sie beginnen",
        "paragraphs": [
          "NodeLane Comics übernimmt das Lesen in Ihrem Browser; manga-translator-ui (MTU) verarbeitet die Bilder. Ihr eigener MTU-Kanal benötigt kein NodeLane-Konto und verwendet kein offizielles Übersetzungsgeld. Hardware, Modelle und Kosten für API Dritter bleiben Ihr Eigentum.",
          "Sie benötigen die neueste Desktop-Browsererweiterung, einen installierten MTU-Dienst mit seinen Abhängigkeiten sowie den Benutzernamen und das Passwort dieses Dienstes. Dieses Tutorial verwendet http://127.0.0.1:8000 auf demselben Computer wie der Browser. Verwenden Sie Ihren tatsächlichen Port, wenn dieser abweicht."
        ],
        "links": [
          {
            "label": "NodeLane Comics herunterladen",
            "href": "/download/"
          },
          {
            "label": "Offizielle MTU-Installation: Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Offizielle MTU-Installation: Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. Starten Sie den Webdienst MTU",
        "paragraphs": [
          "Die Erweiterung benötigt einen HTTP-Webdienst. Das alleinige Öffnen des MTU-Desktopfensters reicht nicht aus. Führen Sie nach der Installation von MTU diesen Befehl im Projektverzeichnis aus und lassen Sie den Dienst weiter laufen. Überspringen Sie diesen Befehl, wenn Sie den Webdienst bereits über Docker oder eine andere Methode ausführen.",
          "In diesem Beispiel wird die GPU-Verarbeitung nicht aktiviert. Fügen Sie --use-gpu erst hinzu, nachdem Sie eine unterstützte GPU-Umgebung wie oben beschrieben konfiguriert haben. Modell-, Treiber- und Hardwareanforderungen hängen von Ihrer MTU-Version ab."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "Offizielle MTU Web-Startanweisungen",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Übersetzen Sie zunächst ein Testbild in MTU",
        "paragraphs": [
          "Öffnen Sie http://127.0.0.1:8000 in Ihrem Browser, schließen Sie die Kontoeinrichtung von MTU ab und melden Sie sich an. Wenn eine anfängliche Passwortänderung erforderlich ist, schließen Sie diese in MTU ab, bevor Sie die Erweiterung anschließen. Dies sind MTU-Anmeldeinformationen, getrennt von Ihrem NodeLane-Konto.",
          "Konfigurieren Sie den Übersetzer, die Modelle und alle erforderlichen API-Schlüssel auf dem Server und bestätigen Sie dann, dass ein Testbild ein übersetztes Bild erzeugt. Die Erweiterung legt die Zielsprache fest und verwendet Serverstandards für andere Übersetzungseinstellungen. Stellen Sie sicher, dass der Webdienst die vorgesehenen Standardeinstellungen verwendet. Geben Sie keinen Schlüssel des Modells API in das Passwortfeld der Erweiterung ein."
        ],
        "links": [
          {
            "label": "Offizielles MTU-Projekt und Dokumentation",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Fügen Sie in der Erweiterung einen Übersetzungskanal hinzu",
        "paragraphs": [
          "Nach der Verbindung werden MTU-Passwort und Token lokal auf diesem Computer gespeichert. Bei gleicher Dienstadresse und gleichem Benutzernamen lässt du das Passwort leer, um das gespeicherte wiederzuverwenden. Gib es erneut ein, wenn sich Adresse, Benutzername oder Passwort ändern, es ungültig ist oder ein altes Profil nur einen Token enthält. Das Speichern des Passworts und die erneute Verbindung mit leerem Passwortfeld erfordern die Erweiterung in Version 0.10.2 oder neuer; in älteren Versionen muss das Passwort bei jeder erneuten Verbindung eingegeben werden."
        ],
        "steps": [
          "Wählen Sie Übersetzungskanal hinzufügen und bestätigen Sie manga-translator-ui als Dienst. Geben Sie ihm optional einen erkennbaren Namen, z. B. „Mein Computer“.",
          "Geben Sie als Dienstadresse http://127.0.0.1:8000 ein. Verwenden Sie das Dienststammverzeichnis ohne /auth/login, /translate/with-form/image oder einen Verwaltungsseitenpfad.",
          "Gib MTU-Benutzernamen und Passwort ein und wähle Verbinden und verwenden. Die Verbindung fordert keine zusätzliche Website-Freigabe an; ist der Zugriff eingeschränkt, stelle in den Erweiterungseinstellungen den Zugriff auf alle Websites wieder her und versuche es erneut.",
          "Überprüfen Sie, ob im aktuellen Kanal der neue Dienst angezeigt wird. Sie können mehrere Dienstprofile speichern, es wird jedoch jeweils nur der ausgewählte Kanal verwendet."
        ]
      },
      {
        "title": "4. Lesen Sie Ihre erste übersetzte Seite",
        "paragraphs": [
          "Importiere einen lokalen Manga oder öffne eine unterstützte Quelle im Leser. Wähle eine Sprache und Übersetzung mit deinem ausgewählten MTU-Kanal.",
          "Die aktuelle Seite hat Vorrang, danach folgt ein begrenzter Bereich benachbarter Bilder. Bilder werden im selben MTU-Kanal einzeln verarbeitet. Vergleiche Original und Übersetzung ohne Positionsverlust; Leser und Seitenübersetzung verwenden denselben ausgewählten Dienst.",
          "Wenn eine Seite fehlschlägt, beheben Sie das gemeldete Problem, bevor Sie es manuell erneut versuchen. Das Schließen einer Seite oder der Verlust der Verbindung beweist nicht, dass MTU die Berechnung gestoppt hat. Vermeiden Sie wiederholte Übermittlungen, solange der Dienst möglicherweise noch ausgelastet ist."
        ],
        "links": [
          {
            "label": "Importieren lokaler Comics und unterstützter Formate",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Beheben Sie Probleme bei Verbindungen, Anmeldungen und langen Wartezeiten",
        "paragraphs": [
          "Überprüfen Sie MTU selbst, bevor Sie es erneut in der Erweiterung versuchen. Geben Sie keine Passwörter, Token oder privaten Comic-Dateien weiter, wenn Sie ein Problem melden."
        ],
        "table": {
          "headers": [
            "Symptom",
            "Was zu überprüfen ist"
          ],
          "rows": [
            [
              "Die Serviceadresse öffnet sich nicht",
              "Überprüfen Sie, ob der Webdienst ausgeführt wird und der Port korrekt ist. 127.0.0.1 bezeichnet den Computer, auf dem der Browser ausgeführt wird; Ein anderes Gerät benötigt eine eigene erreichbare Adresse."
            ],
            [
              "Die Seite wird geöffnet, aber die Erweiterung kann keine Verbindung herstellen",
              "Überprüfen Sie die Root-Adresse, die Browser-Zugriffsberechtigung und ob Ihre MTU-Version kompatible Kontoanmeldungs- und Bildübersetzungsendpunkte bietet."
            ],
            [
              "Falsche Anmeldedaten oder anfängliche Passwortänderung erforderlich",
              "Melden Sie sich bei MTU an oder ändern Sie dort das ursprüngliche Passwort und stellen Sie dann erneut eine Verbindung her. Verwenden Sie MTU-Anmeldeinformationen, kein NodeLane-Passwort oder Modellschlüssel API."
            ],
            [
              "Eine frühere Verbindung meldet nun einen abgelaufenen Login",
              "Wählen Sie in den Kanaleinstellungen „Erneut verbinden“. Bei derselben Dienstadresse und demselben Benutzernamen können Sie das Passwortfeld leer lassen, um das gespeicherte Passwort zu verwenden. Geben Sie es erneut ein, wenn sich die Adresse oder der Benutzername ändert, das Passwort geändert wurde oder nicht mehr gültig ist oder ein älteres Profil nur ein Token enthält. Die Erweiterung sendet die vorherige Übersetzung nicht stillschweigend erneut. Das Speichern des Passworts und die erneute Verbindung mit leerem Passwortfeld erfordern die Erweiterung in Version 0.10.2 oder neuer; in älteren Versionen muss das Passwort bei jeder erneuten Verbindung eingegeben werden."
            ],
            [
              "Verbunden, aber die Übersetzung wartet",
              "Überprüfen Sie Modell-Downloads, Engine-Auslastung, Warteschlangen, API-Kontostand und Hardware-Ressourcen. Testen Sie dieselbe Konfiguration in MTU. Beim Herstellen einer Verbindung wird nur die Anmeldung überprüft."
            ],
            [
              "Unterbrochen, Zeitüberschreitung oder etwas anderes als ein Bild zurückgegeben",
              "Überprüfen Sie die MTU-Aufgabe, das Proxy-Timeout und die Antwort. Versuchen Sie die fehlgeschlagene Seite manuell erneut, nachdem Sie die Ursache behoben haben. Die Erweiterung stellt Ergebnisse nicht automatisch aus dem MTU-Verlauf wieder her."
            ]
          ]
        }
      },
      {
        "title": "Cache, Offline-Nutzung und wohin die Bilder gehen",
        "paragraphs": [
          "Ergebnisse lokaler Kanäle werden im lokalen Speicher dieses Browsers zwischengespeichert. Sie können sie entfernen, indem Sie den Cache leeren oder das Cache-Budget für übersetzte Bilder auf Null setzen und Seiten schließen, die noch Ergebnisse enthalten. Fehlende Ergebnisse erfordern eine manuelle Neuübersetzung; Die Erweiterung kann sie nicht von MTU zurückholen.",
          "Bilder gehen an den ausgewählten MTU-Dienst. Die lokale Ausführung von MTU garantiert keine Offline-Übersetzung: Online-Übersetzer, OCR oder Bildmodelle können Texte oder Bilder an ihre Anbieter senden. Für die Offline-Generierung sind verfügbare Originale, heruntergeladene Modelle und eine Pipeline ohne Online-Abhängigkeiten erforderlich."
        ],
        "links": [
          {
            "label": "Lokale Manga-Übersetzung: Kosten, Datenschutz und Offline-Anforderungen",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Wählen Sie einen lokalen Manga-Übersetzer zum Lesen im Browser",
    "description": "Verbinde manga-translator-ui mit deinem Manga-Leser: Konten, Kosten, Datenschutz und Voraussetzungen für Offline-Übersetzung, mit lokalen Dateien, EPUB und unterstützten Quellen.",
    "category": "Lokaler Übersetzungsführer",
    "minutes": 6,
    "published": "2026-09-28",
    "updated": "2026-10-04",
    "related": [
      "local-translation",
      "translation-modes",
      "local-comics"
    ],
    "sections": [
      {
        "title": "Manga-Übersetzungen erfordern einen Bild-Workflow",
        "paragraphs": [
          "Dialoge sind in Mangas meist Teil des Kunstwerks. Die Textübersetzung eines Browsers kann übersetzte Wörter nicht direkt wieder in Sprechblasen einfügen. Die Bildübersetzung erkennt Text, liest ihn mit OCR, übersetzt ihn, entfernt die Originalbeschriftung und stellt das Ergebnis dar.",
          "Wenn Sie bereits über einen Computer verfügen, auf dem ein Übersetzungsdienst ausgeführt werden kann, können Sie manga-translator-ui für die Bildverarbeitung und NodeLane Comics für das kontinuierliche Lesen im Browser verwenden. Die Erweiterung sendet Bilder aus dem aktuellen Lesefenster an den ausgewählten Dienst und zeigt zurückgegebene Übersetzungen direkt an."
        ]
      },
      {
        "title": "Lokales Lesen, ein lokaler Service und Offline-Übersetzung",
        "paragraphs": [
          "„Lokal“ kann beschreiben, wo sich eine Datei befindet oder wo ein Dienst ausgeführt wird. Verfolgen Sie den gesamten Verarbeitungspfad, um zu verstehen, was mit dem Inhalt passiert."
        ],
        "table": {
          "headers": [
            "Begriff",
            "Was es bedeutet"
          ],
          "rows": [
            [
              "Lokale Comic-Lesung",
              "Importiere unterstützte CBZ/ZIP-, CBR/RAR- und PDF-Dateien sowie MOBI und EPUB ohne DRM. Bei EPUB bleibt das Dokument lesbar; nur eingebettete Rasterbilder werden übersetzt, nicht der Buchtext oder Vektorelemente. Einzelbilder, eigenständige KF8/AZW3-Dateien und verschlüsselte Bücher werden nicht importiert. Websites benötigen einen eigenen Adapter."
            ],
            [
              "Ein lokaler MTU-Dienst",
              "Bilder gehen zu Ihrer MTU-Installation, die möglicherweise lokale Modelle oder externe APIs verwendet."
            ],
            [
              "Vollständige Offline-Übersetzung",
              "Originale, Modelle und Abhängigkeiten sind lokal verfügbar und jeder Bearbeitungsschritt funktioniert ohne Online-Dienste. Überprüfen Sie die gesamte Pipeline selbst."
            ]
          ]
        }
      },
      {
        "title": "Selbstgehosteter MTU oder der offizielle Kanal?",
        "paragraphs": [
          "Ein lokaler Kanal eignet sich für Leser, die MTU bereits betreiben oder ihre eigenen Modelle und Dienste beibehalten möchten. Der offizielle Kanal reduziert den Einrichtungs- und Wartungsaufwand. Probieren Sie einige Seiten mit einer der beiden Optionen aus, bevor Sie die Ergebnisse beurteilen."
        ],
        "table": {
          "headers": [
            "Rücksichtnahme",
            "Dein MTU-Kanal",
            "Offizieller NodeLane-Kanal"
          ],
          "rows": [
            [
              "Konto",
              "MTU-Anmeldeinformationen; kein NodeLane-Login",
              "NodeLane-Anmeldung erforderlich"
            ],
            [
              "Einrichtung",
              "Installieren, ausführen und konfigurieren Sie Ihren Dienst",
              "Übersetzungsdienst verwaltet von NodeLane"
            ],
            [
              "Kosten",
              "Kein offizieller Zuschuss verwendet; Hardware, Leistung und ausgewählte APIs liegen bei Ihnen",
              "Offizielle Pläne und Vergütungsregeln"
            ],
            [
              "Fehlender Ergebniscache",
              "Manuelle Rückübersetzung erforderlich",
              "Berechtigte offizielle Ergebnisse können erneut heruntergeladen werden, solange sie verfügbar sind"
            ]
          ]
        },
        "links": [
          {
            "label": "Verbinden Sie Ihren lokalen Dienst",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Offizielle Pläne und Zulagen",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "Ist die Übersetzung lokaler Mangas kostenlos? Welche GPU benötigen Sie?",
        "paragraphs": [
          "MTU-Übersetzungen verbrauchen nicht die offizielle Vergütung von NodeLane, aber das macht den gesamten Arbeitsablauf nicht kostenlos. Online-Modelle können pro Anfrage abrechnen; Lokale Modelle benötigen Hardware, Speicher und Verarbeitungszeit. Überprüfen Sie die von Ihnen gewählten Motoren, bevor Sie die Kosten abschätzen.",
          "Es gibt keinen einzelnen Speicherbedarf für jedes Setup. Modelle, Bildauflösung, OCR und Inpainting-Engines wirken sich auf die Ressourcennutzung und die Verarbeitungszeit aus. Befolgen Sie die Installationsanleitung von MTU für Ihr Betriebssystem und Ihre Hardware und testen Sie dann eine klare Seite. Es wird keine feste Geschwindigkeit oder universelle Hardwarekompatibilität versprochen."
        ],
        "links": [
          {
            "label": "Offizielle MTU-Projekt- und Installationshandbücher",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Schauen Sie sich japanische Mangas, koreanische Comics und lange Strips an",
        "paragraphs": [
          "Beginnen Sie mit einem klaren Original und prüfen Sie, ob der konfigurierte OCR seine Sprache unterstützt. Vertikale Dialoge, handschriftliche Effekte, komplexe Hintergründe und Scans mit niedriger Auflösung können dazu führen, dass Text fehlt. Große vertikale Streifen können auch mehr Speicher und Zeit beanspruchen.",
          "Wählen Sie eine verfügbare Zielsprache und vergleichen Sie eine oder zwei übersetzte Seiten mit den Originalen. Überprüfen Sie Auslassungen, Namen, Ton und Blasenanordnung. Die Ergebnisse hängen von den Modellen und Einstellungen in MTU ab; Eine lokale Verbindung allein verbessert nicht die Übersetzungsgenauigkeit."
        ]
      },
      {
        "title": "Wo werden Bilder hochgeladen und was funktioniert offline?",
        "paragraphs": [
          "Wenn MTU ausgewählt ist, sendet die Erweiterung Übersetzungsbilder direkt an den konfigurierten Dienst und nicht über den offiziellen Übersetzungsdienst von NodeLane. Ob MTU Text oder Bilder an einen Modellanbieter weiterleitet, hängt von den aktivierten Engines ab.",
          "Importierte lokale Comics und zwischengespeicherte Übersetzungen bleiben lesbar, solange diese Ressourcen verfügbar sind. Das Offline-Generieren neuer Übersetzungen erfordert einen laufenden lokalen Dienst und eine vollständig Offline-Verarbeitungspipeline. Auch Website-Originale müssen vorab zwischengespeichert werden. Durch das Vorhalten von Ergebnis-Caches wird wiederholte Arbeit reduziert, ein Cache ist jedoch kein permanentes Backup."
        ],
        "links": [
          {
            "label": "Bild-Uploads und Erweiterungsberechtigungen",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Beginnen Sie mit einer Seite",
        "paragraphs": [
          "Starten Sie den Webdienst von MTU und übersetzen Sie ein Bild in seiner eigenen Oberfläche. Fügen Sie dann die Dienstadresse und das Konto in den NodeLane-Einstellungen hinzu, stellen Sie eine Verbindung her und wählen Sie die Übersetzung und eine Zielsprache aus.",
          "Wenn die Verbindung fehlschlägt, überprüfen Sie die Adresse und die Browserberechtigung. Wenn die Anmeldung funktioniert, aber kein Bild angezeigt wird, überprüfen Sie die Übersetzungskonfiguration des Dienstes. Ein kleiner Test verrät mehr über die Eignung für die alltägliche Lektüre als eine allgemeine Geschwindigkeitsaussage."
        ],
        "links": [
          {
            "label": "Folgen Sie dem lokalen Übersetzungs-Tutorial",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Laden Sie den Comic-Reader und Übersetzer herunter",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
