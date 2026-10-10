import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Traduction de manga locale : connectez manga-translator-ui à NodeLane",
    "description": "Configurez le service Web manga-translator-ui, connectez-le à NodeLane et traduisez votre première page de bande dessinée. Comprend la connexion, la connexion, l'attente et le dépannage du cache.",
    "category": "Tutoriel de traduction locale",
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
        "title": "Avant de commencer",
        "paragraphs": [
          "NodeLane Comics gère la lecture dans votre navigateur ; manga-translator-ui (MTU) traite les images. Votre propre chaîne MTU ne nécessite aucun compte NodeLane et n'utilise aucune allocation de traduction officielle. Les coûts du matériel, des modèles et des API tiers restent à votre charge.",
          "Vous avez besoin de la dernière extension de navigateur de bureau, d'un service MTU installé avec ses dépendances, ainsi que du nom d'utilisateur et du mot de passe de ce service. Ce didacticiel utilise http://127.0.0.1:8000 sur le même ordinateur que le navigateur. Utilisez votre port actuel s'il diffère."
        ],
        "links": [
          {
            "label": "Télécharger NodeLane Comics",
            "href": "/download/"
          },
          {
            "label": "Installation officielle de MTU : Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Installation officielle de MTU : Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. Démarrez le service Web MTU",
        "paragraphs": [
          "L'extension nécessite un service Web HTTP. Ouvrir la fenêtre du bureau MTU seul ne suffit pas. Après avoir installé MTU, exécutez cette commande dans son répertoire de projet et laissez le service fonctionner. Ignorez cette commande si vous exécutez déjà le service Web via Docker ou une autre méthode.",
          "Cet exemple n'active pas le traitement GPU. Ajoutez --use-gpu uniquement après avoir configuré un environnement GPU pris en charge comme décrit en amont. Les exigences en matière de modèle, de pilote et de matériel dépendent de votre version MTU."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "Instructions officielles de lancement du Web MTU",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Traduisez d'abord une image de test dans MTU",
        "paragraphs": [
          "Ouvrez http://127.0.0.1:8000 dans votre navigateur, terminez la configuration du compte MTU et connectez-vous. Si cela nécessite un changement initial de mot de passe, complétez-le dans MTU avant de connecter l'extension. Il s'agit d'informations d'identification MTU, distinctes de votre compte NodeLane.",
          "Configurez le traducteur, les modèles et toutes les clés API requises sur le serveur, puis confirmez qu'une image de test produit une image traduite. L'extension définit la langue cible et utilise les paramètres par défaut du serveur pour les autres paramètres de traduction. Assurez-vous que le service Web utilise les valeurs par défaut prévues. N’entrez pas de clé de modèle API dans le champ du mot de passe de l’extension."
        ],
        "links": [
          {
            "label": "Projet et documentation officiels MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Ajoutez un canal de traduction dans l'extension",
        "paragraphs": [
          "Après connexion, le mot de passe et le jeton MTU sont conservés localement sur cet ordinateur. Avec la même adresse de service et le même nom d’utilisateur, laissez le mot de passe vide pour réutiliser celui enregistré. Saisissez-le à nouveau si l’adresse, le compte ou le mot de passe change, s’il n’est plus valide ou si un ancien profil ne contient qu’un jeton. L’enregistrement du mot de passe et la reconnexion avec un champ vide nécessitent l’extension 0.10.2 ou une version ultérieure ; les versions précédentes demandent le mot de passe à chaque reconnexion."
        ],
        "steps": [
          "Choisissez Ajouter un canal de traduction et confirmez manga-translator-ui comme service. Donnez-lui éventuellement un nom reconnaissable, tel que « Mon ordinateur ».",
          "Entrez http://127.0.0.1:8000 comme adresse de service. Utilisez la racine du service, sans /auth/login, /translate/with-form/image ou un chemin de page d'administration.",
          "Entrez votre nom d’utilisateur et votre mot de passe MTU, puis choisissez Se connecter et utiliser. La connexion ne demande pas d’autorisation de site supplémentaire ; si l’accès est restreint, rétablissez l’accès à tous les sites dans les réglages de l’extension et réessayez.",
          "Vérifiez que la chaîne actuelle affiche le nouveau service. Vous pouvez enregistrer plusieurs profils de service, mais seul le canal sélectionné est utilisé à la fois."
        ]
      },
      {
        "title": "4. Lisez votre première page traduite",
        "paragraphs": [
          "Importez un manga local ou ouvrez une source compatible dans le lecteur. Choisissez une langue cible et la traduction avec votre canal MTU sélectionné.",
          "La page actuelle est prioritaire, suivie d’une fenêtre limitée d’images voisines. Les images sont traitées une par une sur le même canal MTU. Comparez l’original et la traduction sans perdre votre position ; le lecteur et la traduction sur la page utilisent le même service sélectionné.",
          "Si une page échoue, résolvez le problème signalé avant de réessayer manuellement. Fermer une page ou perdre la connexion ne prouve pas que MTU a arrêté le calcul. Évitez les soumissions répétées alors que le service est encore occupé."
        ],
        "links": [
          {
            "label": "Importation de bandes dessinées locales et de formats pris en charge",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Dépanner les connexions, la connexion et les longues attentes",
        "paragraphs": [
          "Vérifiez MTU lui-même avant de réessayer dans l'extension. Ne partagez pas de mots de passe, de jetons ou de fichiers de bandes dessinées privés lorsque vous signalez un problème."
        ],
        "table": {
          "headers": [
            "Symptôme",
            "Que vérifier"
          ],
          "rows": [
            [
              "L'adresse de service ne s'ouvre pas",
              "Vérifiez que le service Web est en cours d'exécution et que le port est correct. 127.0.0.1 désigne l'ordinateur exécutant le navigateur ; un autre appareil a besoin de sa propre adresse accessible."
            ],
            [
              "La page s'ouvre, mais l'extension ne parvient pas à se connecter",
              "Vérifiez l'adresse racine, l'autorisation d'accès au navigateur et si votre version MTU fournit des points de terminaison de connexion au compte et de traduction d'images compatibles."
            ],
            [
              "Informations d'identification erronées ou changement de mot de passe initial requis",
              "Connectez-vous à MTU ou modifiez-y le mot de passe initial, puis reconnectez-vous. Utilisez les informations d'identification MTU, et non un mot de passe NodeLane ou une clé modèle API."
            ],
            [
              "Une connexion précédente signale désormais une connexion expirée",
              "Choisissez Reconnecter dans les paramètres du canal. Avec la même adresse de service et le même nom d'utilisateur, laissez le mot de passe vide pour le réutiliser. Saisissez-le à nouveau si l'adresse ou le nom d'utilisateur change, si le mot de passe a changé ou n'est plus valide, ou si un ancien profil ne contient qu'un jeton. L'extension ne renvoie pas silencieusement la traduction précédente. L’enregistrement du mot de passe et la reconnexion avec un champ vide nécessitent l’extension 0.10.2 ou une version ultérieure ; les versions précédentes demandent le mot de passe à chaque reconnexion."
            ],
            [
              "Connecté, mais la traduction attend",
              "Vérifiez les téléchargements de modèles, le chargement du moteur, les files d'attente, le solde API et les ressources matérielles. Testez la même configuration dans MTU. La connexion vérifie uniquement la connexion."
            ],
            [
              "Interrompu, expiré ou renvoyé autre chose qu'une image",
              "Vérifiez la tâche MTU, le délai d'expiration du proxy et la réponse. Réessayez manuellement la page ayant échoué après avoir corrigé la cause. L'extension ne restaure pas automatiquement les résultats de l'historique MTU."
            ]
          ]
        }
      },
      {
        "title": "Cache, utilisation hors ligne et destination des images",
        "paragraphs": [
          "Les résultats des canaux locaux sont mis en cache dans le stockage local de ce navigateur. Vider le cache ou définir le budget du cache des images traduites à zéro et fermer les pages contenant encore des résultats peut les supprimer. Les résultats manquants nécessitent une retraduction manuelle ; l'extension ne peut pas les récupérer depuis MTU.",
          "Les images vont au service MTU sélectionné. L'exécution locale de MTU ne garantit pas la traduction hors ligne : les traducteurs en ligne, OCR ou les modèles d'images peuvent envoyer du texte ou des images à leurs fournisseurs. La génération hors ligne nécessite des originaux disponibles, des modèles téléchargés et un pipeline sans dépendances en ligne."
        ],
        "links": [
          {
            "label": "Traduction locale de mangas : coûts, confidentialité et exigences hors ligne",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Choisir un traducteur de manga local pour la lecture sur navigateur",
    "description": "Connectez manga-translator-ui au lecteur de mangas : comptes, coûts, confidentialité et conditions de traduction hors ligne, avec fichiers locaux, EPUB et sources compatibles.",
    "category": "Guide de traduction local",
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
        "title": "La traduction de mangas nécessite un flux de travail d'images",
        "paragraphs": [
          "Les dialogues dans les mangas font généralement partie de l’œuvre d’art. La traduction de texte d’un navigateur ne peut pas directement remettre les mots traduits dans des bulles. La traduction d'images détecte le texte, le lit avec OCR, le traduit, supprime le lettrage original et présente le résultat.",
          "Si vous disposez déjà d'un ordinateur capable d'exécuter un service de traduction, vous pouvez utiliser manga-translator-ui pour le traitement des images et NodeLane Comics pour la lecture continue du navigateur. L'extension envoie les images de la fenêtre de lecture actuelle au service sélectionné et affiche les traductions renvoyées sur place."
        ]
      },
      {
        "title": "Lecture locale, service de proximité et traduction hors ligne",
        "paragraphs": [
          "« Local » peut décrire l'emplacement où se trouve un fichier ou l'endroit où un service s'exécute. Suivez tout le chemin de traitement pour comprendre ce qui arrive au contenu."
        ],
        "table": {
          "headers": [
            "Durée",
            "Ce que cela signifie"
          ],
          "rows": [
            [
              "Lecture de BD locale",
              "Importez des fichiers CBZ/ZIP, CBR/RAR, PDF et des MOBI ou EPUB sans DRM compatibles. L’EPUB conserve la lecture du document ; seules ses images matricielles intégrées peuvent être traduites, pas le texte du livre ni les éléments vectoriels. Les images individuelles, les fichiers KF8/AZW3 autonomes et les livres chiffrés ne sont pas importés. Les sites nécessitent un adaptateur dédié."
            ],
            [
              "Un service local MTU",
              "Les images sont envoyées à votre installation MTU, qui peut utiliser des modèles locaux ou des API externes."
            ],
            [
              "Traduction entièrement hors ligne",
              "Les originaux, les modèles et les dépendances sont disponibles localement et chaque étape de traitement fonctionne sans services en ligne. Vérifiez vous-même l’ensemble du pipeline."
            ]
          ]
        }
      },
      {
        "title": "MTU auto-hébergé ou la chaîne officielle ?",
        "paragraphs": [
          "Une chaîne locale convient aux lecteurs qui utilisent déjà MTU ou qui souhaitent conserver leurs propres modèles et services. La chaîne officielle réduit la configuration et la maintenance. Essayez quelques pages avec l’une ou l’autre option avant de juger les résultats."
        ],
        "table": {
          "headers": [
            "Considération",
            "Votre chaîne MTU",
            "Chaîne officielle NodeLane"
          ],
          "rows": [
            [
              "Compte",
              "Informations d'identification MTU ; pas de connexion NodeLane",
              "Connexion NodeLane requise"
            ],
            [
              "Configuration",
              "Installez, exécutez et configurez votre service",
              "Service de traduction géré par NodeLane"
            ],
            [
              "Coûts",
              "Aucune allocation officielle utilisée ; le matériel, la puissance et les API choisies vous appartiennent",
              "Plans officiels et règles d'allocation"
            ],
            [
              "Cache des résultats manquant",
              "Retraduction manuelle requise",
              "Les résultats officiels éligibles peuvent être à nouveau téléchargés lorsqu'ils sont disponibles"
            ]
          ]
        },
        "links": [
          {
            "label": "Connectez votre service local",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Plans officiels et allocations",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "La traduction locale des mangas est-elle gratuite ? De quel GPU avez-vous besoin ?",
        "paragraphs": [
          "Les traductions MTU ne consomment pas l'allocation officielle de NodeLane, mais cela ne rend pas l'ensemble du flux de travail gratuit. Les modèles en ligne peuvent facturer par demande ; les modèles locaux ont besoin de matériel, de stockage et de temps de traitement. Vérifiez les moteurs que vous avez choisis avant d'estimer les coûts.",
          "Il n’y a pas d’exigence de mémoire unique pour chaque configuration. Les modèles, la résolution de l'image, OCR et les moteurs d'inpainting affectent l'utilisation des ressources et le temps de traitement. Suivez les instructions d'installation de MTU pour votre système d'exploitation et votre matériel, puis testez une page claire. Aucune vitesse fixe ni compatibilité matérielle universelle n’est promise."
        ],
        "links": [
          {
            "label": "Guides officiels de projet et d'installation MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Découvrez les mangas japonais, les bandes dessinées coréennes et les longues bandes dessinées",
        "paragraphs": [
          "Commencez avec un original clair et vérifiez si le OCR configuré prend en charge sa langue. Les dialogues verticaux, les effets manuscrits, les arrière-plans complexes et les numérisations à basse résolution peuvent entraîner des textes manquants. Les grandes bandes verticales peuvent également prendre plus de mémoire et de temps.",
          "Choisissez une langue cible disponible et comparez une ou deux pages traduites avec les originaux. Vérifiez les omissions, les noms, le ton et la disposition des bulles. Les résultats dépendent des modèles et des paramètres dans MTU ; une connexion locale n’améliore pas en soi la précision de la traduction."
        ]
      },
      {
        "title": "Où les images sont-elles téléchargées et qu'est-ce qui fonctionne hors ligne ?",
        "paragraphs": [
          "Avec MTU sélectionné, l'extension envoie les images de traduction directement à ce service configuré plutôt que via le service de traduction officiel de NodeLane. Le fait que MTU transmette du texte ou des images à un fournisseur de modèles dépend de ses moteurs activés.",
          "Les bandes dessinées locales importées et les traductions mises en cache restent lisibles tant que ces ressources sont disponibles. La génération de nouvelles traductions hors ligne nécessite un service local en cours d'exécution et un pipeline de traitement entièrement hors ligne. Les originaux du site Web doivent également être mis en cache à l’avance. La conservation des caches de résultats réduit le travail répété, mais un cache n'est pas une sauvegarde permanente."
        ],
        "links": [
          {
            "label": "Téléchargements d'images et autorisations d'extension",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Commencez par une page",
        "paragraphs": [
          "Démarrez le service Web de MTU et traduisez une image dans sa propre interface. Ajoutez ensuite l'adresse du service et le compte dans les paramètres NodeLane, connectez-vous et sélectionnez la traduction et une langue cible.",
          "Si la connexion échoue, vérifiez l'adresse et l'autorisation du navigateur. Si la connexion fonctionne mais qu'aucune image n'apparaît, vérifiez la configuration de traduction du service. Un petit essai vous en dit plus sur l’aptitude à la lecture quotidienne qu’une affirmation générale sur la vitesse."
        ],
        "links": [
          {
            "label": "Suivez le tutoriel de traduction locale",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Téléchargez le lecteur et traducteur de bandes dessinées",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
