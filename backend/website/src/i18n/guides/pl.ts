import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Lokalne tłumaczenie mangi: połącz manga-translator-ui z NodeLane",
    "description": "Skonfiguruj usługę internetową manga-translator-ui, podłącz ją do NodeLane i przetłumacz swoją pierwszą stronę komiksu. Obejmuje rozwiązywanie problemów z połączeniem, logowaniem, oczekiwaniem i pamięcią podręczną.",
    "category": "Samouczek tłumaczenia lokalnego",
    "minutes": 8,
    "published": "2026-09-28",
    "updated": "2026-09-28",
    "related": [
      "local-manga-translator",
      "local-comics",
      "translation-troubleshooting"
    ],
    "sections": [
      {
        "title": "Zanim zaczniesz",
        "paragraphs": [
          "NodeLane Comics obsługuje odczyt w Twojej przeglądarce; manga-translator-ui (MTU) przetwarza obrazy. Twój własny kanał MTU nie wymaga konta NodeLane i nie korzysta z oficjalnych tłumaczeń. Koszty sprzętu, modeli i stron trzecich API pozostają Twoje.",
          "Potrzebujesz najnowszego rozszerzenia przeglądarki na komputerze stacjonarnym, zainstalowanej usługi MTU wraz z jej zależnościami oraz nazwy użytkownika i hasła tej usługi. W tym samouczku zastosowano http://127.0.0.1:8000 na tym samym komputerze, co przeglądarka. Użyj rzeczywistego portu, jeśli jest inny."
        ],
        "links": [
          {
            "label": "Pobierz NodeLane Comics",
            "href": "/download/"
          },
          {
            "label": "Oficjalna instalacja MTU: Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Oficjalna instalacja MTU: Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. Uruchom usługę internetową MTU",
        "paragraphs": [
          "Rozszerzenie wymaga usługi internetowej HTTP. Samo otwarcie okna pulpitu MTU nie wystarczy. Po zainstalowaniu MTU uruchom to polecenie w katalogu projektu i nie wyłączaj usługi. Pomiń to polecenie, jeśli usługa sieci Web została już uruchomiona za pośrednictwem platformy Docker lub innej metody.",
          "Ten przykład nie włącza przetwarzania GPU. Dodaj --use-gpu dopiero po skonfigurowaniu obsługiwanego środowiska GPU zgodnie z opisem powyżej. Wymagania dotyczące modelu, sterownika i sprzętu zależą od wersji MTU."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "Oficjalne instrukcje uruchamiania MTU w Internecie",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Najpierw przetłumacz obraz testowy w MTU",
        "paragraphs": [
          "Otwórz http://127.0.0.1:8000 w swojej przeglądarce, dokończ konfigurację konta MTU i zaloguj się. Jeśli wymaga to wstępnej zmiany hasła, dokończ to w MTU przed podłączeniem rozszerzenia. Są to dane uwierzytelniające MTU, niezależne od Twojego konta NodeLane.",
          "Skonfiguruj tłumacz, modele i wszelkie wymagane klucze API na serwerze, a następnie potwierdź, że obraz testowy generuje przetłumaczony obraz. Rozszerzenie ustawia język docelowy i używa ustawień domyślnych serwera dla innych ustawień tłumaczenia. Upewnij się, że usługa sieci Web używa zamierzonych ustawień domyślnych. Nie wpisuj klucza modelu API w polu hasła numeru wewnętrznego."
        ],
        "links": [
          {
            "label": "Oficjalny projekt i dokumentacja MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Dodaj kanał tłumaczeniowy w rozszerzeniu",
        "paragraphs": [
          "Otwórz ustawienia rozszerzenia i znajdź kanały tłumaczeń. Po udanym połączeniu rozszerzenie przechowuje token usługi, a nie wprowadzone hasło. Etykiety poniżej opisują odpowiednie elementy sterujące w języku interfejsu."
        ],
        "steps": [
          "Wybierz opcję Dodaj kanał tłumaczeniowy i potwierdź manga-translator-ui jako usługę. Opcjonalnie nadaj mu rozpoznawalną nazwę, na przykład „Mój komputer”.",
          "Wpisz http://127.0.0.1:8000 jako adres usługi. Użyj katalogu głównego usługi, bez /auth/login, /translate/with-form/image lub ścieżki strony administracyjnej.",
          "Wprowadź swoją nazwę użytkownika i hasło MTU, a następnie wybierz opcję Połącz i używaj. Zezwól na dostęp do adresu usługi, jeśli przeglądarka poprosi o pozwolenie.",
          "Sprawdź, czy bieżący kanał pokazuje nową usługę. Możesz zapisać wiele profili usług, ale jednocześnie używany będzie tylko wybrany kanał."
        ]
      },
      {
        "title": "4. Przeczytaj swoją pierwszą przetłumaczoną stronę",
        "paragraphs": [
          "Zaimportuj lokalny komiks lub otwórz obsługiwaną witrynę internetową w czytniku. Wybierz język docelowy i tłumaczenie klasyczne, a następnie poczekaj na bieżącą stronę. Kanał MTU obsługuje obecnie tylko tłumaczenie klasyczne, a nie oficjalny tryb przerysowywania AI NodeLane.",
          "Bieżąca strona ma pierwszeństwo, po niej następują trzy kolejne strony. Obrazy są wyświetlane pojedynczo na tym samym kanale MTU. Wróć do oryginału lub porównaj obok siebie, nie tracąc pozycji do czytania. Czytelnik i tłumaczenie na stronie korzystają z tego samego wybranego kanału.",
          "Jeśli strona nie powiedzie się, rozwiąż zgłoszony problem przed ponowną próbą ręczną. Zamknięcie strony lub utrata połączenia nie oznacza, że ​​MTU przestał działać. Unikaj wielokrotnego przesyłania zgłoszeń, gdy usługa może być nadal zajęta."
        ],
        "links": [
          {
            "label": "Importowanie lokalnych komiksów i obsługiwanych formatów",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Rozwiązywanie problemów z połączeniami, logowaniem i długimi oczekiwaniami",
        "paragraphs": [
          "Sprawdź sam MTU przed ponowną próbą rozszerzenia. Zgłaszając problem, nie udostępniaj haseł, tokenów ani prywatnych plików komiksowych."
        ],
        "table": {
          "headers": [
            "Objaw",
            "Co sprawdzić"
          ],
          "rows": [
            [
              "Adres usługi nie otwiera się",
              "Sprawdź, czy usługa internetowa jest uruchomiona i czy port jest prawidłowy. 127.0.0.1 oznacza komputer, na którym działa przeglądarka; inne urządzenie potrzebuje własnego osiągalnego adresu."
            ],
            [
              "Strona otwiera się, ale rozszerzenie nie może się połączyć",
              "Sprawdź adres główny, uprawnienia dostępu przeglądarki i czy Twoja wersja MTU zapewnia kompatybilne punkty końcowe logowania do konta i translacji obrazów."
            ],
            [
              "Wymagane są nieprawidłowe dane uwierzytelniające lub początkowa zmiana hasła",
              "Zaloguj się do MTU lub zmień tam początkowe hasło, a następnie połącz się ponownie. Użyj poświadczeń MTU, a nie hasła NodeLane lub klucza modelu API."
            ],
            [
              "Poprzednie połączenie zgłasza teraz wygasły login",
              "W ustawieniach kanału wybierz Połącz ponownie i wprowadź ponownie hasło serwisowe. Rozszerzenie nie wysyła ponownie w trybie cichym poprzedniego tłumaczenia."
            ],
            [
              "Połączono, ale tłumaczenie wciąż czeka",
              "Sprawdź pobieranie modeli, ładowanie silnika, kolejki, saldo API i zasoby sprzętowe. Przetestuj tę samą konfigurację w MTU. Połączenie weryfikuje jedynie logowanie."
            ],
            [
              "Przerwano, przekroczono limit czasu lub zwrócono coś innego niż obraz",
              "Sprawdź zadanie MTU, limit czasu proxy i odpowiedź. Ponów ręcznie nieudaną stronę po naprawieniu przyczyny. Rozszerzenie nie przywraca automatycznie wyników z historii MTU."
            ]
          ]
        }
      },
      {
        "title": "Pamięć podręczna, korzystanie w trybie offline i miejsce przechowywania obrazów",
        "paragraphs": [
          "Wyniki z kanału lokalnego są buforowane w pamięci lokalnej tej przeglądarki. Wyczyszczenie pamięci podręcznej lub ustawienie budżetu pamięci podręcznej przetłumaczonych obrazów na zero i zamknięcie stron, które nadal zawierają wyniki, może je usunąć. Brakujące wyniki wymagają ręcznego ponownego tłumaczenia; rozszerzenie nie może ich pobrać z MTU.",
          "Obrazy trafiają do wybranego serwisu MTU. Lokalne uruchomienie MTU nie gwarantuje tłumaczenia offline: tłumacze online, OCR lub modele obrazów mogą wysyłać tekst lub obrazy do swoich dostawców. Generowanie offline wymaga dostępnych oryginałów, pobranych modeli i potoku bez zależności online."
        ],
        "links": [
          {
            "label": "Lokalne tłumaczenie mangi: koszty, wymagania dotyczące prywatności i trybu offline",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Wybór lokalnego tłumacza mangi do czytania w przeglądarce",
    "description": "Użyj manga-translator-ui z czytnikiem komiksów w przeglądarce: poznaj lokalne tłumaczenie mangi, koszty sprzętu i API, prywatność, wymagania offline oraz obsługę czytania CBZ i PDF.",
    "category": "Lokalny przewodnik tłumaczeniowy",
    "minutes": 6,
    "published": "2026-09-28",
    "updated": "2026-09-28",
    "related": [
      "local-translation",
      "translation-modes",
      "local-comics"
    ],
    "sections": [
      {
        "title": "Tłumaczenie mangi wymaga przepływu pracy z obrazami",
        "paragraphs": [
          "Dialog w mandze jest zwykle częścią grafiki. Tłumaczenie tekstu w przeglądarce nie może bezpośrednio umieścić przetłumaczonych słów z powrotem w dymkach. Klasyczne tłumaczenie obrazu wykrywa tekst, czyta go za pomocą OCR, tłumaczy, usuwa oryginalne litery i wyświetla wynik.",
          "Jeżeli posiadasz już komputer, na którym możesz wykonać usługę tłumaczeniową, możesz użyć manga-translator-ui do przetwarzania obrazu i NodeLane Comics do ciągłego czytania w przeglądarce. Rozszerzenie wysyła obrazy z bieżącego okna czytania do wybranego serwisu i na miejscu wyświetla zwrócone tłumaczenia."
        ]
      },
      {
        "title": "Lokalne czytanie, lokalna usługa i tłumaczenie offline",
        "paragraphs": [
          "„Lokalny” może opisywać, gdzie znajduje się plik lub gdzie działa usługa. Prześledź całą ścieżkę przetwarzania, aby zrozumieć, co dzieje się z treścią."
        ],
        "table": {
          "headers": [
            "Termin",
            "Co to znaczy"
          ],
          "rows": [
            [
              "Lokalne czytanie komiksów",
              "Zaimportuj do przeglądarki pliki CBZ / ZIP, CBR / RAR, PDF lub obsługiwane pliki MOBI bez DRM. Czytanie oryginałów nie wymaga usług tłumaczeniowych."
            ],
            [
              "Lokalna usługa MTU",
              "Obrazy trafiają do instalacji MTU, która może korzystać z modeli lokalnych lub zewnętrznych interfejsów API."
            ],
            [
              "Tłumaczenie całkowicie offline",
              "Oryginały, modele i zależności są dostępne lokalnie, a każdy etap przetwarzania przebiega bez usług online. Sprawdź sam cały rurociąg."
            ]
          ]
        }
      },
      {
        "title": "Własny hosting MTU czy oficjalny kanał?",
        "paragraphs": [
          "Kanał lokalny jest odpowiedni dla czytelników, którzy już prowadzą MTU lub chcą zachować własne modele i usługi. Oficjalny kanał ogranicza konfigurację i konserwację. Wypróbuj kilka stron z dowolną opcją, zanim ocenisz wyniki."
        ],
        "table": {
          "headers": [
            "Rozpatrzenie",
            "Twój kanał MTU",
            "Oficjalny kanał NodeLane"
          ],
          "rows": [
            [
              "Konto",
              "MTU dane uwierzytelniające; nie NodeLane logowania",
              "NodeLane wymagane logowanie"
            ],
            [
              "Konfiguracja",
              "Zainstaluj, uruchom i skonfiguruj swoją usługę",
              "Usługa tłumaczeniowa prowadzona przez NodeLane"
            ],
            [
              "Tryby rozszerzeń",
              "Obecnie tylko tłumaczenie klasyczne",
              "Tłumaczenie klasyczne i przerysowanie AI, pod warunkiem dostępu do konta"
            ],
            [
              "Koszty",
              "Nie wykorzystano żadnego oficjalnego dodatku; sprzęt, moc i wybrane API są Twoje",
              "Oficjalne plany i zasady zasiłków"
            ],
            [
              "Brak pamięci podręcznej wyników",
              "Wymagane ręczne ponowne tłumaczenie",
              "Kwalifikujące się oficjalne wyniki można pobrać ponownie, jeśli są dostępne"
            ]
          ]
        },
        "links": [
          {
            "label": "Połącz swoją usługę lokalną",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Oficjalne plany i dodatki",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "Czy lokalne tłumaczenie mangi jest bezpłatne? Jakiego procesora graficznego potrzebujesz?",
        "paragraphs": [
          "Tłumaczenia MTU nie pochłaniają oficjalnego dodatku NodeLane, ale to nie oznacza, że cały przepływ pracy jest darmowy. Modelki online mogą pobierać opłaty za każde żądanie; modele lokalne wymagają sprzętu, przechowywania i czasu przetwarzania. Przed oszacowaniem kosztów sprawdź wybrane silniki.",
          "Nie ma jednego wymagania dotyczącego pamięci dla każdej konfiguracji. Modele, rozdzielczość obrazu, OCR i silniki do malowania wpływają na wykorzystanie zasobów i czas przetwarzania. Postępuj zgodnie ze wskazówkami instalacyjnymi MTU dotyczącymi Twojego systemu operacyjnego i sprzętu, a następnie przetestuj jedną przejrzystą stronę. Nie gwarantuje się stałej prędkości ani uniwersalnej kompatybilności sprzętowej."
        ],
        "links": [
          {
            "label": "Oficjalne podręczniki projektu i instalacji MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Sprawdź japońską mangę, koreańskie komiksy i długie paski",
        "paragraphs": [
          "Zacznij od czystego oryginału i sprawdź, czy skonfigurowany OCR obsługuje jego język. Dialogi pionowe, efekty pisma odręcznego, złożone tła i skany w niskiej rozdzielczości mogą powodować brak tekstu. Duże pionowe paski mogą również wymagać więcej pamięci i czasu.",
          "Wybierz dostępny język docelowy i porównaj jedną lub dwie przetłumaczone strony z oryginałami. Sprawdź pominięcia, nazwy, ton i układ bąbelków. Wyniki zależą od modeli i ustawień w MTU; połączenie lokalne samo w sobie nie poprawia dokładności tłumaczenia."
        ]
      },
      {
        "title": "Gdzie przesyłane są obrazy i co działa w trybie offline?",
        "paragraphs": [
          "Po wybraniu MTU rozszerzenie wysyła obrazy tłumaczeń bezpośrednio do skonfigurowanej usługi, a nie za pośrednictwem oficjalnej usługi tłumaczeń NodeLane. To, czy MTU przekazuje tekst lub obrazy do dostawcy modelu, zależy od włączonych silników.",
          "Zaimportowane lokalne komiksy i tłumaczenia w pamięci podręcznej pozostają czytelne, dopóki te zasoby są dostępne. Generowanie nowych tłumaczeń w trybie offline wymaga działającej usługi lokalnej i potoku przetwarzania w pełni offline. Oryginały witryn internetowych również muszą być wcześniej przechowywane w pamięci podręcznej. Utrzymywanie pamięci podręcznej wyników ogranicza powtarzalną pracę, ale pamięć podręczna nie jest trwałą kopią zapasową."
        ],
        "links": [
          {
            "label": "Przesyłanie obrazów i uprawnienia do rozszerzeń",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Zacznij od jednej strony",
        "paragraphs": [
          "Uruchom usługę internetową MTU i przetłumacz jeden obraz w jej własnym interfejsie. Następnie dodaj adres usługi i konto w ustawieniach NodeLane, połącz się i wybierz tłumaczenie klasyczne oraz język docelowy.",
          "Jeśli połączenie nie powiedzie się, sprawdź adres i uprawnienia przeglądarki. Jeśli logowanie działa, ale nie pojawia się żaden obraz, sprawdź konfigurację tłumaczenia usługi. Mała próba powie Ci więcej o przydatności do codziennego czytania niż ogólne twierdzenie o szybkości."
        ],
        "links": [
          {
            "label": "Postępuj zgodnie z lokalnym samouczkiem dotyczącym tłumaczenia",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Pobierz czytnik komiksów i tłumacz",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
