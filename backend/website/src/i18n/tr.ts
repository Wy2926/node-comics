import { publishedModels } from '../data/published-plans';
import { localTranslationGuides } from './guides/tr';
import type { Dictionary } from './types';

const membershipSummary = `Yerel okuma ücretsizdir. Free, ${publishedModels.free.join(' · ')} ile günde 30 sayfa sunar. PLUS: ayda 2.500 sayfa, üç ay için US$6,66 veya yıl için US$23,99. Pro: ayda 4.000 sayfa, üç ay için US$9,99 veya yıl için US$35,99. İkisi de ücretsiz modellere ek olarak ${publishedModels.paid_extra.join(' · ')} sunar. Sayfalar her ay verilir, devretmez; deneme yoktur. Süresiz paketler: 3.500 sayfa US$5,99, 7.000 sayfa US$9,99. Vergiler ve toplam ödeme sırasında gösterilir.`;

export default {
  "ui": {
    "seoChangelogTitle": "Manga çeviri uzantısı sürüm notları",
    "seoAboutTitle": "Manga Çevirmenimiz ve Çizgi Roman Okuyucumuz Hakkında",
    "seoHelpTitle": "Manga Çeviri ve Uzantı Sorunlarını Giderme",
    "seoFaqTitle": "Manga çevirisi, EPUB, OPDS ve çevrimdışı okuma soruları",
    "seoGuidesTitle": "Manga çevirisi, EPUB ve OPDS kitaplığı kılavuzları",
    "features": "Özellikler",
    "pricing": "Fiyatlar",
    "guides": "Rehberler",
    "help": "Yardım",
    "account": "Hesabım",
    "download": "Uzantıyı edin",
    "faq": "Sık sorulan sorular",
    "about": "NodeLane Comics hakkında",
    "changelog": "Sürüm notları",
    "privacy": "Gizlilik politikası",
    "terms": "Hizmet koşulları",
    "refund": "Abonelikler ve iadeler",
    "home": "Ana sayfa",
    "skip": "İçeriğe geç",
    "navigation": "Ana gezinme",
    "mobileNavigation": "Mobil gezinme",
    "menu": "Gezinme menüsünü aç",
    "language": "Dil",
    "tagline": "Güzel hikâyeler dil sınırlarını aşar",
    "footerStory": "Koleksiyonunuzu açın, kitaplığınızı bağlayın ve kendi dilinizde okuyun.",
    "startReading": "Okumaya başla",
    "support": "Okuyucu desteği",
    "company": "Hakkımızda",
    "copyright": "Hikâye sevenler için yapıldı.",
    "artNote": "Ürün ekran görüntüleri ve orijinal AI illüstrasyonları · Karikatür çizimleri ilgili sahiplerine aittir",
    "ogAlt": "Orijinal NodeLane Comics sahil manga illüstrasyonu",
    "heroTitle": "Kelimelerin ötesine. Hikâyenin içine.",
    "heroDescription": "Tarayıcınızda manga okuyun ve çevirin: yerel dosyalar ve EPUB, OPDS kitaplıkları, desteklenen siteler ve web sayfalarındaki görseller.",
    "heroEyebrow": "SONRAKİ SAYFAN, SENİN DİLİNDE",
    "freeStart": "Ücretsiz okumaya başla",
    "seeHow": "Nasıl çalıştığını gör",
    "desktop": "Masaüstü tarayıcılar için",
    "heroCaption": "NodeLane Comics için orijinal AI çizimi",
    "heroAlt": "Orijinal manga: Deniz kenarındaki demiryolu platformunda bekleyen bir gezgin",
    "nextStop": "SONRAKİ DURAK / YENİ BİR DÜNYA",
    "featureHeading": "Çizgi romanlarınız, rahat okuma ve ihtiyaç duyduğunuzda çeviri.",
    "featureDescription": "Yerel çizgi roman ve EPUB açın, OPDS bağlayın ve desteklenen sitelerde yeni hikâyeler bulun. Okuyucudaki sayfaları, web görsellerini veya seçtiğiniz görünür alanı çevirip orijinaliyle karşılaştırın.",
    "featureTitles": [
      "Yerel çizgi romanlar ve EPUB",
      "OPDS kitaplıkları",
      "Keşfetme ve siteler arası arama",
      "Web sayfasında çeviri",
      "Resmî kanal veya kendi MTU’nuz",
      "Çevrimdışı okuma ve ayarlar"
    ],
    "featureBodies": [
      "CBZ/ZIP, CBR/RAR, PDF, desteklenen DRM’siz MOBI ve EPUB içe aktarın. EPUB içinde yalnızca gömülü bitmap görseller çevrilir; kitap metni ve vektör grafikler çevrilmez, DRM kaldırılmaz.",
      "Birden fazla OPDS kitaplığı bağlayın, katalogları gezin, arayın ve okuyun. Güvenilir Range desteği varsa veriler okudukça alınır; aksi hâlde dosyanın tamamını açıkça indirmeniz gerekir.",
      "Önerileri keşfedin ve desteklenen farklı sitelerde başlığa göre arayın. Okuyucuya eklemek için site bağdaştırıcısı gerekir; kaynak kataloğu salt okunur kalır.",
      "Geçerli sayfanın görsellerini, sağ tık menüsüyle tek bir görseli veya görünür dikdörtgen alanı çevirin. Alan seçimi kaydırarak uzun görsel birleştirmez; kısayollar tarayıcıdan ayarlanır.",
      "Uzantı normal çeviri kullanır: OCR, metin çevirisi, arka plan onarımı ve dizgi. Resmî kanalı veya kendi manga-translator-ui hizmetinizi seçin. Yeni çizgi roman orijinal olarak açılır; otomatik çeviri varsayılan olarak kapalıdır.",
      "Bir sitede seçilen dilin tüm bölümlerini önbelleğe alın. İndirmeyi duraklatıp eksikleri tamamlayarak sürdürün. Tamamlanan bölümler çevrimdışı okunabilir; okuma görünümünü, ölçeği ve orijinal karşılaştırmasını ayarlayın."
    ],
    "ribbon": [
      "Yerel dosyalar, EPUB ve OPDS",
      "Desteklenen siteler ve web görselleri",
      "Orijinal ve çeviri yan yana",
      "Resmî kanal veya kendi MTU’nuz"
    ],
    "compareTitle": "Diyaloğu anlayın. Duyguyu koru.",
    "compareDescription": "Manganız ile çeviri penceresi arasında geçiş yapmak yok. Kelimeleri tekrar resme koyun ve karakterlerle kalın.",
    "readingTitle": "Koleksiyonunuz. Okumanın yeni bir yolu.",
    "readingDescription": "Yerel dosya, Google Drive, OPDS kitaplığı veya desteklenen bir site açın. Kaydedilen konumdan devam edin, okuyucuyu ayarlayın ve orijinalle karşılaştırın. İlerleme eşitlemesi yalnızca bu özelliği destekleyen ve uyumluluğu doğrulanmış kaynaklarda kullanılabilir.",
    "readingAlt": "Denize bakan bir pencerenin yanında açık bir manganın orijinal illüstrasyonu",
    "guideHeading": "Bir sonraki sayfadan önce birkaç not.",
    "allGuides": "Tüm okuma kılavuzları",
    "readGuide": "Kılavuzu okuyun",
    "minutes": "dk",
    "ctaTitle": "İyi hikayeler anlaşılmayı hak eder.",
    "ctaDescription": "Çeviriyi NodeLane Comics'a bırakın. Dikkatinizi bir sonraki sayfaya saklayın.",
    "ctaButton": "Okuma yolculuğunuza başlayın",
    "pricingTitle": "Ücretsiz okuyun. Çeviri planınızı seçin.",
    "pricingDescription": "PLUS / Pro ve süresiz sayfa paketleri. Üç aylık veya yıllık ödeme, aylık sayfa kotası. Abonelik denemesi yok.",
    "freePlan": "Ücretsiz",
    "freePlanDescription": "Her gün biraz okumak için",
    "free": "ücretsiz",
    "month": "ay",
    "freeBenefits": [
      "Günde 30 standart çeviri sayfası",
      "Web ve yerel çizgi roman okuma",
      "Orijinal karşılaştırması ve okuma konumunun korunması",
      "Geçerli mevcut sonuçlarınıza erişim",
      "Her kayan 60 saniyelik dönemde en fazla 10 yeni çeviri görseli"
    ],
    "freeNote": "Günlük sayfalar Asia/Shanghai saat dilimine göre sıfırlanır; kullanılmayanlar devretmez.",
    "quotaNote": "Bir görüntünün seçilen mod ve dilde başarıyla oluşturulmuş bir versiyonu bir sayfa olarak sayılır. Tekrarlanan istekler ve geçerli sonuçların yeniden kullanımı için iki kez ücret alınmaz. Açıkça yeni bir çeviri, mevcut yetkiyi kullanır. İstek sıklığı, görüntü boyutları ve hizmet kapasitesi sınırları geçerlidir; tamamlanma hızı garanti edilmez.",
    "downloadTitle": "Manga çevirmen uzantınızı yükleyin",
    "downloadDescription": "Chrome, Edge veya Firefox için NodeLane Comics edinin. Chrome Web Store, Edge Add-ons veya Firefox Add-ons mağazasını açın ya da tarayıcınıza uygun paketi indirin.",
    "storeDescription": "Bir sonraki hikayenizi halihazırda kullandığınız tarayıcıda açın.",
    "storeUnavailable": "Mağaza incelemesi bekleniyor",
    "directDownloadTitle": "Uzantıyı doğrudan indirin",
    "directDownloadDescription": "Paketi tarayıcınızın kartından indirin, çıkartın ve aşağıdaki adımları izleyin.",
    "packageUnavailable": "Paket indirilemiyor",
    "downloadZip": "ZIP indir",
    "installTitle": "Chrome / Edge için manuel kurulum",
    "installStepDownload": "ZIP dosyasını indirin ve çıkarın. Çıkarılan klasörü saklayın.",
    "installStepBrowser": "Adres çubuğunda chrome://extensions (Chrome) veya edge://extensions (Edge) öğesini açın ve Geliştirici modunu açın.",
    "installStepLoad": "Paketlenmemiş yükle'ye tıklayın, manifest.json içeren klasörü seçin ve ardından uzantıyı araç çubuğunuza sabitleyin.",
    "manualUpdateNote": "Manuel kurulumlar otomatik olarak güncellenmez. Yeni sürümü indirin, dosyaları orijinal klasöre yerleştirin ve uzantılar sayfasında Yeniden Yükle'ye tıklayın. Kurulum klasörünü yerinde tutun.",
    "downloadXpi": "İmzalı XPI indir",
    "storeHeading": "Tarayıcı mağazası bağlantıları",
    "storeNote": "Chrome, Edge veya Firefox resmi mağazasından yükleyin ya da tarayıcınıza uygun paketi kullanın. Geri bildirim:",
    "guidesTitle": "Manga çevirisi ve çizgi roman okuma kılavuzları",
    "guidesDescription": "CBZ, CBR, PDF, MOBI ve EPUB açın, OPDS bağlayın, web görselleri ve seçilen alanları çevirin. Resmî kanal veya MTU seçin ve bölümleri çevrimdışı okumaya hazırlayın.",
    "contents": "Bu sayfada",
    "editor": "NodeLane Comics editör ekibi",
    "updated": "Güncellendi",
    "related": "Sıradaki rehber",
    "faqTitle": "Manga çevirmen uzantısı SSS",
    "faqDescription": "Kurulum, çizgi roman ve EPUB biçimleri, OPDS, alan çevirisi, çevrimdışı okuma, izinler, MTU ve resmî çeviri kotaları.",
    "helpTitle": "Manga çevirisi ve uzantı yardımı",
    "helpDescription": "İçe aktarma, OPDS, görsel indirme, çeviri, izinler ve MTU bağlantısı sorunlarını çözün. Kılavuzlardan yararlanın veya destekle iletişime geçin.",
    "contactTitle": "Her geri bildirim dikkatle okunmayı hak ediyor.",
    "videoTutorials": "Video eğitimleri",
    "githubSource": "Kaynağı GitHub üzerinde görüntüle",
    "youtubeDescription": "Çizgi romanları nasıl bulacağınızı, içe aktaracağınızı, önbelleğe alacağınızı ve çevireceğinizi öğrenmek için NodeLane YouTube kanalındaki ürün demolarını izleyin.",
    "watchVideos": "YouTube kanalımızı ziyaret edin",
    "contactDescription": "Çeviri kalitesi için uzantıdaki sayfa başına geri bildirim seçeneğini kullanın. Diğer sorunlar için tarayıcınızı, uzantı sürümünüzü, adımlarınızı ve hata mesajınızı bize e-posta ile gönderin. Paylaşma hakkınız olmayan şifreleri, jetonları, ödeme kartı ayrıntılarını, imzalı URL'leri veya çizgi romanların tamamını göndermeyin.",
    "emailButton": "E-posta gönder",
    "aboutTitle": "NodeLane Comics hakkında",
    "aboutDescription": "NodeLane Comics, Chrome, Edge ve Firefox için manga okuma ve çeviri uzantısıdır: yerel çizgi romanlar, EPUB, Google Drive, OPDS ve desteklenen siteler.",
    "aboutBody": "NodeLane Comics, çizgi roman okumayı ve görsel çevirisini tarayıcıda bir araya getirir. Dosyalarınızı açın, Drive veya OPDS bağlayın, desteklenen sitelerde hikâyeler bulun ve sayfaları ya da görünür alanları çevirin. Normal çeviri resmî kanal veya kendi manga-translator-ui hizmetinizle çalışır. Tanıma ve çeviri hata yapabildiği için orijinal her zaman kontrol edilebilir. Çizgi roman kataloğu sunmuyoruz, çizgi roman satmıyoruz ve ödeme duvarı, giriş veya DRM engellerini aşmıyoruz. Yalnızca erişme ve işleme hakkınız olan içeriği kullanın.",
    "changelogTitle": "NodeLane Comics sürüm notları",
    "changelogDescription": "Manga çevirmen güncellemelerini, yeni site desteğini, tarayıcı uyumluluğunu ve okuma düzeltmelerini takip edin. Chrome, Edge ve Firefox mağaza onayları farklı olabilir; yüklü sürümünüzü kontrol edin.",
    "rss": "Güncellemeleri RSS ile takip et",
    "accountTitle": "Hesabım",
    "accountDescription": "Hesabınızı ve üyeliğinizi yönetin. Web sitesindeki görsel çevirisi ve uzantı aynı hesap kullanım haklarını kullanır.",
    "callbackTitle": "Okuyucu geçiş kartınız açılıyor.",
    "callbackDescription": "Oturum açma işlemi tamamlandığında hesabınıza geri döneceksiniz.",
    "noscript": "Hesapta oturum açmak için JavaScript gereklidir. Ürün sayfaları, fiyatlandırma ve kılavuzlar bu olmadan çalışır.",
    "seoHomeTitle": "AI Manga Çevirmeni ve Çizgi Roman Okuyucu Uzantısı | NodeLane Comics",
    "heroLines": [
      "Kelimelerin ötesinde.",
      "Hikayenin içine."
    ],
    "seoFeaturesTitle": "Manga Çevirisi ve Çizgi Roman Okuyucu Özellikleri",
    "seoPricingTitle": "Ücretsiz Manga Çevirisi ve PLUS / Pro Planları",
    "seoDownloadTitle": "Chrome, Edge ve Firefox için Manga Çevirmeni",
    "brandName": "NodeLane Comics",
    "notFoundTitle": "Bir sayfa çok uzakta.",
    "notFoundDescription": "Bu sayfa mevcut değil veya adresi değişmiş. Bir sonraki hikayeniz hala ana sayfada bekliyor."
  },
  "documents": {
    "guides": [
{
  "slug": "manga-translation",
  "minutes": 4,
  "title": "Tarayıcınızda manga nasıl çevrilir",
  "description": "Okuyucuda manga, sağ tık menüsüyle görseller ve sayfanın görünür alanlarını çevirin. Kanalı seçin ve sonucu orijinalle kontrol edin.",
  "category": "Başlarken",
  "sections": [
    {
      "title": "Uzantıyı ve kaynağı hazırlayın",
      "paragraphs": [
        "Masaüstü tarayıcı uzantısını kurun ve erişme hakkınız olan bir çizgi roman açın. Desteklenen site bağdaştırıcısı okuyucuyu açabilir; desteklenmeyen siteler rafa aktarılamaz.",
        "Site erişimi kurulumda bildirilir. Tarayıcı erişimi sınırlayabilir: sayfa ve görsel alan adının izinlerini kontrol edin. Kaynak sitenin çerezleri ve giriş belirteçleri çeviri hizmetine gönderilmez."
      ]
    },
    {
      "title": "Neyi çevireceğinizi seçin",
      "paragraphs": [
        "Geçerli sayfayı çevirin, tek görselin sağ tık menüsünü kullanın veya görünür bir dikdörtgen seçin. Seçim yalnızca görünen alanı alır; kaydırarak uzun sayfa birleştirmez. Kısayolları tarayıcının uzantı ayarlarında belirleyin.",
        "Yeni çizgi romanlar orijinal olarak açılır; otomatik çeviri varsayılan olarak kapalıdır. Açıldığında geçerli ve yakındaki görseller sınırlı bir pencere oluşturur; tüm kitap gönderilmez. Resmî kanal veya bağlı MTU ile hedef dili seçin."
      ]
    },
    {
      "title": "Çeviriyi kontrol edin ve konumu koruyun",
      "paragraphs": [
        "Konumu kaybetmeden orijinal, çeviri ve karşılaştırma arasında geçiş yapın. OCR küçük yazıları, el yazısını veya ses efektlerini atlayabilir; adları ve anlamı orijinalden kontrol edin.",
        "Bir sayfanın hatası diğerlerini durdurmaz. Önce bildirilen nedeni giderin, sonra tekrar deneyin. Yeni bir resmî çeviriyi açıkça istemek yeni sürüm oluşturur ve hesabın güncel haklarını kullanır."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "translation-modes",
  "related": [
    "local-translation",
    "local-manga-translator",
    "manga-translation"
  ],
  "minutes": 5,
  "title": "Normal manga çevirisi: resmî kanal mı, kendi MTU’nuz mu?",
  "description": "Uzantıda normal çevirinin işleyişi ve resmî kanal ile manga-translator-ui arasındaki farklar.",
  "category": "Çeviri ipuçları",
  "sections": [
    {
      "title": "Normal çeviri nasıl çalışır?",
      "paragraphs": [
        "Uzantı metni bulur, OCR ile tanır, çevirir, metin alanındaki arka planı onarır ve sonucu sayfaya yerleştirir. Orijinal karşılaştırma için erişilebilir kalır.",
        "Güncel uzantı yalnızca normal çeviri kullanır."
      ]
    },
    {
      "title": "NodeLane resmî kanalı",
      "paragraphs": [
        "NodeLane hesabınıza girin, dili seçin ve çeviriyi açın. Hizmet seçilen görselleri işler; erişim ve kota hesabınıza bağlıdır. Geçerli sonucu yeniden kullanmak kotadan tekrar düşmez.",
        membershipSummary
      ]
    },
    {
      "title": "Kendi manga-translator-ui hizmetinizi bağlayın",
      "paragraphs": [
        "MTU web hizmetini başlatın, bir görsel çevirisini doğrulayın, sonra kanal ayarlarına adres ve giriş bilgilerini ekleyin. NodeLane hesabı ve resmî kota gerekmez; donanım, modeller ve dış API maliyetleri size aittir.",
        "Birden fazla profil kaydedilebilir, ancak seçilen tek kanal kullanılır. Parola ve belirteç yerelde saklanır; aynı adres ve kullanıcıyla yeniden bağlanırken parolayı boş bırakabilirsiniz. Yerel MTU tamamen çevrimdışı işlemeyi garanti etmez. Parolayı kaydetmek ve alanı boş bırakarak yeniden bağlanmak için uzantı 0.10.2 veya üzeri gerekir; eski sürümlerde her yeniden bağlantıda parola girilmelidir."
      ]
    },
    {
      "title": "Kendi sayfalarınızda karşılaştırın",
      "paragraphs": [
        "Birkaç tipik sayfayla başlayıp eksik metni, adları, anlamı ve dizgiyi kontrol edin. Yeni çizgi roman orijinal olarak açılır ve otomatik çeviri kapalıdır; gerektiğinde açın ve orijinale erişimi koruyun."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "local-comics",
  "related": [
    "local-translation",
    "local-manga-translator",
    "manga-translation"
  ],
  "minutes": 5,
  "title": "Tarayıcıda CBZ, CBR, PDF, MOBI ve EPUB okuyun",
  "description": "Desteklenen yerel biçimler, Google Drive içe aktarması, EPUB sınırları ve çevrimdışı okuma ile çeviri koşulları.",
  "category": "Yerel okuma",
  "sections": [
    {
      "title": "Desteklenen biçimi seçin",
      "paragraphs": [
        "Yerel içe aktarma CBZ/ZIP, CBR/RAR, PDF, desteklenen DRM’siz MOBI ve EPUB biçimlerini destekler. ZIP ve RAR görseller içerir, PDF sayfa olarak görüntülenir, EPUB e-kitap olarak açılır. Dosya uzantısını değiştirmek dönüştürme yapmaz.",
        "Yalnızca okuma ve işleme hakkınız olan dosyaları içe aktarın. Tekil görseller rafa aktarılamaz. Google Drive, CBZ/ZIP ve DRM’siz MOBI destekler; siteden içe aktarma bağdaştırıcı gerektirir."
      ]
    },
    {
      "title": "İçe aktarmayı ve çevrimdışı erişimi kontrol edin",
      "paragraphs": [
        "Tam dosya kullanın; bozulma, parola ve sayfa sırasını kontrol edin. İçe aktardıktan sonra kapak, içindekiler ve görsellere bakın. Orijinaller yerelde hesapsız okunur; resmî çeviri seçilen görselleri gönderir, MTU ise kendi hizmetinize gönderir.",
        "Sitelerde seçilen dilin tüm bölümleri önbelleğe alınabilir; indirme duraklatılıp eksikler tamamlanarak sürdürülebilir. Tamamlanan bölümler çevrimdışı açılır; görev sayfasını kapatmak planı duraklatır. Yerel dosya çevrimdışı çeviri anlamına gelmez."
      ]
    },
    {
      "title": "MOBI ve EPUB: neler çevrilir?",
      "paragraphs": [
        "Yapı kontrolünden geçen DRM’siz MOBI6/MOBI6+KF8 çizgi romanlar desteklenir; bağımsız KF8/AZW3 desteklenmez. EPUB içinde kitap içeriğine gömülü bitmap görseller çevrilir; ana metin, vektör grafikler ve korumalı içerik çevrilmez. DRM kaldırılmaz.",
        "EPUB içinde gezinmek için içindekileri ve okuma ayarlarını kullanın; görsel çevirisini orijinalle kontrol edin. Kitaplık ve yerel konum tarayıcıda saklanır. Uzak ilerleme eşitlemesi yalnızca bu özelliği destekleyen, doğrulanmış OPDS kaynaklarında mümkündür; tüm rafı eşitlemez."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "japanese-manga",
  "minutes": 4,
  "title": "Japon manga çevirilerini neden orijinaliyle karşılaştıralım?",
  "description": "Dikey diyalogları, ima edilen konuları ve ses efektlerini daha fazla bağlamla ve daha az yanlış anlamayla okuyun.",
  "category": "Birlikte okumak",
  "sections": [
    {
      "title": "Bağlam önemlidir",
      "paragraphs": [
        "Japon mangası genellikle konuları atlar ve ilişkileri hitap biçimleri ve cümle sonları aracılığıyla aktarır. Tek bir diyalog balonu, modele yeterli bağlamı sağlamayabilir. Akıcı bir cümle yine de konuşmacıyı veya duyguyu yanlış tanımlayabilir.",
        "Bir ilişki veya neden birdenbire tuhaf görünüyorsa, çeviriyi kesin olarak ele almadan önce orijinali ve komşu panelleri karşılaştırın."
      ]
    },
    {
      "title": "Kaçırılan metne dikkat edin",
      "paragraphs": [
        "Dikey yazı, paneller arasındaki diyaloglar ve arka planlara gömülü ses efektlerinin tespit edilmesi zordur. Küçük el yazısı, gürültü ve düşük çözünürlük tanınmayı kötüleştirebilir.",
        "İşleme izniniz olan net bir orijinal kullanın. Kısmi sonuç bildirimlerine dikkat edin. Önce çevrilen sayfayı okuyun, ardından net olmayan adları veya zamirleri orijinaliyle, karakterlerle ve önceki panellerle karşılaştırın."
      ]
    },
    {
      "title": "Hem kelimeleri hem de görselleri kontrol edin",
      "paragraphs": [
        "Normal çeviri metni atlayabilir veya arka planı ve yazı yerleşimini hatalı onarabilir. Hikâyeyi etkilediklerinde yüz ifadelerini, el yazısını ve arka planı karşılaştırın.",
        "NodeLane Comics orijinali kullanılabilir durumda tutar. Çeviri, eserin kendisini doğrulama yeteneğini ortadan kaldırmadan anlama engelini azaltır."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "translation-troubleshooting",
  "related": [
    "local-translation",
    "local-manga-translator",
    "manga-translation"
  ],
  "minutes": 4,
  "title": "Manga çevirisi başarısız oldu mu yoksa hala mı bekliyorsunuz?",
  "description": "Tekrar denemeden önce görüntü alma, hesap erişimi, başarısız işler ve bilinmeyen sonuçları ayırt edin.",
  "category": "Sorun giderme",
  "sections": [
    {
      "title": "Aşamayı tanımlayın",
      "paragraphs": [
        "Getirilemeyen bir resim, halen işlenmekte olan gönderilen bir görev ve açıkça başarısız olan bir çeviri farklı durumlardır. Önce sayfa mesajını okuyun. Bir sorun sayfası diğerlerini engellemez.",
        "Alma sorunları için görüntünün kaynak sitede normal şekilde açıldığını doğrulayın ve site/CDN izinlerini kontrol edin. Geç yükleme, gezinme veya kaynak kısıtlamaları erişimi etkileyebilir."
      ]
    },
    {
      "title": "Önce asıl görevi çözün",
      "paragraphs": [
        "Resmî görevler sunucuda saklanır: sayfayı kapatmak veya kısa bağlantı kaybı iptal anlamına gelmez. Bağlantı dönünce ilk görevin durumunu bekleyin. MTU seçildiyse işlemi doğrudan hizmette kontrol edin.",
        "Sonuç bilinmiyorsa tekrar sürümler oluşturmak yerine önce görev durumunu kontrol edin."
      ]
    },
    {
      "title": "Erişimi kontrol edin ve net bir şekilde raporlayın",
      "paragraphs": [
        "Resmî hesabın girişini ve güncel haklarını, seçilen kanalın dillerini ve tarayıcı izinlerini kontrol edin. MTU için adresi, girişi ve hizmetin kendi arayüzünde tek görsel çevirisini deneyin. Neden giderilince hatalı sayfayı elle yeniden deneyin.",
        "Tarayıcınızı, uzantı sürümünüzü, adımları, hata mesajını ve varsa görev kimliğini bildirin. Yalnızca gerekli, düzeltilmiş ekran görüntülerini kullanın. Hiçbir zaman kaynak çerezleri, belirteçleri veya imzalı resim URL'lerini göndermeyin. comics@nodelane.net ile iletişime geçin."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "comic-reader-privacy",
  "minutes": 4,
  "title": "Manga çeviri uzantısı ne yükler?",
  "description": "Web sitesi izinlerini, yerel ayrıştırmayı, çeviri yüklemelerini, geçici orijinalleri, özel sonuçları ve silmeyi anlayın.",
  "category": "Gizlilik kılavuzu",
  "sections": [
    {
      "title": "İzinler ve yerel dosyalar",
      "paragraphs": [
        "Uzantı kurulum sırasında tüm HTTP/HTTPS sitelerine ve görsel alan adlarına erişim bildirir; kullanım sırasında her site veya alan adı için ayrı izin istemez. Tarayıcının uzantı ayarlarından erişimi kısıtlayabilirsiniz; ilgili özellikler çalışmazsa tüm sitelere erişimi geri açıp tekrar deneyin. Kaynak sitenin çerezleri, giriş belirteçleri ve tarama geçmişi çeviri hizmetine gönderilmez.",
        "Yerel çizgi roman ayrıştırma tarayıcıda gerçekleşir. Bir dosyayı yerel rafınıza koymak, kaynak dosyanın tamamını yüklemek anlamına gelmez. Çeviri gerektiğinde ilgili sayfa görselleri ve görev bilgileri gönderilir."
      ]
    },
    {
      "title": "Çeviri ve saklama",
      "paragraphs": [
        "Uzantı normal çeviri kullanır. Standart çeviri; tanıma, metin çevirisi, temizleme ve dizgiyi kullanır. Orijinaller, merkezi sunucuda ve bilgi işlem düğümlerinde bulunan ve bir görev tamamlandıktan, başarısız olduktan veya iptal edildikten sonra silinen geçici dosyalardır. Standart çeviri, kaplama dosyalarını korur. Hesabınızda geçerli bir istek olduğu sürece sonuçlar gizli kalır. Tanınan metin, çeviriler ve gerekli meta veriler veritabanında saklanır.",
        "Sonuçlar yalnızca içerik, mod, dil ve etkin yapılandırma eşleştiğinde ve geçerli bir istek kaldığında aynı hesapta yeniden kullanılır. Orijinaller ve sonuçlar kullanıcılar arasında paylaşılmaz. Tarayıcı kaplamaları kendi orijinal görüntüsüyle birleştirir; sunucu kalıcı orijinal kopyaları saklamaz."
      ]
    },
    {
      "title": "Silme ne anlama gelir?",
      "paragraphs": [
        "Bir çeviri kaydının silinmesi, söz konusu isteğin sunucu erişimini anında iptal eder. Hesabınızdaki diğer geçerli istekler kullanılabilir durumda kalır; sonuç dosyası, son geçerli istek iptal edildikten sonra kaldırılır. İndirilen veya önbelleğe alınan kopyalar, siz onları temizleyene kadar cihazınızda kalabilir.",
        "Erişim, düzeltme veya silme talepleri için comics@nodelane.net ile iletişime geçin. Başka bir kişinin verileri kullanılmadan önce kimlik ve kapsam doğrulanmalıdır. Ayrıntılar için gizlilik politikasının tamamını okuyun."
      ]
    }
  ],
  "updated": "2026-10-08"
},
{
  "title": "OPDS kitaplığı bağlayın: okuma, EPUB ve ilerleme",
  "description": "OPDS kitaplıkları ekleyin, gerektikçe veri alarak okuyun ve tam dosya indirme ya da ilerleme eşitlemesinin hangi koşullarda kullanılabildiğini öğrenin.",
  "category": "Uzak kitaplıklar",
  "sections": [
    {
      "title": "Bağlantı ve izinler",
      "paragraphs": [
        "Uzak kitaplıklara OPDS katalog adresini ekleyin ve kaynak istiyorsa giriş bilgilerini girin. Birden fazla bağlantı saklayabilir, katalogları gezebilir ve kitap arayabilirsiniz.",
        "Yalnızca erişme hakkınız olan kitaplıkları ve kitapları kullanın. Kaynak izinleri, tarayıcı erişimi ve biçim desteği geçerlidir; bağlantı giriş, ödeme veya DRM engellerini aşmaz."
      ]
    },
    {
      "title": "Okudukça indirme veya tam dosya",
      "paragraphs": [
        "Güvenilir Range desteği ve dosya doğrulaması varsa okuyucu verileri ihtiyaç oldukça alır. İlk indirme azalır, ancak okumaya devam etmek için kaynağa erişim gerekir.",
        "Kaynak güvenilir kısmi okumayı sağlayamıyorsa açmadan önce dosyanın tamamını açıkça indirin. Akışla okuma, bütün kitabın çevrimdışı kullanım için kaydedildiği anlamına gelmez."
      ]
    },
    {
      "title": "EPUB ve gömülü görseller",
      "paragraphs": [
        "EPUB, içindekiler ve okuma ayarlarıyla açılır. Çeviri kitap içeriğine gömülü bitmap görselleri destekler ve karşılaştırma için orijinali korur.",
        "EPUB metni, vektör grafikler ve DRM ile korunan içerik bu yöntemle çevrilmez. EPUB erişimi her düzenin desteklendiği veya korumanın kaldırılabildiği anlamına gelmez."
      ]
    },
    {
      "title": "İlerleme ve çevrimdışı okuma",
      "paragraphs": [
        "Konum yerelde saklanır. Kaynakla eşitleme yalnızca kaynak bu özelliği destekliyorsa ve uyumluluk doğrulanmışsa kullanılabilir. Eşitleme hatasında yerel konum korunur.",
        "Bu, bütün kitaplığın bulut eşitlemesi değildir. Çevrimdışı okuma için kaynak veriler ve sonuçlar önceden kaydedilmiş olmalıdır. Yeni resmî çeviri internet gerektirir; MTU’nun çevrimdışı çalışması tüm yapılandırmasına bağlıdır."
      ]
    }
  ],
  "slug": "remote-library",
  "minutes": 5,
  "published": "2026-10-04",
  "updated": "2026-10-04",
  "related": [
    "local-comics",
    "manga-translation",
    "translation-troubleshooting"
  ]
},
...localTranslationGuides
],
    "policies": {
      "privacy": {
        "title": "Gizlilik politikası",
        "description": "NodeLane Comics hesapları, görselleri, izinleri, çeviriyi, abonelikleri ve silme işlemlerini nasıl ele alır?",
        "sections": [
          {
            "title": "Web sitesi görseli çevirisi ve konuk denemeleri",
            "paragraphs": [
              "Web sitesi JPG, PNG ve WebP resimlerini kabul eder. Orijinal dosyalar, çeviri girişleri, tüm sonuçlar ve geçmiş bu tarayıcının IndexedDB'sinde saklanır, cihazlar arasında senkronize edilmez. Site verilerinin temizlenmesi bunları kaldırır. \"Yerel kaydı sil\", sunucu görevlerini veya denetim kayıtlarını değil, yalnızca yerel kopyayı kaldırır.",
              "Misafir denemeleri Cloudflare Turnstileni kullanır. Cloudflare, gizlilik politikası kapsamında doğrulama için gereken tarayıcı ve ağ sinyallerini işler; doğrulama taleplerimiz çizgi roman görseller içermiyor. Kötüye kullanımı önlemek için 30 güne kadar dayanan güvenli bir HttpOnly oturum çerezi, HMAC ağ tanımlayıcıları ve yedi gün boyunca saklanan günlük sayaçları kullanıyoruz. Bu tanımlayıcılar takma addır ve tam bir anonimlik garantisi vermez.",
              "Konuk sunucu sonuçları, görev sona erdikten sonra 24 saat süreyle alınabilir, ardından erişim iptal edilir ve dosyalar geri alınır. Kaydedilen yerel sonuçlar kullanılabilir durumda kalır. Görev tamamlandığında girdiler kaldırılır; gerekli görev, maliyet ve güvenlik kayıtları ilgili saklama kurallarına uyar. Aşağıdaki uzun vadeli sonuç saklama, kayıtlı hesaplar için geçerlidir. Misafirler kimlik sağlayıcı hesabı oluşturmaz; oturum açmak geçmişi birleştirmez. Varsayılan deneme, paylaşılan ağ sınırlarıyla birlikte günde en fazla beş yeni görüntüyü kabul eder; başarısızlıklar da sayılır."
            ]
          },
          {
            "title": "Kapsam ve iletişim",
            "paragraphs": [
              "Bu politika, NodeLane Comics ekibi tarafından yürütülen NodeLane Comics web sitesini, uzantısını, okuyucu ve çeviri hizmetlerini kapsar. Gizlilik, erişim, düzeltme veya silme konusunda comics@nodelane.net ile iletişime geçin. 4 Ekim 2026'da güncellendi. Önemli değişiklikler bu sayfada açıklanacak ve uygun şekilde iletilecektir."
            ]
          },
          {
            "title": "Bilgi ve amaçlar",
            "paragraphs": [
              "OIDC oturum açma, hesaplar, avantajlar ve görevler için bir kimlik tanımlayıcı, görünen ad ve rol sağlar. API ürünü erişim belirteçlerini doğrular. Web sitesi, kimlik sağlayıcıya girdiğiniz şifreyi toplamaz.",
              "Çeviri, seçilen sayfa görsellerini, içerik karmalarını, dosya/sayfa tanımlayıcılarını, modu, hedef dili, durumu, sonuçları ve kullanım kayıtlarını işler. Bunlar teslimatı, eşleştirmeyi, kurtarmayı ve geçerli sonuçların yeniden kullanımını destekler. Stripe veya Creem ödeme ve tüm ödeme kartı ayrıntılarını yönetir; Avantajlar, mutabakat ve destek için gereken müşteri, işlem ve abonelik kayıtlarını saklıyoruz.",
              "Geri bildirim, e-posta ve gerekli ekler sorunların araştırılmasına yardımcı olur. Operasyonlar gerekli istek meta verilerini, güvenlik ve hata kayıtlarını içerir. Varsayılan günlükler kimlik bilgilerini, özel görselleri, tam görsel metnini ve imzalı indirme URL'lerini hariç tutar."
            ]
          },
          {
            "title": "İsteğe bağlı uzantı kullanım analizi",
            "paragraphs": [
              "Kullanım analizi varsayılan olarak kapalıdır. Uzantı ayarları aracılığıyla kaydolursanız, özellik kullanımı, başarı ve başarısızlık kategorileri, aktif okuma süresi, arayüz ve hedef diller, kaynak türleri ve uzantı sürümü hakkındaki sınırlı bilgiler, ürünü iyileştirmek için NodeLane'nin arka ucu aracılığıyla Google Analytics 4'e gönderilir. Cihazınızda saklanan rastgele bir tanımlayıcı, kullanımı ayırt eder. Oturum açtığınız hesabınıza bağlı değildir veya reklam hedefleme için kullanılmaz. Bu, takma ad içeren bir tanımlayıcıdır, tam bir anonimlik vaadi değildir.",
              "Analytics, çizgi roman başlıklarını, görselleri ve metinleri, arama terimlerini, dosya adlarını, belirli okuma URL'lerini, çerezleri, kimlik bilgilerini ve özel çeviri hizmeti adreslerini hariç tutar. Okumayı veya çeviriyi etkilemeden daha fazla toplamayı durdurmak ve bekleyen yerel analiz kayıtlarını ve tanımlayıcıyı temizlemek için istediğiniz zaman kapatabilirsiniz. Bu özelliğin kapatılması Google'a gönderilmiş olan verilerin otomatik olarak silinmesine neden olmaz; Tanımlayıp işleyebileceğimiz talepler için bizimle iletişime geçin. Google, kendi gizlilik politikasına ve saklama ayarlarımıza tabi olarak analiz verilerini bölgeniz dışında işleyebilir. GA4 etkinlik düzeyinde ve kullanıcı düzeyinde veri saklama süresi, yeni etkinlikte kullanıcı verilerinin saklanması sıfırlanmadan 14 aya ayarlanmıştır; toplu raporlar bu dönemle sınırlı değildir. Web sitesinin kendisi GA4 kullanım analizlerini toplamaz."
            ]
          },
          {
            "title": "İzinler ve yerel depolama",
            "paragraphs": [
              "Uzantı kurulum sırasında tüm HTTP/HTTPS sitelerine ve görsel alan adlarına erişim bildirir; kullanım sırasında her site veya alan adı için ayrı izin istemez. Tarayıcının uzantı ayarlarından erişimi kısıtlayabilirsiniz; ilgili özellikler çalışmazsa tüm sitelere erişimi geri açıp tekrar deneyin. Kaynak sitenin çerezleri, giriş belirteçleri ve tarama geçmişi çeviri hizmetine gönderilmez.",
              "Konum yerelde saklanır. Kaynakla eşitleme yalnızca kaynak bu özelliği destekliyorsa ve uyumluluk doğrulanmışsa kullanılabilir. Eşitleme hatasında yerel konum korunur. Kitaplık, okuma konumu, tercihler ve içe aktarılan yerel veriler tarayıcıda canlı olarak bulunur; ayrıştırma yereldir ve çeviri istendiğinde ilgili görseller gönderilir. Kitaplık otomatik olarak senkronize edilmez. Web sitesi, hesap ve yetkilendirme durumunu, erişim ve yenileme belirteçlerini mevcut sekmenin oturum deposunda tutar. Uzantının kendi oturum depolama kuralları vardır. Tarayıcı verilerini temizlemek oturumunuzu kapatabilir veya yerel okuma bilgilerini kaldırabilir."
            ]
          },
          {
            "title": "Servis sağlayıcılar ve transferler",
            "paragraphs": [
              "Uzantı normal çeviri kullanır. Klasik işleme, algılama/OCR, metin modelleri, yerel arka plan onarımı ve dizgiyi içerebilir. Metin sağlayıcılar, çeviri için gerekli olan tanınan metni işler. Gerçek sağlayıcılar sunucuda görev için yapılandırılmıştır.",
              "Çeviri görselleri merkezi sunucudaki özel dosyaları kullanır; tanınan metin, çeviriler ve gerekli meta veriler veritabanında saklanır. Kimlik, altyapı, çeviri ve ödeme hizmetleri, verileri gerektiği şekilde geçerli politikaları kapsamında işler. İşleme bölgenizin dışında gerçekleşebilir. Reklam hedefleme için kişisel bilgileri satmıyoruz veya gönderilen çizgi romanları kullanmıyoruz. Tüm sağlayıcıların hiçbir şeyi saklamayacağını veya verileri eğitim için asla kullanmayacağını garanti etmiyoruz; bu sağlayıcıya ve anlaşmaya bağlıdır. Yetkisiz veya uygun olmayan hassas içerik göndermeyin."
            ]
          },
          {
            "title": "Saklama ve silme",
            "paragraphs": [
              "Orijinaller, merkezi sunucuda ve bilgi işlem düğümlerinde bulunan ve bir görev tamamlandıktan, başarısız olduktan veya iptal edildikten sonra silinen geçici dosyalardır. Standart çeviri, kaplama dosyalarını korur. Hesabınızda geçerli bir istek olduğu sürece sonuçlar gizli kalır. Tanınan metin, çeviriler ve gerekli meta veriler veritabanında saklanır.",
              "Sonuçlar yalnızca içerik, mod, dil ve etkin yapılandırma eşleştiğinde ve geçerli bir istek kaldığında aynı hesapta yeniden kullanılır. Orijinaller ve sonuçlar kullanıcılar arasında paylaşılmaz. Tarayıcı kaplamaları kendi orijinal görüntüsüyle birleştirir; sunucu kalıcı orijinal kopyaları saklamaz. Bir çeviri kaydının silinmesi, söz konusu isteğin sunucu erişimini anında iptal eder. Hesabınızdaki diğer geçerli istekler kullanılabilir durumda kalır; sonuç dosyası, son geçerli istek iptal edildikten sonra kaldırılır. İndirilen veya önbelleğe alınan kopyalar, siz onları temizleyene kadar cihazınızda kalabilir.",
              "Hesap silme veya daha geniş kapsamlı silme talepleri için kimlik ve kapsam doğrulaması amacıyla bizimle iletişime geçin. İşlem, denetim veya güvenlik kayıtlarının hizmet yükümlülükleri, anlaşmazlıklar veya geçerli gereksinimler nedeniyle saklanması gerekebilir. Tüm kayıtlar için tek bir silme tarihi sözü verilmemektedir; yanıt, sonucu ve kısıtlamaları açıklayacaktır."
            ]
          },
          {
            "title": "Güvenlik, seçimler ve reşit olmayanlar",
            "paragraphs": [
              "Merkezi sunucu, hesap yetkilendirmesini kontrol eder ve kısa ömürlü imzalı indirme bağlantıları vermeden sonuç dosyalarını doğrudan döndürür. Sağlayıcı anahtarları arka uçta kalır. Hesabınızı ve cihazınızı koruyun ve erişim jetonlarını paylaşmayın. Tarayıcının uzantı ayarlarından site erişimini kısıtlayabilir, çeviriyi durdurabilir, oturumu kapatabilir veya yerel tarayıcı verilerini kaldırabilirsiniz; bu durumda gerekli işlevsellik kullanılamayabilir. Web sitesinde hiçbir reklam izleyici veya üçüncü taraf analiz komut dosyası yoktur.",
              "Reşit olmayanlar hizmeti uygun veli bilgisi ve rehberliği ile kullanmalı ve abonelikler için gerekli yetkiyi almalıdır. Çocukların hassas kişisel bilgilerini göndermeyin. Vasiler, doğrulama ve uygunsuz işlemenin ele alınmasını talep etmek için bizimle iletişime geçebilir. Yalnızca gerekli, düzeltilmiş bilgileri kullanarak güvenlik endişelerini bildirin; şifrelere ve belirteçlere ihtiyaç yoktur."
            ]
          }
        ]
      },
      "terms": {
        "title": "Hizmet şartları",
        "description": "NodeLane Comics kullanma koşulları, içerik hakları, AI sınırlamaları ve abonelikler.",
        "sections": [
          {
            "title": "Hizmet ve hesaplar",
            "paragraphs": [
              "NodeLane Comics uzantı, okuyucu ve çeviri hizmetleri sağlar. Kullanmadan önce bu şartları ve gizlilik politikasını okuyun; katılmıyorsanız hizmeti kullanmayı bırakın. 4 Ekim 2026'da güncellendi. Web sitesi, çizgi roman kataloğu veya çizgi roman satışları değil, ürün bilgileri, kılavuzlar, indirmeler ve hesap yönetimi sağlar.",
              "Kullanma hakkına sahip olduğunuz bir hesap kullanın ve kimlik bilgilerinizi ve cihazınızı koruyun. Avantajlar ve erişim sunucuda doğrulanır. Başkalarının kimliğine bürünmeyin, onların özel kayıtlarına erişmeyin, hız veya görüntü sınırlarını atlamayın, kötü amaçlı otomasyonla hizmetleri kesintiye uğratmayın veya ürüne ve sağlayıcılarına saldırmayın. Yanlış kullanım erişimin kısıtlanmasına neden olabilir."
            ]
          },
          {
            "title": "İçerik hakları ve yapay zeka sonuçları",
            "paragraphs": [
              "Seçilen içeriğe erişme, yükleme, tercüme etme ve işleme hakkına sahip olmanız ve kaynak site ve hak sahibinin gerekliliklerini takip etmeniz gerekir. Uzantı, çevrilmiş görüntüleri yayınlamak için hiçbir telif hakkı veya otomatik izin vermez. Ödeme duvarlarını, oturum açma gerekliliklerini veya DRM'yi atlamayın. Kaynak içeriğinin yasallığını veya eksiksizliğini garanti etmiyoruz. Telif hakkı sorgularında eser, haklar, sorun ve iletişim bilgileri belirtilmelidir.",
              "Yapay zekâ metni atlayabilir, yanlış çevirebilir veya yanlış yerleştirebilir. Sonuçlar okumaya yardımcı olur; orijinalin veya uzman incelemesinin yerini almaz. Sitenin özgün illüstrasyonları yapay zekâ ile üretilmiştir; dil karşılaştırmaları kaydedilmiş normal çeviri örneklerini gösterir. Her görsel için doğruluk, hız veya sonuç garantisi vermez. Orijinalle karşılaştırın ve geri bildirim gönderin."
            ]
          },
          {
            "title": "Avantajlar ve abonelikler",
            "paragraphs": [
              membershipSummary,
              "Abonelikler aylık veya yıllık faturalandırma sunar. Fiyatlar, denemeler ve sayfa izinleri seçilen teklife göre belirlenir ve bu teklif o aralıkta otomatik olarak yenilenir. Fiyat değişiklikleri yeni abonelikler için geçerlidir; mevcut abonelikler orijinal fiyat ve avantaj sürümlerini korur. Yenilemeden önce iptal edin."
            ]
          },
          {
            "title": "Değişiklikler ve iletişim",
            "paragraphs": [
              "Kaynak sitedeki değişiklikler ve üçüncü tarafların kullanılabilirliği görsel almayı, çeviriyi veya oturum açmayı etkileyebilir. Ürünün bakımını yapıyoruz ancak her site, dosya ve dil için kesintisiz erişim veya destek garanti etmiyoruz. Malzeme özelliği, fiyat ve vade değişiklikleri ilgili sayfalarda açıklanacaktır.",
              "Bu şartlar, geçerli yasaların hariç tutulmasına izin vermediği zorunlu tüketici haklarını veya yükümlülüklerini hariç tutmaz. Araştırabilmemiz için gerekli düzeltilmiş ayrıntılarla birlikte sorunlar veya anlaşmazlıklar hakkında comics@nodelane.net ile iletişime geçin."
            ]
          }
        ]
      },
      "refund": {
        "title": "Abonelikler, iptaller ve geri ödemeler",
        "description": "Abonelikler aylık veya yıllık faturalandırma sunar. Fiyatlar, denemeler ve sayfa izinleri seçilen teklife göre belirlenir ve bu teklif o aralıkta otomatik olarak yenilenir. Fiyat değişiklikleri yeni abonelikler için geçerlidir; mevcut abonelikler orijinal fiyat ve avantaj sürümlerini korur. Yenilemeden önce iptal edin.",
        "sections": [
          {
            "title": "Deneme ve faturalandırma",
            "paragraphs": [
              "Abonelikler aylık veya yıllık faturalandırma sunar. Fiyatlar, denemeler ve sayfa izinleri seçilen teklife göre belirlenir ve bu teklif o aralıkta otomatik olarak yenilenir. Fiyat değişiklikleri yeni abonelikler için geçerlidir; mevcut abonelikler orijinal fiyat ve avantaj sürümlerini korur. Yenilemeden önce iptal edin.",
              "Koşulları sağlayan hesaplar, planlarında gösterilen ve kart gerektiren denemeyi başlatabilir. Yeniden abone olmak veya başka bir plan seçmek deneme hakkını sıfırlamaz."
            ]
          },
          {
            "title": "Gelecekteki yenilemeyi durdur",
            "paragraphs": [
              "Aboneliği yönetmek için web sitesi hesabınızda oturum açın veya uzantı hesabı girişini kullanın. İptal, bir sonraki yenilemeyi durdurur ve halihazırda geçerli olan avantajları otomatik olarak silmez; hesabınızda gösterilen süre sonuna güvenin.",
              "Ücretli yenileme istemiyorsanız deneme süresi bitmeden iptal edin. Tarayıcıyı kaldırmak, kapatmak veya oturumu kapatmak aboneliği iptal etmez. Hesabınıza erişemiyorsanız comics@nodelane.net adresine e-posta gönderin."
            ]
          },
          {
            "title": "Sayfa kullanım hakki ve ödeme",
            "paragraphs": [
              "Görev rezervasyonu ödeme işleminden ayrıdır. Açık hata, kurallar uyarınca ayrılmış sayfaları serbest bırakır; önce bilinmeyen bir sonuç doğrulanır. Bu, abonelik ücretlerinin otomatik olarak iadesi değildir. Geçerli mevcut sonuçlar üyeliğin sona ermesinden sonra da erişilebilir olmaya devam ederken, yeni görevler kabul sırasında bu yetkiyi kullanır."
            ]
          },
          {
            "title": "Faturalandırma yardımı veya para iadesi isteyin",
            "paragraphs": [
              "Tekrarlanan ödemeler, anormal işlemler veya kullanılamayan hizmet için hesap tanımlayıcınızı, sipariş/işlem kimliğinizi, tarihinizi ve açıklamanızı e-postayla gönderin. Asla tam kart numarası, şifre veya jeton göndermeyin.",
              "Siparişi, hizmet koşullarını, ödeme kanalı kurallarını ve geçerli tüketici haklarını inceliyor ve ardından sonucu açıklıyoruz. Onay otomatik değildir ve bu politika zorunlu para iadesi veya cayma haklarını hariç tutmaz. Onaylanan geri ödemeler, ödeme sağlayıcının ve kartı veren kuruluşun işlem süresine göre gerçekleşir."
            ]
          }
        ]
      }
    },
    "faqs": [
      {
        "id": "overview",
        "question": "NodeLane Comics nedir?",
        "answer": "NodeLane Comics okuyucuyu ve görsel çevirisini bir araya getirir. Uzantı yerel dosya, EPUB, Google Drive, OPDS ve desteklenen sitelerin yanı sıra web görselleri ve görünür alan çevirisi sunar. Web çalışma alanı JPG, PNG ve WebP kabul eder; sonucu indirmenize ve yerel geçmiş saklamanıza olanak verir. Çizgi roman kataloğu sunmuyoruz.",
        "relatedPath": "/guides/manga-translation/"
      },
      {
        "id": "browsers",
        "question": "Manga çevirmeni Chrome, Edge ve Firefox'de çalışıyor mu?",
        "answer": "Evet, masaüstü Chrome, Microsoft Edge ve Firefox desteklenir. İndirme sayfasındaki resmi mağaza bağlantılarını kullanın veya tarayıcınıza uygun paketi indirin.",
        "relatedPath": "/download/"
      },
      {
        "id": "installation",
        "question": "Manga çevirmen uzantısını veya ZIP paketini nasıl yüklerim?",
        "answer": "İndirme sayfasındaki resmi Chrome, Edge veya Firefox mağaza bağlantılarını kullanın. Manuel Chrome veya Edge kurulumu için, eşleşen ZIP'yi indirip çıkarın, uzantı yöneticisinde Geliştirici modunu etkinleştirin ve Paketlenmemiş yükle'yi seçin. Firefox mağaza girişini veya imzalı XPI'yı kullanır. Talimatlar için indirme sayfasına bakın.",
        "relatedPath": "/download/"
      },
      {
        "id": "free-plan",
        "question": "Manga çevirisi ücretsiz mi ve PLUS / Pro neler içeriyor?",
        "answer": membershipSummary,
        "relatedPath": "/pricing/"
      },
      {
        "id": "translation-modes",
        "question": "Uzantıda hangi çeviri ve kanallar kullanılabilir?",
        "answer": "Güncel uzantı normal çeviri kullanır: OCR, metin çevirisi, arka plan onarımı ve dizgi. NodeLane resmî kanalını veya kendi manga-translator-ui hizmetinizi seçin. Yeni çizgi romanlar orijinal olarak açılır; otomatik çeviri kapalıdır.",
        "relatedPath": "/guides/translation-modes/"
      },
      {
        "id": "file-formats",
        "question": "Hangi dosyaları içe aktarabilirim?",
        "answer": "Yerelde CBZ/ZIP, CBR/RAR, PDF, desteklenen DRM’siz MOBI6/MOBI6+KF8 ve EPUB kullanılabilir. EPUB içinde yalnızca gömülü bitmap görseller çevrilir; ana metin ve vektörler çevrilmez. Google Drive CBZ/ZIP ve DRM’siz MOBI destekler. Bağımsız KF8/AZW3, korumalı kitaplar ve tekil görsel içe aktarması desteklenmez; site içe aktarması bağdaştırıcı gerektirir.",
        "relatedPath": "/guides/local-comics/"
      },
      {
        "id": "website-permissions",
        "question": "Uzantı web sitesi çerezlerini veya tarama geçmişini yüklüyor mu?",
        "answer": "Kaynak sitenin çerezleri, giriş belirteçleri ve tarama geçmişi çeviri hizmetine gönderilmez. Uzantı kurulum sırasında tüm HTTP/HTTPS sitelerine ve görsel alan adlarına erişim bildirir; kullanım sırasında her site veya alan adı için ayrı izin istemez. Tarayıcının uzantı ayarlarından erişimi kısıtlayabilirsiniz; ilgili özellikler çalışmazsa tüm sitelere erişimi geri açıp tekrar deneyin. Çeviriye seçilen görseller ve gerekli görev verileri gönderilir.",
        "relatedPath": "/guides/comic-reader-privacy/"
      },
      {
        "id": "image-privacy",
        "question": "Resimler yükleniyor mu yoksa saklanıyor mu?",
        "answer": "Resmî çeviriyi kullandığınızda aşağıdaki saklama kuralları geçerlidir. MTU için işleme ve saklama koşullarını seçtiğiniz hizmet belirler. Uzantı normal çeviri kullanır. Çeviri, seçilen sayfa görsellerini arka uca ve ilgili sağlayıcılara gönderir. Orijinaller, merkezi sunucuda ve bilgi işlem düğümlerinde bulunan ve bir görev tamamlandıktan, başarısız olduktan veya iptal edildikten sonra silinen geçici dosyalardır. Standart çeviri, kaplama dosyalarını korur. Hesabınızda geçerli bir istek olduğu sürece sonuçlar gizli kalır. Tanınan metin, çeviriler ve gerekli meta veriler veritabanında saklanır. Bir çeviri kaydının silinmesi, söz konusu isteğin sunucu erişimini anında iptal eder. Hesabınızdaki diğer geçerli istekler kullanılabilir durumda kalır; sonuç dosyası, son geçerli istek iptal edildikten sonra kaldırılır. İndirilen veya önbelleğe alınan kopyalar, siz onları temizleyene kadar cihazınızda kalabilir. Kaynak çerezleri, oturum açma belirteçleri ve göz atma geçmişi yüklenmez.",
        "relatedPath": "/privacy/"
      },
      {
        "id": "translation-failed",
        "question": "Başarısız olan çeviriler sayfa kullanıyor mu?",
        "answer": "Hesapla yapılan resmî çeviride sayfalar önce ayrılabilir ve başarılı teslimden sonra kotadan düşülür. Açık bir hata ayrılan kotayı serbest bırakır; metin bulunmayan veya kısmi tanımada orijinal metnin korunduğu normal sonuçlar için de aynı kural geçerlidir. MTU, NodeLane resmî kotasını kullanmaz. Anonim denemelerde çalışma alanının yeni istek sayımı kuralları ayrıca geçerlidir; başarısız denemeler de sayılır.",
        "relatedPath": "/guides/translation-troubleshooting/"
      },
      {
        "id": "plus-limits",
        "question": "PLUS / Pro çeviri sınırları nasıl çalışır?",
        "answer": "Bir hesabın tüm cihazları, modları ve dilleri, her kayan 60 saniyelik dönemde 100 ve her kayan 3.600 saniyelik dönemde 1.200 yeni çeviri görseli sınırını paylaşır. Ücretsiz planda kayan 60 saniyelik dönemde 10 görsele izin verilir. Aynı isteğin tekrar gönderilmesi ve geçerli sonuçların yeniden kullanılması tekrar sayılmaz. Kabul edilen görevler başarısız olsa, iptal edilse veya metin içermese de sayılır. Reddedilen istekler veya geri alınan veritabanı işlemleri, ayrılan saatlik yeri serbest bırakır. Yeniden denemeler yeni görev kabul kurallarına tabidir. Bu sınırlar tamamlanma hızını garanti etmez.",
        "relatedPath": "/pricing/"
      },
      {
        "id": "cancel-subscription",
        "question": "Nasıl iptal edebilirim?",
        "answer": "Aboneliği yönetmek için web sitesi veya uzantı hesabı girişini kullanın. Bir sonraki yenileme veya deneme süresi sona ermeden önce iptal edin; kaldırma işlemi iptal etmez. Mevcut avantajlar, hesabınızda gösterilen sürenin sona ermesinden sonra gelir. Faturalandırma yardımı için comics@nodelane.net adresine e-posta gönderin.",
        "relatedPath": "/refund/"
      },
      {
        "id": "supported-sites",
        "question": "Her sitede ve dilde çalışıyor mu?",
        "answer": "Rafa aktarma için site bağdaştırıcısı gerekir. Diğer sayfalarda erişilebilen görselleri veya seçilen görünür alanı çevirebilirsiniz; sonuç yapıya, tarayıcı erişimine ve kaynak sınırlamalarına bağlıdır. Dilleri seçilen kanalda kontrol edin. Her site, dil ve dosya için destek garanti edilmez.",
        "relatedPath": "/guides/manga-translation/"
      },
      {
        "id": "local-translation",
        "question": "NodeLane hesabı olmadan mangayı yerel bir hizmetle çevirebilir miyim?",
        "answer": "Evet. Kendi manga-translator-ui hizmetinizi başlatıp adres ve giriş bilgilerini kanal ayarlarına ekleyin. Birden fazla profil saklanabilir, ancak seçilen tek kanal kullanılır. NodeLane hesabı veya resmî kota gerekmez; parola ve belirteç yerelde tutulur. Aynı adres ve kullanıcıyla yeniden bağlanırken parolayı boş bırakabilirsiniz. Çevrimdışı çalışma MTU modellerine ve API’lerine bağlıdır. Parolayı kaydetmek ve alanı boş bırakarak yeniden bağlanmak için uzantı 0.10.2 veya üzeri gerekir; eski sürümlerde her yeniden bağlantıda parola girilmelidir.",
        "relatedPath": "/guides/local-translation/"
      },
      {
        "id": "remote-library",
        "question": "Bir OPDS kitaplığı bağlayabilir miyim?",
        "answer": "Evet. Birden fazla OPDS bağlantısı ekleyebilir, katalogları gezebilir, arayabilir ve okuyabilirsiniz. Güvenilir Range gerekli parçaları almayı sağlar; aksi hâlde dosyanın tamamı açıkça indirilmelidir. İlerleme yalnızca bu özelliği destekleyen, doğrulanmış kaynakla eşitlenir.",
        "relatedPath": "/guides/remote-library/"
      },
      {
        "id": "region-translation",
        "question": "Tek bir görseli veya sayfa alanını nasıl çeviririm?",
        "answer": "Görselin sağ tık menüsünü kullanın veya görünür bir dikdörtgen seçin. Geçerli sayfanın görsellerini çevirme de kullanılabilir. Alan kaydırarak birleştirilmez; kısayollar tarayıcıdan ayarlanır. Sonucu orijinalle karşılaştırabilirsiniz.",
        "relatedPath": "/guides/manga-translation/"
      },
      {
        "id": "offline-reading",
        "question": "Çevrimdışı ne okuyabilir ve çevirebilirim?",
        "answer": "Yerel dosyalar ve tamamen önbelleğe alınmış bölümler, veriler cihazda kaldığı sürece açılır. Sitelerde seçilen dilin tüm bölümlerini önbelleğe alıp eksikleri tamamlayın; görev sayfasını kapatmak planı duraklatır. Uzak kısmi okuma bütün kitabı otomatik kaydetmez. Yeni resmî çeviri internet, MTU ise tamamen yerel bir yapılandırma gerektirir.",
        "relatedPath": "/guides/remote-library/"
      }
    ],
    "releases": [
      {
        "id": "0.10.0",
        "date": "2026-10-04",
        "title": "0.10.0: Daha fazla kaynak, daha fazla okuma seçeneği.",
        "items": [
          "Yeni OPDS kütüphaneleri ve okuma ilerlemesi eşitleme",
          "Daha doğru OCR metin tanıma",
          "Mevcut ön çeviri iyileşti, sayfa geçişlerinde daha az bekleme",
          "EPUB okuma ve görsel çevirisi",
          "Web sayfasında alan seçerek çeviri",
          "Okuma ve çeviri kısayollarını özelleştirin",
          "6 yeni çizgi roman sitesi için tam destek: MangaPill, MangaDNA, KLManga, RawLazy, Comic DAYS, Manga One.",
          "Chrome ve Edge 0.10.0 ZIP paketleri ve AMO imzalı Firefox 0.10.0 XPI mevcuttur."
        ]
      },
      {
        "id": "0.9.1",
        "date": "2026-10-02",
        "title": "0.9.1: Uzun çizgi romanlar için daha fazla kaynak ve daha iyi destek",
        "items": [
          "Okumak için doğrudan manga içe aktarımıyla Atsumaru, MangaBall, RawOtaku ve JF00 kaynakları eklendi.",
          "Keşfet sayfasında başlıkları ve açıklamaları çevirin, orijinal ve çevrilmiş metin arasında geçiş yapın, çeviri durumunu kontrol edin ve hataları yeniden deneyin.",
          "Çok uzun çizgi romanlar için iyileştirilmiş standart çeviri; çevrilmiş görüntülerin tamamının kaydedilmesi ve kesintiye uğrayan görevlerin kurtarılması da dahil.",
          "Aşırı uzun görüntüleri JPEG olarak kodlarken boyutun kesilmesi düzeltildi. Çevrilmiş görsellerin tamamı gerektiğinde PNG kullanın.",
          "Orijinalleri değiştirmeden tutarken bazı AVIF görüntülerinde resmi çeviri gönderme hataları düzeltildi.",
          "Her kitap için yakınlaştırmayı hatırlar ve sürekli bölüm yükleme, kaydırma ve okuma konumunu koruma iyileştirmeleriyle bitişik yüksek çözünürlüklü sayfaları önceden yükler.",
          "Süresi dolmuş oturum açma oturumları ve görüntü hataları için uygulama içi sürüm notları ve reddedilebilir bildirimler eklendi.",
          "Chrome ve Edge 0.9.1 ZIP paketleri ve AMO imzalı Firefox 0.9.1 XPI mevcuttur."
        ]
      },
      {
        "id": "0.8.0",
        "date": "2026-09-30",
        "title": "0.8.0: Daha sorunsuz okumak için çevirilerin tamamını kaydedin",
        "items": [
          "Çevrilmiş görsellerin tamamı tarayıcınızda yerel olarak kaydedilir ve yeniden okurken, orijinaller ile çeviriler arasında geçiş yaparken veya dışa aktarırken yeniden kullanılır ve tekrarlanan görüntü kompozisyonu azaltılır.",
          "Bölümleri değiştirdikten sonra doğru konumdan devam edebilmeniz için bölüm sınırları boyunca sabit okuma konumu tutma.",
          "My Comics ilk kurulumdan sonra otomatik olarak açılır ve sizi doğrudan kitaplığınıza götürür.",
          "Çeviri olayı bağlantıları yeniden kullanılır ve müşteri bilgileri önbelleğe alınır, böylece tekrarlanan bağlantılar ve istekler azalır.",
          "Sorunları bildirmek ve önerileri paylaşmak için isteğe bağlı çok dilli kaldırma geri bildirimi eklendi.",
          "Chrome ve Edge 0.8.0 ZIP paketleri ve AMO imzalı Firefox 0.8.0 XPI mevcuttur."
        ]
      },
      {
        "id": "0.7.0",
        "date": "2026-09-29",
        "title": "0.7.0: Pixiv sanatçılarını ve dizilerini içe aktarın",
        "items": [
          "Hem illüstrasyonlar hem de manga içeren Pixiv sanatçı ana sayfalarını içe aktarın, kategorilerden birini seçin veya yalnızca belirli bir etiket altındaki çalışmaları içe aktarın.",
          "Pixiv serisi bağlantılarını doğrudan içe aktarın. Her koleksiyon bir kitap ve her sanat eseri bir bölüm haline gelir; her orijinal görüntü çok sayfalı çalışmalarda mevcuttur.",
          "İçe aktarılan Pixiv kitapları periyodik güncelleme kontrollerini ve kitaplık güncelleme rozetlerini destekler. Aynı koleksiyonu tekrar içe aktardığınızda mevcut kitabınız ve okuma ilerlemeniz korunur.",
          "Pixiv sanatçı, kategori, etiket ve seri sayfalarına içe aktarma/yönetme düğmesi eklendi. Pixiv girişleri alternatif dilde arama işlemini atlar.",
          "Pixiv sanat sayfaları, orijinal ve çevrilmiş görüntüler arasında geçiş yaparak mevcut web sayfası görüntü çeviri deneyimini kullanır.",
          "Chrome ve Edge 0.7.0 paketleri mevcuttur. Firefox imzalı 0.6.0 sürümünde kalmaya devam ediyor ve henüz bu yeni özellikleri içermiyor."
        ]
      },
      {
        "id": "0.6.0",
        "date": "2026-09-27",
        "title": "0.6.0: Mangayı keşfedin ve çevrimdışı okumak için tüm kitapları önbelleğe alın",
        "items": [
          "AniList trend, popüler, en beğenilen ve yeni çıkan mangaları keşfedin. Türe ve daha fazlasına göre filtreleyin, ardından ayrıntılardan bir web sitesi kaynağı bulun ve okumak için içe aktarın.",
          "Tam kataloglar ve bölümler de dahil olmak üzere tüm web sitesi mangasını çevrimdışı okumak için önbelleğe alın. Birden fazla kaynak dil seçin, ilerlemeyi izleyin, duraklatın ve devam ettirin ve başarısız olan sayfaları yeniden deneyin.",
          "MangaDot, Sunday Webry, uluslararası WEBTOON ve Baozimh için destek eklendi ve web sitesi araması, kapaklar ve görsel yüklemede iyileştirmeler yapıldı.",
          "Kitaplığa okuma ilerlemesi, güncelleme sayıları ve filtreler eklendi; sayfalar arasında geçiş yaparken kapağın yeniden kullanımı ve kaydırma restorasyonu iyileştirildi.",
          "Tutarlı çizgi roman tarzı simgeler, hesap rozetleri ve içe aktarma sonuçlarıyla iyileştirilmiş okuyucu önbelleğinin yeniden kullanımı, süresi dolmuş resim URL'lerinden kurtarma ve bölüm sıralama.",
          "Chrome, Edge ve Firefox 0.6.0 indirme paketleri mevcuttur. Firefox, AMO imzalı XPI'yi kullanır."
        ]
      },
      {
        "id": "0.5.0",
        "date": "2026-09-26",
        "title": "0.5.0: Diller ve siteler arasında manga bulun",
        "items": [
          "Kütüphaneden, okuyucudan ve web sayfasından da arama yapılabilen yeni özel manga arama sayfası. Diğer dillerdeki mevcut manga adlarını aramak için oturum açın veya bir anahtar kelimeyi manuel olarak girin.",
          "Sonuçların aşamalı olarak ve kaynağa göre serpiştirilmiş olarak görünmesiyle birden fazla sitede paralel olarak arama yapın. Her sitenin durumunu kontrol edin, hataları yeniden deneyin, daha fazla sonuç yükleyin ve okunacak bir başlığı içe aktarın.",
          "Arama dili ve site seçimleri hatırlanır. Site seçimlerini değiştirmek mevcut sonuçları korur. Arama ekranları artık tutarlı bir tasarımı paylaşıyor ve site dili etiketlerini gösteriyor.",
          "Boşluk içeren anahtar kelimeler için DM5 arama kodlaması düzeltildi. Çeviri kanallarını değiştirmek artık yalnızca yüklü bölümleri yenileyerek gereksiz okuyucu güncellemelerini azaltıyor.",
          "Chrome, Edge ve Firefox 0.5.0 indirmeleri mevcuttur. Firefox, AMO imzalı XPI'yi kullanır; mağaza sürümleri incelemenin tamamlanmasına bağlıdır."
        ]
      },
      {
        "id": "0.4.0",
        "date": "2026-09-25",
        "title": "0.4.0: Daha fazla manga kaynağı, daha akıcı okuma",
        "items": [
          "Birleşik bir web sitesi bağlantısı içe aktarma akışıyla MangaDex ve Guazi Manga kaynakları eklendi. MangaCopy katalog yükleme ve DM5 içe aktarma hatalarından kurtarma iyileştirildi.",
          "Her MangaDex bölümü için, bölümlerin bulunmasını ve aralarında geçiş yapılmasını kolaylaştırmak amacıyla dizindeki dil göstergeleri ile birlikte bir okuma dili seçin.",
          "Okuyucu dizini ve ortak eylemler iyileştirildi, daha fazla vurgu rengi eklendi ve arayüz ve çeviri dili seçicileri iyileştirildi.",
          "Desteklenen sitelerden daha güvenilir resim yükleme için resim istek başlığı kurallarıyla Firefox uyumluluğu düzeltildi.",
          "Chrome ve Edge 0.4.0 indirmeleri mevcuttur. Firefox indirmesi AMO imzalı 0.3.0 olarak kalır; mağaza sürümleri incelemenin tamamlanmasına bağlıdır."
        ]
      },
      {
        "date": "2026-09-25",
        "title": "0.3.0: Kendi çeviri hizmetinizi bağlayın",
        "items": [
          "Yeni çeviri kanalı ayarları, NodeLane veya kendi manga-translator-ui hizmetinizi seçmenize olanak tanır. Birden fazla hizmet yapılandırmasını kaydedin ve NodeLane hesabı olmadan kendi hizmetinizi kullanın.",
          "Okuyucu ve sayfa içi çeviri, mevcut görüntüyü ve sonraki üç görüntüyü çevirerek seçtiğiniz kanalı paylaşır. Kanalların değiştirilmesi okuma konumunu korur ve çevrilmiş görüntüleri ayrı tutar.",
          "Uzun sayfa içi çeviriler, uzantının arka plan işlemi uyurken sonuçları beklemeye devam edebilir. Kesintiye uğrayan bağlantılar, görüntüyü otomatik olarak tekrar göndermeden manuel olarak yeniden deneme imkanı sunar.",
          "İyileştirilmiş çevrilmiş görüntü önbelleğe alma ve dışa aktarma, önbelleği temizlerken net bir rehberlikle birlikte kendi hizmetinizden elde edilen bir sonucun yeniden çevrilmesi gerektiği anlamına gelir.",
          "Ayrı Chrome ve Edge 0.3.0 indirmeleri mevcuttur. Tarayıcınızın güncelleyeceği paketi seçin."
        ]
      },
      {
        "date": "2026-09-20",
        "title": "Okumaya daha net bir başlangıç",
        "items": [
          "Görsel keşfi tıklamanızla başlar ve aynı sayfa yenilenirken seçim ve sıralama korunur.",
          "Hesap yenileme, bağlantı ve yetkilendirme sorunlarına yönelik anlaşılır kurtarma mesajları içerir.",
          "Web sitesi kılavuzlar, ürün bilgileri ve paylaşılan hesap girişi ekler."
        ]
      },
      {
        "date": "2026-09-19",
        "title": "Önce okuma, her defasında çevrilmiş bir sayfa",
        "items": [
          "Otomatik çeviri, okuma konumunu koruyarak geçerli görüntüyü ve sonraki ikisini kapsar.",
          "Dakikalarca süren giriş, yeni çeviri görsellerini sayar; kopyalar ve tamamlanmış sonuçların yeniden kullanımı iki kez sayılmaz.",
          "Sayfa başına sonuçlar ve orijinal görev doğrulama, bağlantı kesildikten sonra kurtarmayı destekler."
        ]
      },
      {
        "date": "2026-09-15",
        "title": "Uzun hikayeler için daha net bir yuva",
        "items": [
          "Ayrı bölüm navigasyonu ve sayfa küçük resimleri.",
          "Mevcut çevirileri moda ve dile göre bulun.",
          "Görüntülerin, çizgi roman arşivlerinin, PDF ve desteklenen DRM koruması olmayan MOBI'nin yerel olarak okunması."
        ]
      }
    ]
  },
  "account": {
    "赠送 PLUS {0} 天": "{0} gün PLUS hediyesi",
    "赠送安排处理中，请刷新查看。": "Hediyeniz planlanıyor. Kontrol etmek için yenileyin.",
    "赠送生效：{0}": "Hediye başlangıcı: {0}",
    "赠送结束：{0}": "Hediye bitiş tarihi: {0}",
    "已付费权益至 {0}": "{0} tarihine kadar ücretli erişim",
    "续费延期处理中，请刷新查看。": "Yenilemeniz erteleniyor. Kontrol etmek için yenileyin.",
    "正在恢复续费，请刷新查看。": "Yenileme devam ediyor. Kontrol etmek için yenileyin.",
    "正在取消续费，请刷新查看。": "Yenileme iptal ediliyor. Kontrol etmek için yenileyin.",
    "续费安排需要核实，请刷新或联系支持。": "Yenilemenizin doğrulanması gerekiyor. Yenileyin veya desteğe başvurun.",
    "赠送期间不扣款，结束后恢复自动续费。": "Hediye süresince yenileme ücreti alınmaz. Daha sonra otomatik yenileme devam eder.",
    "预计恢复续费：{0}": "Beklenen yenileme yeniden başlatması: {0}",
    "下次续费：{0}": "Sonraki yenileme: {0}",
    "已关闭自动续费，已付款及赠送权益保留。": "Otomatik yenileme kapalı. Ücretli ve hediye erişim korunur.",
    "赠送结束后可开通订阅。": "Hediyeniz bittiğinde abone olabilirsiniz.",
    "取消自动续费": "Otomatik yenilemeyi iptal et",
    "取消后保留已付款及赠送权益，到期后不再扣款。": "Ücretli ve hediye erişim, iptalden sonra da kalır. Başka yenileme ücreti yok.",
    "确认取消续费": "İptal işlemini onayla",
    "保留自动续费": "Otomatik yenilemeyi sürdür",
    "账户信息": "Hesap bilgileri",
    "退出登录": "Oturumu kapat",
    "会员有效期至": "Üyelik şu tarihe kadar geçerlidir: ",
    "阅读、翻译和用量查看，请前往浏览器插件。": "Kesintisiz okuma ve uzantı kullanım ayrıntıları için uzantıya gidin; web sitesindeki görsel çevirisi de bu hesabın kotasını kullanır.",
    "下载插件": "Uzantıyı indir",
    "会员订阅": "Üyelik",
    "刷新": "Yenile",
    "订阅状态": "Abonelik durumu",
    "下次计费": "Sonraki ödeme",
    "停止续费时间": "Yenileme sona eriyor",
    "选择订阅套餐": "Bir abonelik seçin",
    "网络连接失败，请检查连接后重试。": "Bağlantı başarısız oldu. Ağınızı kontrol edip tekrar deneyin.",
    "操作暂未完成，请重试或重新登录。": "İşlem tamamlanamadı. Tekrar deneyin veya tekrar oturum açın.",
    "正在确认登录结果，请稍候…": "Oturum açma işleminiz onaylanıyor…",
    "返回账户重新登录 ↗": "Oturum açmak için geri dönün ↗",
    "重试连接": "Bağlantıyı yeniden dene",
    "正在读取你的账户…": "Hesabınız yükleniyor…",
    "下一页，": "Bir sonraki sayfanız.",
    "读懂新世界。": "Anladığınız bir dünya.",
    "あ → 你好": "あ → Merhaba",
    "一个账户，连接官网与插件。": "Web sitesi ve uzantı için tek kimlik.",
    "你的翻译权益，都在这里。": "Çeviri avantajlarınızın tümü burada.",
    "打开你的读者通行证": "Okuyucu kartınızı açın",
    "前往统一身份服务安全登录，完成后自动回到这里。": "Kimlik hizmetimiz aracılığıyla güvenli bir şekilde oturum açın ve ardından otomatik olarak buraya geri dönün.",
    "正在前往登录…": "Oturum açma işlemi açılıyor…",
    "登录 / 注册": "Oturum aç / Kayıt ol",
    "继续前请阅读": "Devam etmeden önce şunları okuyun: ",
    "服务条款": "Hizmet şartları",
    "与": " ve ",
    "隐私政策": "Gizlilik politikası",
    "。官网不会收集你的登录密码。": ". Bu web sitesi şifrenizi toplamaz.",
    "你好，": "Merhaba, ",
    "退出官网账户": "Bu web sitesinden çıkış yapın",
    "当前套餐": "Mevcut plan",
    "普通账户": "Ücretsiz",
    "常规翻译": "Standart çeviri",
    "不限累计页数": "Sınırsız toplam sayfa",
    "页": " sayfa",
    " 页可用": " sayfa kullanılabilir",
    "你的阅读权益": "Okuma kullanım haklarınız",
    "PLUS 权益到期：": "PLUS avantajlarının sona ermesi: ",
    "（北京时间）": " (Asia/Shanghai)",
    "每滚动 60 秒最多新增": "Her kayan 60 saniyelik dönemde en fazla ",
    "张翻译图片，跨模式、语言和设备合计。额度以服务端当前状态为准。": " yeni çeviri görseli; tüm modlar, diller ve cihazlar birlikte sayılır. Kullanım hakkı sunucudaki mevcut duruma göre belirlenir.",
    "打开下一段故事 ↗": "Bir sonraki hikayenizi açın ↗",
    "刷新权益": "Avantajları yenile",
    "PLUS 订阅": "PLUS aboneliği",
    "暂时无法读取订阅状态，请刷新重试。": "Abonelik durumu kullanılamıyor. Tekrar denemek için yenileyin.",
    "订阅服务当前不可用。已有权益不受此提示影响，如需帮助请联系 comics@nodelane.net。": "Abonelikler şu anda kullanılamıyor. Bu bildirim mevcut faydaları değiştirmez. Yardım için comics@nodelane.net ile iletişime geçin.",
    "当前状态：": "Durum: ",
    "订阅生效中": "Aktif",
    "试用中": "Deneme",
    "账单待处理": "Ödeme bekleniyor",
    "下次计费：": "Sonraki faturalandırma: ",
    "已安排取消续费：": "Yenileme iptalinin planlanması: ",
    "确认停止下一次自动续费？现有权益保留至账户显示的到期时间。": "Bir sonraki otomatik yenileme durdurulsun mu? Mevcut avantajlar hesabınızda gösterilen sürenin sonuna kadar kalır.",
    "保持订阅": "Aboneliği sürdür",
    "在 Stripe 管理订阅": "Stripe'da aboneliği yönetin",
    "可在下次续费前取消，税费及应付金额以结账页为准。": "Bir sonraki yenilemeden önce iptal edin. Vergiler ve nihai toplam ödeme sırasında gösterilir.",
    "我已阅读": "Şunları okudum: ",
    "订阅与退款说明": "Abonelikler ve geri ödemeler",
    "，了解自动续费规则。": " ve otomatik yenileme kurallarını anladım.",
    "继续原结账": "Ödeme işlemini devam ettir",
    "前往安全结账": "Güvenli ödeme sayfasına git",
    "退出仅清除官网当前标签页的账户会话，不会取消订阅，也不会退出插件或身份服务中的其他应用。": "Oturumu kapatmak, bu tarayıcının tüm sekmelerindeki site oturumunu temizler. Abonelikleri iptal etmez; uzantıdan veya diğer uygulamalardan çıkış yapmaz.",
    "正式登录服务尚未配置，请稍后重试或联系支持。": "Oturum açma yapılandırılmadı. Lütfen daha sonra tekrar deneyin veya destek ekibiyle iletişime geçin.",
    "暂时无法连接登录服务，请重试。": "Oturum açma hizmetine ulaşılamıyor. Lütfen tekrar deneyin.",
    "登录续期未完成，请检查网络后重试；授权已失效时请重新登录。": "Oturum yenileme başarısız oldu. Bağlantınızı kontrol edin veya yetkilendirmenin süresi dolmuşsa tekrar oturum açın.",
    "登录未完成或授权已过期，请返回账户页重新登录。": "Oturum açma başarısız oldu veya süresi doldu. Tekrar oturum açmak için hesabınıza dönün.",
    "请登录后查看账户。": "Hesabınızı görüntülemek için oturum açın.",
    "账户已退出，请重新登录。": "Çıkış yaptınız. Lütfen tekrar oturum açın.",
    "账户服务暂时不可用，请重试。": "Hesap hizmetleri kullanılamıyor. Lütfen tekrar deneyin.",
    "一页，两种读法。": "Bir sayfa, iki dil.",
    "插画语言对照": "İllüstrasyon dili karşılaştırması",
    "日文原图": "Japonca orijinal",
    "一页，多种语言。": "Bir sayfa. Birçok dil.",
    "英文示意": "İngilizce",
    "韩文示意": "Korece",
    "正在加载图片…": "Resim yükleniyor…",
    "图片加载失败": "Resim yüklenemedi",
    "重新加载": "Yeniden dene",
    "中文示意": "Çin illüstrasyonu",
    "原创漫画：海边站台上的旅人，气泡文字为日文": "Orijinal manga: Japonca diyalogları olan bir sahil gezgini",
    "相同漫画的中文示意：下一站，会是怎样的世界？": "Aynı orijinal manga illüstrasyonunun Çince versiyonu",
    "产品常规翻译实测效果": "Ürünün standart çevirisinden elde edilen gerçek sonuçlar"
  }
} satisfies Dictionary;
