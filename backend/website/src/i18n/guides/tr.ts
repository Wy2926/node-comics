import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Yerel manga çevirisi: manga-translator-ui ile NodeLane arasında bağlantı kurun",
    "description": "manga-translator-ui Web hizmetini kurun, NodeLane'ye bağlayın ve ilk çizgi roman sayfanızı çevirin. Bağlantı, oturum açma, bekleme ve önbellek sorunlarını gidermeyi içerir.",
    "category": "Yerel çeviri eğitimi",
    "minutes": 8,
    "published": "2026-09-28",
    "updated": "2026-10-04",
    "related": [
      "local-manga-translator",
      "local-comics",
      "translation-troubleshooting"
    ],
    "sections": [
      {
        "title": "Başlamadan önce",
        "paragraphs": [
          "NodeLane Comics tarayıcınızda okumayı yönetir; manga-translator-ui (MTU) görüntüleri işler. Kendi MTU kanalınızın NodeLane hesabına ihtiyacı yoktur ve resmi çeviri kullanım hakki kullanmaz. Donanım, modeller ve üçüncü taraf API maliyetleri size ait olmaya devam eder.",
          "En son masaüstü tarayıcı uzantısına, bağımlılıklarıyla birlikte kurulu bir MTU hizmetine ve bu hizmetin kullanıcı adı ile şifresine ihtiyacınız var. Bu eğitimde tarayıcıyla aynı bilgisayarda http://127.0.0.1:8000 kullanılıyor. Farklıysa gerçek bağlantı noktanızı kullanın."
        ],
        "links": [
          {
            "label": "NodeLane Comics'yi indirin",
            "href": "/download/"
          },
          {
            "label": "Resmi MTU kurulumu: Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Resmi MTU kurulumu: Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. MTU Web hizmetini başlatın",
        "paragraphs": [
          "Uzantının bir HTTP Web hizmetine ihtiyacı var. MTU masaüstü penceresini açmak tek başına yeterli değildir. MTU yükledikten sonra bu komutu proje dizininde çalıştırın ve hizmetin çalışır durumda kalmasını sağlayın. Web hizmetini zaten Docker veya başka bir yöntemle çalıştırıyorsanız bu komutu atlayın.",
          "Bu örnek GPU işlemeyi etkinleştirmez. --use-gpu seçeneğini yalnızca resmî belgelerde açıklandığı şekilde desteklenen bir GPU ortamı yapılandırdıktan sonra ekleyin. Model, sürücü ve donanım gereksinimleri MTU sürümünüze bağlıdır."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "Resmi MTU Web başlatma talimatları",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Önce MTU arayüzünde bir deneme görseli çevirin",
        "paragraphs": [
          "Tarayıcınızda http://127.0.0.1:8000 açın, MTU hesap kurulumunu tamamlayın ve oturum açın. Başlangıçta şifre değişikliği gerektiriyorsa, uzantıyı bağlamadan önce bunu MTU'de tamamlayın. Bunlar MTU kimlik bilgileridir ve NodeLane hesabınızdan ayrıdır.",
          "Sunucuda çeviri motorunu, modelleri ve gerekli API anahtarlarını yapılandırın. Ardından bir deneme görselinin çevrilmiş sonuç verdiğini doğrulayın. Uzantı hedef dili ayarlar; diğer çeviri seçeneklerinde sunucu varsayılanlarını kullanır. Web hizmetinin istediğiniz varsayılan ayarlarla çalıştığından emin olun. Uzantının şifre alanına model sağlayıcısının API anahtarını yazmayın."
        ],
        "links": [
          {
            "label": "Resmi MTU projesi ve dokümantasyonu",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Uzantıya bir çeviri kanalı ekleyin",
        "paragraphs": [
          "Uzantının ayarlarını açın ve Çeviri kanallarını bulun. Bağlantı başarılı olduğunda uzantı parolayı ve hizmet belirtecini bu bilgisayarda saklar. Aynı hizmet adresi ve kullanıcı adıyla yeniden bağlanırken parola alanını boş bırakarak kayıtlı parolayı kullanabilirsiniz. Adresi veya kullanıcı adını değiştirirseniz ya da parola değişmiş veya geçersiz hale gelmişse parolayı yeniden girin. Aşağıdaki etiketler arayüz dilinizdeki ilgili kontrolleri açıklamaktadır. Parolayı kaydetmek ve alanı boş bırakarak yeniden bağlanmak için uzantı 0.10.2 veya üzeri gerekir; eski sürümlerde her yeniden bağlantıda parola girilmelidir."
        ],
        "steps": [
          "Çeviri kanalı ekle'yi seçin ve hizmet olarak manga-translator-ui'yi onaylayın. İsteğe bağlı olarak “Bilgisayarım” gibi tanınabilir bir ad verin.",
          "Hizmet adresi olarak http://127.0.0.1:8000 girin. /auth/login, /translate/with-form/image veya yönetim sayfası yolu olmadan hizmet kökünü kullanın.",
          "MTU kullanıcı adınızı ve şifrenizi girin, ardından Bağlan ve kullan'ı seçin. Tarayıcı izin isterse hizmet adresine erişime izin verin.",
          "Geçerli kanalın yeni hizmeti gösterdiğini kontrol edin. Birden fazla hizmet profilini kaydedebilirsiniz ancak aynı anda yalnızca seçilen kanal kullanılır."
        ]
      },
      {
        "title": "4. Çevrilmiş ilk sayfanızı okuyun",
        "paragraphs": [
          "Yerel çizgi roman içe aktarın, EPUB, OPDS veya desteklenen bir site açın. Hedef dili seçip normal çeviriyi açın. Güncel uzantı hem resmî kanalda hem MTU’da normal çeviri kullanır.",
          "Geçerli ve yakındaki görseller sınırlı pencerede öncelik alır; aynı MTU kanalında görseller tek tek başlatılır. Yeni çizgi roman orijinal olarak açılır ve otomatik çeviri varsayılan olarak kapalıdır. Konumu kaybetmeden karşılaştırın; okuyucu ve sayfa çevirisi seçilen kanalı kullanır.",
          "Bir sayfa başarısız olursa manuel olarak yeniden denemeden önce bildirilen sorunu çözün. Bir sayfayı kapatmak veya bağlantıyı kaybetmek MTU'nin hesaplamayı durdurduğunu kanıtlamaz. Hizmet hala meşgulken tekrarlanan gönderimlerden kaçının."
        ],
        "links": [
          {
            "label": "Yerel çizgi romanları ve desteklenen formatları içe aktarma",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Bağlantı, oturum açma ve uzun bekleme sorunlarını giderme",
        "paragraphs": [
          "Uzantıyı yeniden denemeden önce MTU öğesinin kendisini kontrol edin. Bir sorunu bildirirken şifreleri, jetonları veya özel çizgi roman dosyalarını paylaşmayın."
        ],
        "table": {
          "headers": [
            "Belirti",
            "Ne kontrol edilmeli"
          ],
          "rows": [
            [
              "Hizmet adresi açılmıyor",
              "Web hizmetinin çalıştığını ve bağlantı noktasının doğru olduğunu kontrol edin. 127.0.0.1 tarayıcıyı çalıştıran bilgisayar anlamına gelir; farklı bir cihazın kendi ulaşılabilir adresine ihtiyacı vardır."
            ],
            [
              "Sayfa açılıyor ancak uzantı bağlanamıyor",
              "Kök adresini, tarayıcı erişim iznini ve MTU sürümünüzün uyumlu hesap oturum açma ve görüntü çevirisi uç noktaları sağlayıp sağlamadığını kontrol edin."
            ],
            [
              "Yanlış kimlik bilgileri veya ilk şifre değişikliği gerekli",
              "MTU adresinde oturum açın veya ilk şifreyi orada değiştirin ve ardından yeniden bağlanın. NodeLane şifresini veya API model anahtarını değil, MTU kimlik bilgilerini kullanın."
            ],
            [
              "Önceki bir bağlantı artık süresi dolmuş bir oturum açma bilgisini rapor ediyor",
              "Kanal ayarlarında Yeniden Bağlan'ı seçin. Aynı hizmet adresi ve kullanıcı adı için parola alanını boş bırakarak kayıtlı parolayı kullanabilirsiniz. Yalnızca belirteç saklayan eski sürüm ayarlarında, ilk yeniden bağlantıda parolayı bir kez girmeniz gerekir. Adresi veya kullanıcı adını değiştirirseniz ya da parola değişmiş veya geçersiz hale gelmişse parolayı yeniden girin. Uzantı önceki çeviriyi sessizce yeniden göndermez. Parolayı kaydetmek ve alanı boş bırakarak yeniden bağlanmak için uzantı 0.10.2 veya üzeri gerekir; eski sürümlerde her yeniden bağlantıda parola girilmelidir."
            ],
            [
              "Bağlandı ancak çeviri beklemeye devam ediyor",
              "Model indirmelerini, motor yüklemesini, kuyrukları, API dengesini ve donanım kaynaklarını kontrol edin. Aynı konfigürasyonu MTU'de test edin. Bağlanmak yalnızca oturum açma işlemini doğrular."
            ],
            [
              "Kesintiye uğradı, zaman aşımına uğradı veya resim dışında bir şey döndürüldü",
              "MTU görevini, proxy zaman aşımını ve yanıtını kontrol edin. Nedenini düzelttikten sonra başarısız olan sayfayı manuel olarak yeniden deneyin. Uzantı, MTU geçmişinden sonuçları otomatik olarak geri yüklemez."
            ]
          ]
        }
      },
      {
        "title": "Önbellek, çevrimdışı kullanım ve görsellerin nereye gideceği",
        "paragraphs": [
          "Yerel kanal sonuçları bu tarayıcının yerel depolama alanında önbelleğe alınır. Önbelleği temizlemek veya çevrilmiş görüntü önbellek bütçesini sıfıra ayarlamak ve sonuçların hâlâ bulunduğu sayfaları kapatmak, bunları kaldırabilir. Eksik sonuçlar manuel olarak yeniden çeviri gerektirir; uzantı bunları MTU'den geri getiremez.",
          "Görüntüler seçilen MTU servisine gider. MTU'nin yerel olarak çalıştırılması çevrimdışı çeviriyi garanti etmez: çevrimiçi çevirmenler, OCR veya resim modelleri sağlayıcılarına metin veya resim gönderebilir. Çevrimdışı oluşturma, mevcut orijinalleri, indirilen modelleri ve çevrimiçi bağımlılıkları olmayan bir işlem hattını gerektirir."
        ],
        "links": [
          {
            "label": "Yerel manga çevirisi: maliyetler, gizlilik ve çevrimdışı gereksinimler",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Tarayıcıda okumak için yerel bir manga çevirmeni seçme",
    "description": "manga-translator-ui’yi tarayıcı okuyucusuna bağlayın: yerel çizgi romanlar, EPUB ve OPDS, donanım ve API maliyetleri, gizlilik ve çevrimdışı çeviri koşulları.",
    "category": "Yerel çeviri kılavuzu",
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
        "title": "Manga çevirisinin bir görüntü iş akışına ihtiyacı var",
        "paragraphs": [
          "Mangada diyalog genellikle sanat eserinin bir parçasıdır. Bir tarayıcının metin çevirisi, çevrilmiş kelimeleri doğrudan konuşma balonlarına geri koyamaz. Klasik görüntü çevirisi metni algılar, OCR ile okur, çevirir, orijinal harfleri kaldırır ve sonucu ortaya koyar.",
          "Zaten çeviri hizmetini çalıştırabilen bir bilgisayarınız varsa, görüntü işleme için manga-translator-ui ve tarayıcıdan sürekli okuma için NodeLane Comics kullanabilirsiniz. Uzantı, geçerli okuma penceresindeki görüntüleri seçilen hizmete gönderir ve döndürülen çevirileri yerinde görüntüler."
        ]
      },
      {
        "title": "Yerel okuma, yerel hizmet ve çevrimdışı çeviri",
        "paragraphs": [
          "“Yerel”, bir dosyanın nerede yaşadığını veya bir hizmetin nerede çalıştığını tanımlayabilir. İçeriğe ne olduğunu anlamak için işleme yolunun tamamını izleyin."
        ],
        "table": {
          "headers": [
            "Dönem",
            "Bu ne anlama geliyor?"
          ],
          "rows": [
            [
              "Yerel çizgi roman okuması",
              "CBZ/ZIP, CBR/RAR, PDF, desteklenen DRM’siz MOBI veya EPUB içe aktarın. Orijinaller çeviri hizmeti olmadan okunur; EPUB içinde yalnızca gömülü bitmap görseller çevrilir."
            ],
            [
              "Yerel bir MTU hizmeti",
              "Resimler, yerel modelleri veya harici API'leri kullanabilen MTU kurulumunuza gider."
            ],
            [
              "Tamamen çevrimdışı çeviri",
              "Orijinaller, modeller ve bağımlılıklar yerel olarak mevcuttur ve her işleme aşaması çevrimiçi hizmetler olmadan çalışır. Tüm boru hattını kendiniz doğrulayın."
            ]
          ]
        }
      },
      {
        "title": "Kendi kendine barındırılan MTU veya resmi kanal mı?",
        "paragraphs": [
          "Yerel bir kanal, halihazırda MTU çalıştıran veya kendi modellerini ve hizmetlerini sürdürmek isteyen okuyuculara uygundur. Resmi kanal kurulum ve bakımı azaltır. Sonuçları değerlendirmeden önce her iki seçeneği de içeren birkaç sayfayı deneyin."
        ],
        "table": {
          "headers": [
            "dikkate alma",
            "MTU kanalınız",
            "Resmi NodeLane kanalı"
          ],
          "rows": [
            [
              "Hesap",
              "MTU kimlik bilgileri; NodeLane giriş yok",
              "NodeLane oturum açmanız gerekiyor"
            ],
            [
              "Kurulum",
              "Hizmetinizi yükleyin, çalıştırın ve yapılandırın",
              "NodeLane tarafından sağlanan çeviri hizmeti"
            ],
            [
              "Uzatma modları",
              "Normal çeviri",
              "Uzantıda normal çeviri; AI yeniden çizim yalnızca web çalışma alanında uygun haklarla"
            ],
            [
              "Maliyetler",
              "Hiçbir resmi kullanım hakkı kullanılmadı; donanım, güç ve seçilen API'ler sizindir",
              "Resmi planlar ve kullanım hakkı kuralları"
            ],
            [
              "Sonuç önbelleği eksik",
              "Manuel yeniden çeviri gerekli",
              "Uygun resmi sonuçlar mevcut olduğunda tekrar indirilebilir"
            ]
          ]
        },
        "links": [
          {
            "label": "Yerel hizmetinizi bağlayın",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Resmi planlar ve kullanım hakkıler",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "Yerel manga çevirisi ücretsiz mi? Hangi GPU'ya ihtiyacınız var?",
        "paragraphs": [
          "MTU çevirileri NodeLane'nin resmi kullanım hakkıni tüketmez ancak bu, tüm iş akışının maliyetsiz olduğu anlamına gelmez. Çevrimiçi modeller istek başına ücret alabilir; yerel modeller donanıma, depolamaya ve işlem süresine ihtiyaç duyar. Maliyetleri tahmin etmeden önce seçtiğiniz motorları kontrol edin.",
          "Her kurulum için tek bir hafıza gereksinimi yoktur. Modeller, görüntü çözünürlüğü, OCR ve iç boyama motorları kaynak kullanımını ve işlem süresini etkiler. İşletim sisteminiz ve donanımınız için MTU kurulum kılavuzunu izleyin, ardından temiz bir sayfayı test edin. Sabit hız veya evrensel donanım uyumluluğu vaat edilmiyor."
        ],
        "links": [
          {
            "label": "Resmi MTU proje ve kurulum kılavuzları",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Japon mangalarına, Kore çizgi romanlarına ve uzun şeritlere göz atın",
        "paragraphs": [
          "Net bir orijinalle başlayın ve yapılandırılan OCR'nin dilini destekleyip desteklemediğini kontrol edin. Dikey diyalog, el yazısı efektleri, karmaşık arka planlar ve düşük çözünürlüklü taramalar metnin eksik olmasına neden olabilir. Büyük dikey şeritler de daha fazla bellek ve zaman alabilir.",
          "Mevcut bir hedef dili seçin ve çevrilmiş bir veya iki sayfayı orijinalleriyle karşılaştırın. Eksiklikleri, adları, tonu ve kabarcık düzenini kontrol edin. Sonuçlar MTU'deki modellere ve ayarlara bağlıdır; yerel bir bağlantı tek başına çeviri doğruluğunu iyileştirmez."
        ]
      },
      {
        "title": "Resimler nereye yüklenir ve çevrimdışı olarak neler çalışır?",
        "paragraphs": [
          "MTU seçiliyken uzantı, çeviri görüntülerini NodeLane'nin resmi çeviri hizmeti yerine doğrudan yapılandırılmış hizmete gönderir. MTU'nin metni veya resimleri bir model sağlayıcıya iletip iletmeyeceği, etkin motorlara bağlıdır.",
          "İçe aktarılan yerel çizgi romanlar ve önbelleğe alınan çeviriler, bu kaynaklar mevcut olduğu sürece okunabilir durumda kalır. Çevrimdışı yeni çeviriler oluşturmak, çalışan bir yerel hizmet ve tamamen çevrimdışı bir işleme hattı gerektirir. Web sitesi orijinallerinin de önceden önbelleğe alınması gerekir. Sonuç önbelleklerini tutmak tekrarlanan çalışmaları azaltır ancak önbellek kalıcı bir yedekleme değildir."
        ],
        "links": [
          {
            "label": "Resim yüklemeleri ve uzantı izinleri",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Tek sayfayla başlayın",
        "paragraphs": [
          "MTU'in Web hizmetini başlatın ve bir görüntüyü kendi arayüzünde çevirin. Daha sonra NodeLane ayarlarına hizmet adresini ve hesabı ekleyin, bağlanın ve standart çeviri ile hedef dili seçin.",
          "Bağlantı başarısız olursa adresi ve tarayıcı iznini kontrol edin. Oturum açma çalışıyor ancak resim görünmüyorsa hizmetin çeviri yapılandırmasını kontrol edin. Küçük bir deneme size genel bir hız iddiasından ziyade günlük okumaya uygunluk hakkında daha fazla bilgi verir."
        ],
        "links": [
          {
            "label": "Yerel çeviri eğitimini takip edin",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Çizgi roman okuyucuyu ve çevirmeni indirin",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
