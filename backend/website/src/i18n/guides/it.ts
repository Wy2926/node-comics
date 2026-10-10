import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Traduzione manga locale: collega manga-translator-ui a NodeLane",
    "description": "Configura il servizio Web manga-translator-ui, collegalo a NodeLane e traduci la tua prima pagina di fumetto. Include la risoluzione dei problemi di connessione, accesso, attesa e cache.",
    "category": "Tutorial sulla traduzione locale",
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
        "title": "Prima di iniziare",
        "paragraphs": [
          "NodeLane Comics gestisce la lettura nel tuo browser; manga-translator-ui (MTU) elabora le immagini. Il tuo canale MTU non necessita di un account NodeLane e non utilizza alcuna indennità di traduzione ufficiale. Hardware, modelli e costi di API di terze parti rimangono a tuo carico.",
          "Hai bisogno dell'ultima estensione del browser desktop, di un servizio MTU installato con le sue dipendenze e del nome utente e della password di quel servizio. Questo tutorial utilizza http://127.0.0.1:8000 sullo stesso computer del browser. Usa la tua porta effettiva se è diversa."
        ],
        "links": [
          {
            "label": "Scarica NodeLane Comics",
            "href": "/download/"
          },
          {
            "label": "Installazione ufficiale MTU: Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Installazione ufficiale MTU: Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. Avviare il servizio Web MTU",
        "paragraphs": [
          "L'estensione necessita di un servizio Web HTTP. Aprire solo la finestra del desktop MTU non è sufficiente. Dopo aver installato MTU, esegui questo comando nella directory del progetto e mantieni il servizio in esecuzione. Ignora questo comando se esegui già il servizio Web tramite Docker o un altro metodo.",
          "Questo esempio non abilita l'elaborazione GPU. Aggiungi --use-gpu solo dopo aver configurato un ambiente GPU supportato come descritto a monte. Modello, driver e requisiti hardware dipendono dalla versione MTU."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "Istruzioni ufficiali per il lancio sul Web MTU",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Tradurre prima un'immagine di prova in MTU",
        "paragraphs": [
          "Apri http://127.0.0.1:8000 nel tuo browser, completa la configurazione dell'account di MTU e accedi. Se è necessaria una modifica iniziale della password, completala in MTU prima di connettere l'estensione. Queste sono credenziali MTU, separate dal tuo account NodeLane.",
          "Configura il traduttore, i modelli e le eventuali chiavi API richieste sul server, quindi conferma che un'immagine di prova produca un'immagine tradotta. L'estensione imposta la lingua di destinazione e utilizza le impostazioni predefinite del server per altre impostazioni di traduzione. Assicurarsi che il servizio Web utilizzi le impostazioni predefinite previste. Non inserire una chiave modello API nel campo della password dell'interno."
        ],
        "links": [
          {
            "label": "Progetto e documentazione ufficiale MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Aggiungi un canale di traduzione nell'estensione",
        "paragraphs": [
          "Dopo la connessione, password e token MTU sono conservati localmente su questo computer. Con lo stesso indirizzo del servizio e lo stesso nome utente, lascia vuota la password per riutilizzare quella salvata. Inseriscila di nuovo se cambia l’indirizzo, l’utente o la password, se non è più valida o se un vecchio profilo contiene soltanto un token. Il salvataggio della password e la riconnessione con il campo vuoto richiedono l’estensione 0.10.2 o successiva; nelle versioni precedenti la password va inserita a ogni riconnessione."
        ],
        "steps": [
          "Scegli Aggiungi canale di traduzione e conferma manga-translator-ui come servizio. Facoltativamente, assegnagli un nome riconoscibile, ad esempio \"Risorse del computer\".",
          "Immettere http://127.0.0.1:8000 come indirizzo del servizio. Utilizza la root del servizio, senza /auth/login, /translate/with-form/image o un percorso della pagina di amministrazione.",
          "Inserisci nome utente e password MTU, quindi scegli Connetti e usa. La connessione non richiede un permesso aggiuntivo per il sito; se l’accesso è limitato, ripristina l’accesso a tutti i siti nelle impostazioni dell’estensione e riprova.",
          "Verifica che Canale corrente mostri il nuovo servizio. È possibile salvare più profili di servizio, ma verrà utilizzato solo il canale selezionato alla volta."
        ]
      },
      {
        "title": "4. Leggi la tua prima pagina tradotta",
        "paragraphs": [
          "Importa un manga locale o apri una fonte compatibile nel lettore. Scegli una lingua e la traduzione con il tuo canale MTU selezionato.",
          "La pagina attuale ha la priorità, seguita da una finestra limitata di immagini vicine. Le immagini vengono elaborate una alla volta sullo stesso canale MTU. Confronta originale e traduzione senza perdere la posizione; lettore e traduzione nella pagina usano lo stesso servizio selezionato.",
          "Se una pagina fallisce, risolvi il problema segnalato prima di riprovare manualmente. Chiudere una pagina o perdere la connessione non dimostra che MTU abbia interrotto il calcolo. Evita invii ripetuti mentre il servizio potrebbe essere ancora occupato."
        ],
        "links": [
          {
            "label": "Importazione di fumetti locali e formati supportati",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Risolvere problemi di connessione, login e lunghe attese",
        "paragraphs": [
          "Controlla MTU stesso prima di riprovare nell'estensione. Non condividere password, token o file di fumetti privati ​​quando segnali un problema."
        ],
        "table": {
          "headers": [
            "Sintomo",
            "Cosa controllare"
          ],
          "rows": [
            [
              "L'indirizzo del servizio non si apre",
              "Verificare che il servizio Web sia in esecuzione e che la porta sia corretta. 127.0.0.1 indica il computer su cui è in esecuzione il browser; un dispositivo diverso necessita di un proprio indirizzo raggiungibile."
            ],
            [
              "La pagina si apre, ma l'interno non riesce a connettersi",
              "Controlla l'indirizzo root, l'autorizzazione di accesso del browser e se la tua versione MTU fornisce l'accesso all'account compatibile e gli endpoint di traduzione delle immagini."
            ],
            [
              "Sono richieste credenziali errate o modifica della password iniziale",
              "Accedi a MTU o modifica lì la password iniziale, quindi riconnettiti. Utilizza le credenziali MTU, non una password NodeLane o una chiave del modello API."
            ],
            [
              "Una connessione precedente ora segnala un accesso scaduto",
              "Scegli Riconnetti nelle impostazioni del canale. Con lo stesso indirizzo del servizio e lo stesso nome utente, lascia vuota la password per riutilizzarla. Inseriscila di nuovo se cambia l'indirizzo o il nome utente, se la password è stata modificata o non è più valida, oppure se un vecchio profilo contiene solo un token. L'estensione non invia nuovamente in modo silenzioso la traduzione precedente. Il salvataggio della password e la riconnessione con il campo vuoto richiedono l’estensione 0.10.2 o successiva; nelle versioni precedenti la password va inserita a ogni riconnessione."
            ],
            [
              "Connesso, ma la traduzione continua ad aspettare",
              "Controlla i download dei modelli, il caricamento del motore, le code, il saldo API e le risorse hardware. Testare la stessa configurazione in MTU. La connessione verifica solo l'accesso."
            ],
            [
              "Interrotto, scaduto o restituito qualcosa di diverso da un'immagine",
              "Controllare l'attività MTU, il timeout proxy e la risposta. Riprovare manualmente la pagina non riuscita dopo aver risolto la causa. L'estensione non ripristina automaticamente i risultati dalla cronologia MTU."
            ]
          ]
        }
      },
      {
        "title": "Cache, utilizzo offline e dove vanno le immagini",
        "paragraphs": [
          "I risultati del canale locale vengono memorizzati nella cache nella memoria locale di questo browser. Svuotare la cache o impostare il budget della cache delle immagini tradotte su zero e chiudere le pagine che contengono ancora risultati, può rimuoverle. I risultati mancanti richiedono una ritraduzione manuale; l'estensione non può recuperarli da MTU.",
          "Le immagini vanno al servizio MTU selezionato. L'esecuzione di MTU localmente non garantisce la traduzione offline: traduttori online, OCR o modelli di immagini possono inviare testo o immagini ai propri fornitori. La generazione offline richiede originali disponibili, modelli scaricati e una pipeline senza dipendenze online."
        ],
        "links": [
          {
            "label": "Traduzione manga locale: costi, privacy e requisiti offline",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Scegliere un traduttore manga locale per la lettura dal browser",
    "description": "Collega manga-translator-ui al tuo lettore: account, costi, privacy e requisiti per tradurre offline, con file locali, EPUB e fonti compatibili.",
    "category": "Guida alla traduzione locale",
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
        "title": "La traduzione di Manga necessita di un flusso di lavoro basato sulle immagini",
        "paragraphs": [
          "Il dialogo nei manga è solitamente parte dell'opera d'arte. La traduzione del testo di un browser non può reinserire direttamente le parole tradotte nei fumetti. La traduzione di immagini rileva il testo, lo legge con OCR, lo traduce, rimuove i caratteri originali e presenta il risultato.",
          "Se disponi già di un computer in grado di eseguire un servizio di traduzione, puoi utilizzare manga-translator-ui per l'elaborazione delle immagini e NodeLane Comics per la lettura continua dal browser. L'estensione invia immagini dalla finestra di lettura corrente al servizio selezionato e visualizza le traduzioni restituite sul posto."
        ]
      },
      {
        "title": "Lettura locale, un servizio locale e traduzione offline",
        "paragraphs": [
          "\"Locale\" può descrivere dove si trova un file o dove viene eseguito un servizio. Segui l'intero percorso di lavorazione per capire cosa succede al contenuto."
        ],
        "table": {
          "headers": [
            "Termine",
            "Cosa significa"
          ],
          "rows": [
            [
              "Lettura di fumetti locali",
              "Importa file compatibili CBZ/ZIP, CBR/RAR, PDF e MOBI o EPUB senza DRM. EPUB conserva la lettura del documento; si traducono solo le immagini raster incorporate, non il testo del libro o gli elementi vettoriali. Non si importano immagini singole, file KF8/AZW3 autonomi o libri cifrati. I siti richiedono un adattatore dedicato."
            ],
            [
              "Un servizio MTU locale",
              "Le immagini vengono inviate alla tua installazione MTU, che può utilizzare modelli locali o API esterne."
            ],
            [
              "Traduzione completamente offline",
              "Gli originali, i modelli e le dipendenze sono disponibili localmente e ogni fase di elaborazione funziona senza servizi online. Verifica tu stesso l'intera pipeline."
            ]
          ]
        }
      },
      {
        "title": "MTU ospitato autonomamente o il canale ufficiale?",
        "paragraphs": [
          "Un canale locale è adatto ai lettori che già utilizzano MTU o che desiderano mantenere i propri modelli e servizi. Il canale ufficiale riduce la configurazione e la manutenzione. Prova alcune pagine con entrambe le opzioni prima di giudicare i risultati."
        ],
        "table": {
          "headers": [
            "Considerazione",
            "Il tuo canale MTU",
            "Canale ufficiale NodeLane"
          ],
          "rows": [
            [
              "Conto",
              "MTU credenziali; nessun accesso NodeLane",
              "NodeLane login richiesto"
            ],
            [
              "Installazione",
              "Installa, esegui e configura il tuo servizio",
              "Servizio di traduzione gestito da NodeLane"
            ],
            [
              "Costi",
              "Nessuna indennità ufficiale utilizzata; l'hardware, la potenza e le API scelte sono tue",
              "Piani ufficiali e norme sulle indennità"
            ],
            [
              "Cache dei risultati mancante",
              "È richiesta la ritraduzione manuale",
              "I risultati ufficiali idonei possono essere scaricati nuovamente quando disponibili"
            ]
          ]
        },
        "links": [
          {
            "label": "Connetti il tuo servizio locale",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Piani ufficiali e indennità",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "La traduzione dei manga locali è gratuita? Di quale GPU hai bisogno?",
        "paragraphs": [
          "Le traduzioni di MTU non consumano l'indennità ufficiale di NodeLane, ma ciò non rende l'intero flusso di lavoro gratuito. I modelli online possono addebitare costi per richiesta; i modelli locali necessitano di hardware, archiviazione e tempo di elaborazione. Controlla i motori scelti prima di stimare i costi.",
          "Non esiste un unico requisito di memoria per ogni configurazione. Modelli, risoluzione delle immagini, OCR e motori di inpainting influiscono sull'utilizzo delle risorse e sui tempi di elaborazione. Segui la guida all'installazione di MTU per il tuo sistema operativo e hardware, quindi prova una pagina pulita. Non viene promessa alcuna velocità fissa o compatibilità hardware universale."
        ],
        "links": [
          {
            "label": "Guide ufficiali al progetto e all'installazione di MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Dai un'occhiata ai manga giapponesi, ai fumetti coreani e alle lunghe strisce",
        "paragraphs": [
          "Inizia con un originale chiaro e controlla se OCR configurato supporta la sua lingua. Dialoghi verticali, effetti scritti a mano, sfondi complessi e scansioni a bassa risoluzione possono causare la mancanza di testo. Anche le strisce verticali di grandi dimensioni potrebbero richiedere più memoria e tempo.",
          "Scegli una lingua di destinazione disponibile e confronta una o due pagine tradotte con gli originali. Controlla omissioni, nomi, tono e layout delle bolle. I risultati dipendono dai modelli e dalle impostazioni in MTU; una connessione locale non migliora di per sé la precisione della traduzione."
        ]
      },
      {
        "title": "Dove vengono caricate le immagini e cosa funziona offline?",
        "paragraphs": [
          "Con MTU selezionato, l'estensione invia le immagini di traduzione direttamente al servizio configurato anziché tramite il servizio di traduzione ufficiale di NodeLane. Il fatto che MTU inoltri testo o immagini a un fornitore di modelli dipende dai suoi motori abilitati.",
          "I fumetti locali importati e le traduzioni memorizzate nella cache rimangono leggibili finché tali risorse sono disponibili. La generazione di nuove traduzioni offline richiede un servizio locale in esecuzione e una pipeline di elaborazione completamente offline. Anche gli originali del sito web devono essere memorizzati nella cache in anticipo. Mantenere le cache dei risultati riduce il lavoro ripetuto, ma una cache non è un backup permanente."
        ],
        "links": [
          {
            "label": "Caricamenti di immagini e autorizzazioni di estensione",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Inizia con una pagina",
        "paragraphs": [
          "Avvia il servizio Web di MTU e traduci un'immagine nella sua interfaccia. Quindi aggiungi l'indirizzo e l'account del servizio nelle impostazioni NodeLane, connettiti e seleziona la traduzione e una lingua di destinazione.",
          "Se la connessione non riesce, controlla l'indirizzo e l'autorizzazione del browser. Se l'accesso funziona ma non viene visualizzata alcuna immagine, controlla la configurazione di traduzione del servizio. Una piccola prova ti dice di più sull'idoneità alla lettura di tutti i giorni rispetto a un'affermazione generale sulla velocità."
        ],
        "links": [
          {
            "label": "Segui il tutorial sulla traduzione locale",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Scarica il lettore e traduttore di fumetti",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
