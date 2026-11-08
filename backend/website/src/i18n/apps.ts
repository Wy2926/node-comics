import type { Guide, Locale } from './types';
import { appRelease } from '../data/app';

interface AppCopy {
  downloads: string; extensions: string; apps: string; firefoxAndroid: string;
  store: string; available: string; iosStatus: string; iosNotice: string;
  guide: string; status: string; androidTitle: string; description: string;
  download: string; requirements: string; choose: string; devices: [string, string];
  install: [string, string]; usage: [string, string][]; screenshots: string;
}

export const appCopy: Record<Locale, AppCopy> = {
  'zh-CN': {
    downloads: "下载浏览器插件与 App", extensions: '浏览器插件', apps: '独立 App', firefoxAndroid: 'Android Firefox',
    store: '前往商店', available: '已发布 · APK', iosStatus: '正在适配 IPA 包中', iosNotice: 'iOS App 正在适配 IPA 包中，尚未公开发行，也未提供安装包。目前可使用 Android App、浏览器插件或网页图片翻译。',
    guide: '下载与安装教程', status: '查看适配状态', androidTitle: 'Android App：下载、安装与开始阅读', description: '把书架、漫画来源和阅读器装进口袋，用 NodeLane 漫译 App 随读随译。',
    download: '下载最新版 APK', requirements: 'Android 7.0 及以上 · 独立安装，无需浏览器插件', choose: '每台设备只需一个 APK。普通手机优先 arm64-v8a，32 位设备选 armeabi-v7a，对应设备或模拟器选 x86_64。不确定时请先查看设备规格。', devices: ['32 位 Android 设备', '对应设备或模拟器'],
    install: ['安装并打开 App', '下载后打开 APK；如果系统提示，允许用于下载的浏览器或文件管理器“安装未知应用”，再按系统提示完成安装。安装后可关闭该权限。每台设备只需一个对应架构的 APK。'],
    usage: [
      ['查找漫画来源', '打开“来源”，浏览漫画来源，或使用跨来源搜索查找作品。选择可访问的来源，打开漫画详情。'],
      ['收藏到书架', '把喜欢的作品加入书架，从书架打开漫画，继续上次的阅读进度。'],
      ['阅读与图片翻译', '打开章节，按习惯选择滚动、单页或双页阅读。需要翻译时先登录 NodeLane 账号，再使用图片翻译，随时切回原图。也可在内置多标签浏览器中打开网站阅读。'],
    ],
    screenshots: '共用 App 界面示意：截图来自 iOS 模拟器的中文界面，Android 界面可能略有差异。漫画内容与封面归各自权利人所有。',
  },
  'zh-TW': {
    downloads: "下載瀏覽器擴充功能與 App", extensions: '瀏覽器擴充功能', apps: '獨立 App', firefoxAndroid: 'Android Firefox',
    store: '前往商店', available: '已發佈 · APK', iosStatus: '正在適配 IPA 套件', iosNotice: 'iOS App 正在適配 IPA 套件，尚未公開發行，也未提供安裝套件。目前可使用 Android App、瀏覽器擴充功能或網頁圖片翻譯。',
    guide: '下載與安裝教學', status: '查看適配狀態', androidTitle: 'Android App：下載、安裝與開始閱讀', description: '把書架、漫畫來源和閱讀器裝進口袋，用 NodeLane 漫譯 App 隨讀隨譯。',
    download: '下載最新版 APK', requirements: 'Android 7.0 以上 · 獨立安裝，無需瀏覽器擴充功能', choose: '每台裝置只需一個 APK。一般手機優先選 arm64-v8a，32 位元裝置選 armeabi-v7a，對應裝置或模擬器選 x86_64。不確定時請先查看裝置規格。', devices: ['32 位元 Android 裝置', '對應裝置或模擬器'],
    install: ['安裝並開啟 App', '下載後開啟 APK；若系統提示，允許下載用的瀏覽器或檔案管理員「安裝未知應用程式」，再依系統指示安裝。完成後可關閉此權限。每台裝置只需一個對應架構的 APK。'],
    usage: [
      ['查找漫畫來源', '開啟「來源」瀏覽漫畫來源，或使用跨來源搜尋尋找作品。選擇可存取的來源，開啟漫畫詳情。'],
      ['收藏到書架', '把喜歡的作品加入書架，從書架開啟漫畫，接續上次的閱讀進度。'],
      ['閱讀與圖片翻譯', '開啟章節，選擇捲動、單頁或雙頁閱讀。需要翻譯時先登入 NodeLane 帳號，再使用圖片翻譯，隨時切回原圖。也可在內建多分頁瀏覽器中開啟網站閱讀。'],
    ],
    screenshots: '共用 App 介面示意：截圖來自 iOS 模擬器的中文介面，Android 介面可能略有差異。漫畫內容與封面歸各自權利人所有。',
  },
  en: {
    downloads: "Download extensions and apps", extensions: 'Browser extensions', apps: 'Standalone apps', firefoxAndroid: 'Firefox for Android',
    store: 'Open store', available: 'Available · APK', iosStatus: 'IPA adaptation in progress', iosNotice: 'The iOS app is being adapted for IPA packaging. It has not been publicly released and no installer is available. For now, use the Android app, browser extension or web image translation.',
    guide: 'Download & setup', status: 'View status', androidTitle: 'Android app: download, install and start reading', description: 'Keep your library, comic sources and reader in your pocket with NodeLane Comics.',
    download: 'Download latest APK', requirements: 'Android 7.0 or later · Standalone app, no browser extension needed', choose: 'Install just one APK: arm64-v8a for most phones, armeabi-v7a for 32-bit devices, or x86_64 for matching devices and emulators. Check your device specifications if unsure.', devices: ['32-bit Android devices', 'Matching devices or emulators'],
    install: ['Install and open the app', 'Open the downloaded APK. If prompted, allow the browser or file manager you used to install unknown apps, then follow the system prompts. You can turn this permission off afterward. Install only one APK matching your device architecture.'],
    usage: [
      ['Find a comic source', 'Open Sources to browse comic sources or search across sources. Choose an accessible source and open a comic’s details.'],
      ['Save to your library', 'Add a title to your library, then open it from there to continue from your last reading position.'],
      ['Read and translate images', 'Open a chapter and choose scrolling, single-page or double-page reading. Sign in to NodeLane before using image translation; you can switch back to the original. You can also read websites in the built-in multi-tab browser.'],
    ],
    screenshots: 'Shared app interface preview: these Chinese-language screenshots come from an iOS simulator. Android may look slightly different. Comic content and covers belong to their respective rights holders.',
  },
  ja: {
    downloads: "拡張機能とアプリのダウンロード", extensions: 'ブラウザー拡張機能', apps: '独立アプリ', firefoxAndroid: 'Android 版 Firefox',
    store: 'ストアを開く', available: '公開済み · APK', iosStatus: 'IPA パッケージ対応中', iosNotice: 'iOS アプリは IPA パッケージへの対応作業中です。まだ一般公開されておらず、インストール用ファイルはありません。当面は Android アプリ、ブラウザー拡張機能、Web 画像翻訳をご利用ください。',
    guide: 'ダウンロードと導入', status: '対応状況を見る', androidTitle: 'Android アプリ：ダウンロードから読書まで', description: '本棚、漫画のソース、リーダーをポケットに。NodeLane Comics で読みながら翻訳。',
    download: '最新 APK をダウンロード', requirements: 'Android 7.0 以降 · 拡張機能不要の独立アプリ', choose: 'APK は一つだけ必要です。一般的なスマートフォンは arm64-v8a、32 ビット端末は armeabi-v7a、対応端末やエミュレーターは x86_64 を選びます。不明な場合は端末の仕様をご確認ください。', devices: ['32 ビット Android 端末', '対応端末・エミュレーター'],
    install: ['インストールして開く', 'ダウンロードした APK を開きます。求められた場合は、使用したブラウザーやファイル管理アプリに不明なアプリのインストールを許可し、画面の案内に従います。完了後は許可を解除できます。端末に合う APK 一つだけをインストールしてください。'],
    usage: [
      ['漫画のソースを探す', '「ソース」で漫画の配信元を閲覧するか、複数ソースを横断検索します。アクセスできるソースを選び、作品の詳細を開きます。'],
      ['本棚に追加する', '気に入った作品を本棚に追加します。本棚から開くと、前回の続きから読めます。'],
      ['読む・画像を翻訳する', '章を開き、スクロール、単ページ、見開きを選びます。画像翻訳には NodeLane へのログインが必要です。いつでも原画に戻せます。内蔵のマルチタブブラウザーでも Web サイトを読めます。'],
    ],
    screenshots: '共通アプリ画面の参考：iOS シミュレーターの中国語画面です。Android では表示が異なる場合があります。漫画と表紙の権利は各権利者に帰属します。',
  },
  ko: {
    downloads: "확장 프로그램 및 앱 다운로드", extensions: '브라우저 확장 프로그램', apps: '독립 앱', firefoxAndroid: 'Android용 Firefox',
    store: '스토어 열기', available: '출시됨 · APK', iosStatus: 'IPA 패키지 대응 작업 중', iosNotice: 'iOS 앱은 IPA 패키지 대응 작업 중입니다. 아직 정식 공개되지 않았으며 설치 파일도 제공하지 않습니다. 현재는 Android 앱, 브라우저 확장 프로그램 또는 웹 이미지 번역을 이용하세요.',
    guide: '다운로드 및 설치', status: '대응 상태 보기', androidTitle: 'Android 앱: 다운로드, 설치 및 읽기', description: 'NodeLane Comics로 서재, 만화 소스, 리더를 주머니에 담고 읽으며 번역하세요.',
    download: '최신 APK 다운로드', requirements: 'Android 7.0 이상 · 확장 프로그램 없이 독립 실행', choose: 'APK 하나만 설치하세요. 일반 휴대폰은 arm64-v8a, 32비트 기기는 armeabi-v7a, 해당 기기나 에뮬레이터는 x86_64를 선택하세요. 잘 모르겠다면 기기 사양을 확인하세요.', devices: ['32비트 Android 기기', '해당 기기 또는 에뮬레이터'],
    install: ['앱 설치 및 실행', '다운로드한 APK를 여세요. 요청이 나타나면 사용한 브라우저나 파일 관리자에 알 수 없는 앱 설치를 허용한 뒤 시스템 안내를 따르세요. 설치 후 이 권한을 끌 수 있습니다. 기기에 맞는 APK 하나만 설치하세요.'],
    usage: [
      ['만화 소스 찾기', '소스를 열어 만화 소스를 둘러보거나 여러 소스를 한 번에 검색하세요. 접근 가능한 소스를 선택하고 작품 상세 화면을 여세요.'],
      ['서재에 추가하기', '좋아하는 작품을 서재에 추가하세요. 서재에서 열면 마지막으로 읽던 위치부터 이어서 볼 수 있습니다.'],
      ['읽기 및 이미지 번역', '장을 열고 스크롤, 한 페이지 또는 두 페이지 읽기를 선택하세요. 이미지 번역을 사용하려면 NodeLane 계정에 로그인하세요. 언제든 원본으로 돌아갈 수 있습니다. 내장 멀티탭 브라우저에서도 웹사이트를 읽을 수 있습니다.'],
    ],
    screenshots: '공통 앱 화면 예시: iOS 시뮬레이터의 중국어 화면입니다. Android 화면은 다를 수 있습니다. 만화 내용과 표지의 권리는 각 권리자에게 있습니다.',
  },
  fr: {
    downloads: "Télécharger les extensions et applications", extensions: 'Extensions de navigateur', apps: 'Applications autonomes', firefoxAndroid: 'Firefox pour Android',
    store: 'Ouvrir la boutique', available: 'Disponible · APK', iosStatus: 'Adaptation IPA en cours', iosNotice: 'L’application iOS est en cours d’adaptation au format IPA. Elle n’est pas encore publiée et aucun fichier d’installation n’est disponible. Utilisez pour le moment l’application Android, l’extension ou la traduction d’images sur le web.',
    guide: 'Téléchargement et installation', status: 'Voir l’état', androidTitle: 'Application Android : télécharger, installer et lire', description: 'Emportez votre bibliothèque, vos sources de mangas et votre lecteur avec NodeLane Comics.',
    download: 'Télécharger le dernier APK', requirements: 'Android 7.0 ou ultérieur · Application autonome, sans extension', choose: 'Un seul APK suffit : arm64-v8a pour la plupart des téléphones, armeabi-v7a pour les appareils 32 bits, x86_64 pour les appareils et émulateurs correspondants. En cas de doute, consultez les caractéristiques de votre appareil.', devices: ['Appareils Android 32 bits', 'Appareils ou émulateurs correspondants'],
    install: ['Installer et ouvrir l’application', 'Ouvrez l’APK téléchargé. Si nécessaire, autorisez le navigateur ou le gestionnaire de fichiers utilisé à installer des applications inconnues, puis suivez les instructions du système. Vous pourrez ensuite retirer cette autorisation. Un seul APK adapté à votre appareil suffit.'],
    usage: [
      ['Trouver une source', 'Ouvrez Sources pour parcourir les sources de mangas ou effectuer une recherche sur plusieurs sources. Choisissez une source accessible et ouvrez la fiche d’un titre.'],
      ['Ajouter à la bibliothèque', 'Ajoutez un titre à votre bibliothèque, puis ouvrez-le depuis celle-ci pour reprendre votre lecture.'],
      ['Lire et traduire des images', 'Ouvrez un chapitre et choisissez le défilement, une page ou deux pages. Connectez-vous à NodeLane pour traduire les images ; vous pouvez revenir à l’original à tout moment. Le navigateur intégré à plusieurs onglets permet aussi de lire des sites web.'],
    ],
    screenshots: 'Aperçu de l’interface commune : captures en chinois provenant d’un simulateur iOS. L’interface Android peut différer. Les mangas et couvertures appartiennent à leurs ayants droit.',
  },
  es: {
    downloads: "Descargar extensiones y apps", extensions: 'Extensiones de navegador', apps: 'Apps independientes', firefoxAndroid: 'Firefox para Android',
    store: 'Abrir tienda', available: 'Disponible · APK', iosStatus: 'Adaptación a IPA en curso', iosNotice: 'La app de iOS se está adaptando al formato IPA. Aún no se ha publicado ni hay un instalador disponible. Por ahora puedes usar la app de Android, la extensión o la traducción de imágenes en la web.',
    guide: 'Descarga e instalación', status: 'Ver estado', androidTitle: 'App de Android: descarga, instala y empieza a leer', description: 'Lleva tu biblioteca, fuentes de manga y lector contigo con NodeLane Comics.',
    download: 'Descargar el último APK', requirements: 'Android 7.0 o posterior · App independiente, sin extensión', choose: 'Instala un solo APK: arm64-v8a para la mayoría de móviles, armeabi-v7a para dispositivos de 32 bits o x86_64 para dispositivos y emuladores correspondientes. En caso de duda, consulta las especificaciones.', devices: ['Dispositivos Android de 32 bits', 'Dispositivos o emuladores compatibles'],
    install: ['Instala y abre la app', 'Abre el APK descargado. Si el sistema lo solicita, permite que el navegador o gestor de archivos usado instale apps desconocidas y sigue las instrucciones. Después puedes desactivar ese permiso. Solo necesitas un APK adecuado para tu dispositivo.'],
    usage: [
      ['Busca una fuente de manga', 'Abre Fuentes para explorar fuentes o buscar en varias a la vez. Elige una fuente accesible y abre los detalles de una obra.'],
      ['Guarda en tu biblioteca', 'Añade una obra a tu biblioteca y ábrela desde allí para continuar donde la dejaste.'],
      ['Lee y traduce imágenes', 'Abre un capítulo y elige desplazamiento, una página o dos páginas. Inicia sesión en NodeLane para traducir imágenes; puedes volver al original. También puedes leer sitios web con el navegador integrado de varias pestañas.'],
    ],
    screenshots: 'Vista de la interfaz compartida: capturas en chino de un simulador de iOS. Android puede verse diferente. El contenido y las portadas pertenecen a sus respectivos titulares.',
  },
  'pt-BR': {
    downloads: "Baixar extensões e apps", extensions: 'Extensões de navegador', apps: 'Apps independentes', firefoxAndroid: 'Firefox para Android',
    store: 'Abrir loja', available: 'Disponível · APK', iosStatus: 'Adaptação para IPA em andamento', iosNotice: 'O app para iOS está sendo adaptado ao formato IPA. Ainda não foi lançado publicamente e não há instalador disponível. Por enquanto, use o app Android, a extensão ou a tradução de imagens na web.',
    guide: 'Download e instalação', status: 'Ver status', androidTitle: 'App Android: baixe, instale e comece a ler', description: 'Leve sua biblioteca, fontes de mangás e leitor no bolso com o NodeLane Comics.',
    download: 'Baixar o APK mais recente', requirements: 'Android 7.0 ou superior · App independente, sem extensão', choose: 'Instale apenas um APK: arm64-v8a para a maioria dos celulares, armeabi-v7a para dispositivos de 32 bits ou x86_64 para dispositivos e emuladores correspondentes. Em caso de dúvida, consulte as especificações.', devices: ['Dispositivos Android de 32 bits', 'Dispositivos ou emuladores correspondentes'],
    install: ['Instale e abra o app', 'Abra o APK baixado. Se solicitado, permita que o navegador ou gerenciador de arquivos usado instale apps desconhecidos e siga as instruções do sistema. Depois, você pode desativar essa permissão. Instale apenas um APK compatível com seu dispositivo.'],
    usage: [
      ['Encontre uma fonte de mangás', 'Abra Fontes para explorar ou pesquisar em várias fontes. Escolha uma fonte acessível e abra os detalhes de uma obra.'],
      ['Salve na biblioteca', 'Adicione uma obra à biblioteca e abra-a por lá para continuar de onde parou.'],
      ['Leia e traduza imagens', 'Abra um capítulo e escolha rolagem, página única ou página dupla. Entre na conta NodeLane para traduzir imagens; você pode voltar ao original. Também é possível ler sites no navegador integrado com várias abas.'],
    ],
    screenshots: 'Prévia da interface compartilhada: capturas em chinês de um simulador iOS. A interface Android pode ser diferente. Mangás e capas pertencem aos respectivos titulares.',
  },
  de: {
    downloads: "Erweiterungen und Apps herunterladen", extensions: 'Browser-Erweiterungen', apps: 'Eigenständige Apps', firefoxAndroid: 'Firefox für Android',
    store: 'Zum Store', available: 'Verfügbar · APK', iosStatus: 'IPA-Anpassung läuft', iosNotice: 'Die iOS-App wird derzeit für IPA-Pakete angepasst. Sie wurde noch nicht öffentlich veröffentlicht; eine Installationsdatei ist nicht verfügbar. Nutze vorerst die Android-App, die Browser-Erweiterung oder die Bildübersetzung im Web.',
    guide: 'Download und Einrichtung', status: 'Status ansehen', androidTitle: 'Android-App: herunterladen, installieren und lesen', description: 'Bibliothek, Manga-Quellen und Reader für unterwegs – mit NodeLane Comics.',
    download: 'Aktuelle APK herunterladen', requirements: 'Android 7.0 oder neuer · Eigenständige App ohne Erweiterung', choose: 'Installiere nur eine APK: arm64-v8a für die meisten Smartphones, armeabi-v7a für 32-Bit-Geräte oder x86_64 für passende Geräte und Emulatoren. Prüfe bei Unsicherheit die technischen Daten.', devices: ['Android-Geräte mit 32 Bit', 'Passende Geräte oder Emulatoren'],
    install: ['App installieren und öffnen', 'Öffne die heruntergeladene APK. Erlaube bei Aufforderung dem verwendeten Browser oder Dateimanager, unbekannte Apps zu installieren, und folge den Systemhinweisen. Die Berechtigung kannst du danach ausschalten. Installiere nur eine APK für die Architektur deines Geräts.'],
    usage: [
      ['Manga-Quelle finden', 'Öffne Quellen, um Anbieter zu durchsuchen oder über mehrere Quellen hinweg zu suchen. Wähle eine erreichbare Quelle und öffne die Details eines Titels.'],
      ['In der Bibliothek speichern', 'Füge einen Titel deiner Bibliothek hinzu. Öffne ihn dort, um an deiner letzten Leseposition fortzufahren.'],
      ['Lesen und Bilder übersetzen', 'Öffne ein Kapitel und wähle Scrollen, Einzel- oder Doppelseiten. Melde dich für die Bildübersetzung bei NodeLane an; du kannst jederzeit zum Original wechseln. Im integrierten Browser mit mehreren Tabs kannst du auch Websites lesen.'],
    ],
    screenshots: 'Beispiel der gemeinsamen App-Oberfläche: chinesische Screenshots aus einem iOS-Simulator. Android kann anders aussehen. Manga-Inhalte und Cover gehören den jeweiligen Rechteinhabern.',
  },
  it: {
    downloads: "Scarica estensioni e app", extensions: 'Estensioni del browser', apps: 'App indipendenti', firefoxAndroid: 'Firefox per Android',
    store: 'Apri lo store', available: 'Disponibile · APK', iosStatus: 'Adattamento IPA in corso', iosNotice: 'L’app iOS è in fase di adattamento al formato IPA. Non è ancora stata pubblicata e non è disponibile alcun file di installazione. Per ora usa l’app Android, l’estensione o la traduzione di immagini sul web.',
    guide: 'Download e installazione', status: 'Visualizza stato', androidTitle: 'App Android: scarica, installa e inizia a leggere', description: 'Porta con te libreria, fonti di manga e lettore con NodeLane Comics.',
    download: 'Scarica l’ultimo APK', requirements: 'Android 7.0 o successivo · App indipendente, senza estensione', choose: 'Installa un solo APK: arm64-v8a per la maggior parte dei telefoni, armeabi-v7a per dispositivi a 32 bit o x86_64 per dispositivi ed emulatori corrispondenti. In caso di dubbi, controlla le specifiche.', devices: ['Dispositivi Android a 32 bit', 'Dispositivi o emulatori corrispondenti'],
    install: ['Installa e apri l’app', 'Apri l’APK scaricato. Se richiesto, autorizza il browser o il gestore file utilizzato a installare app sconosciute, poi segui le istruzioni del sistema. Puoi revocare il permesso al termine. Installa solo un APK adatto al dispositivo.'],
    usage: [
      ['Trova una fonte di manga', 'Apri Fonti per esplorare le fonti o cercare su più fonti. Scegli una fonte accessibile e apri i dettagli di un’opera.'],
      ['Salva nella libreria', 'Aggiungi un titolo alla libreria e aprilo da lì per riprendere dall’ultima posizione di lettura.'],
      ['Leggi e traduci le immagini', 'Apri un capitolo e scegli scorrimento, pagina singola o doppia. Accedi a NodeLane per tradurre le immagini; puoi tornare all’originale. Puoi leggere siti web anche nel browser integrato a più schede.'],
    ],
    screenshots: 'Anteprima dell’interfaccia condivisa: schermate in cinese da un simulatore iOS. Android potrebbe avere un aspetto diverso. Manga e copertine appartengono ai rispettivi titolari.',
  },
  ru: {
    downloads: "Скачать расширения и приложения", extensions: 'Расширения для браузера', apps: 'Отдельные приложения', firefoxAndroid: 'Firefox для Android',
    store: 'Открыть магазин', available: 'Доступно · APK', iosStatus: 'Идёт адаптация IPA-пакета', iosNotice: 'Приложение для iOS адаптируется для выпуска в формате IPA. Оно ещё не опубликовано, установочного файла нет. Пока используйте Android-приложение, расширение или перевод изображений на сайте.',
    guide: 'Скачать и установить', status: 'Посмотреть статус', androidTitle: 'Приложение Android: скачивание, установка и чтение', description: 'Библиотека, источники манги и читалка всегда под рукой с NodeLane Comics.',
    download: 'Скачать последнюю APK', requirements: 'Android 7.0 и новее · Отдельное приложение без расширения', choose: 'Нужен один APK: arm64-v8a для большинства телефонов, armeabi-v7a для 32-битных устройств или x86_64 для соответствующих устройств и эмуляторов. Если сомневаетесь, проверьте характеристики.', devices: ['32-битные устройства Android', 'Соответствующие устройства или эмуляторы'],
    install: ['Установите и откройте приложение', 'Откройте скачанный APK. При запросе разрешите используемому браузеру или файловому менеджеру устанавливать неизвестные приложения и следуйте указаниям системы. После установки разрешение можно отключить. Нужен только один APK для архитектуры вашего устройства.'],
    usage: [
      ['Найдите источник манги', 'Откройте раздел источников, просмотрите каталог или выполните поиск по нескольким источникам. Выберите доступный источник и откройте страницу произведения.'],
      ['Добавьте в библиотеку', 'Добавьте произведение в библиотеку и открывайте его оттуда, чтобы продолжить с последнего места чтения.'],
      ['Читайте и переводите изображения', 'Откройте главу и выберите прокрутку, одну или две страницы. Для перевода изображений войдите в аккаунт NodeLane; можно вернуться к оригиналу. Сайты также доступны во встроенном браузере с несколькими вкладками.'],
    ],
    screenshots: 'Пример общего интерфейса: скриншоты на китайском языке из симулятора iOS. Интерфейс Android может отличаться. Права на мангу и обложки принадлежат их владельцам.',
  },
  pl: {
    downloads: "Pobierz rozszerzenia i aplikacje", extensions: 'Rozszerzenia przeglądarki', apps: 'Samodzielne aplikacje', firefoxAndroid: 'Firefox na Androida',
    store: 'Otwórz sklep', available: 'Dostępne · APK', iosStatus: 'Trwa dostosowanie pakietu IPA', iosNotice: 'Aplikacja iOS jest dostosowywana do formatu IPA. Nie została jeszcze publicznie wydana i nie ma pliku instalacyjnego. Na razie skorzystaj z aplikacji Android, rozszerzenia lub tłumaczenia obrazów w witrynie.',
    guide: 'Pobieranie i instalacja', status: 'Sprawdź status', androidTitle: 'Aplikacja Android: pobierz, zainstaluj i czytaj', description: 'Biblioteka, źródła mangi i czytnik zawsze pod ręką dzięki NodeLane Comics.',
    download: 'Pobierz najnowszy APK', requirements: 'Android 7.0 lub nowszy · Samodzielna aplikacja bez rozszerzenia', choose: 'Zainstaluj jeden APK: arm64-v8a dla większości telefonów, armeabi-v7a dla urządzeń 32-bitowych lub x86_64 dla odpowiednich urządzeń i emulatorów. W razie wątpliwości sprawdź specyfikację.', devices: ['32-bitowe urządzenia Android', 'Odpowiednie urządzenia lub emulatory'],
    install: ['Zainstaluj i otwórz aplikację', 'Otwórz pobrany APK. Jeśli pojawi się prośba, zezwól użytej przeglądarce lub menedżerowi plików na instalację nieznanych aplikacji i postępuj zgodnie z instrukcjami systemu. Potem możesz wyłączyć to uprawnienie. Zainstaluj tylko jeden APK zgodny z urządzeniem.'],
    usage: [
      ['Znajdź źródło mangi', 'Otwórz Źródła, aby je przeglądać lub przeszukiwać kilka naraz. Wybierz dostępne źródło i otwórz szczegóły tytułu.'],
      ['Zapisz w bibliotece', 'Dodaj tytuł do biblioteki, a następnie otwórz go stamtąd, aby kontynuować od ostatniego miejsca.'],
      ['Czytaj i tłumacz obrazy', 'Otwórz rozdział i wybierz przewijanie, jedną lub dwie strony. Zaloguj się do NodeLane, aby tłumaczyć obrazy; możesz wrócić do oryginału. Możesz też czytać witryny we wbudowanej przeglądarce z wieloma kartami.'],
    ],
    screenshots: 'Podgląd wspólnego interfejsu: zrzuty w języku chińskim z symulatora iOS. Android może wyglądać inaczej. Treść mangi i okładki należą do odpowiednich właścicieli praw.',
  },
  uk: {
    downloads: "Завантажити розширення та застосунки", extensions: 'Розширення браузера', apps: 'Окремі застосунки', firefoxAndroid: 'Firefox для Android',
    store: 'Відкрити магазин', available: 'Доступно · APK', iosStatus: 'Триває адаптація IPA-пакета', iosNotice: 'Застосунок iOS адаптується для пакування у форматі IPA. Його ще не опубліковано, інсталяційного файлу немає. Поки використовуйте застосунок Android, розширення або переклад зображень на сайті.',
    guide: 'Завантаження та встановлення', status: 'Переглянути стан', androidTitle: 'Застосунок Android: завантаження, встановлення та читання', description: 'Бібліотека, джерела манґи й читалка завжди поруч із NodeLane Comics.',
    download: 'Завантажити останній APK', requirements: 'Android 7.0 або новіший · Окремий застосунок без розширення', choose: 'Потрібен один APK: arm64-v8a для більшості телефонів, armeabi-v7a для 32-бітних пристроїв або x86_64 для відповідних пристроїв та емуляторів. Якщо сумніваєтесь, перевірте характеристики.', devices: ['32-бітні пристрої Android', 'Відповідні пристрої або емулятори'],
    install: ['Установіть і відкрийте застосунок', 'Відкрийте завантажений APK. За запитом дозвольте використаному браузеру або файловому менеджеру встановлювати невідомі застосунки й дотримуйтеся вказівок системи. Потім цей дозвіл можна вимкнути. Установіть лише один APK для архітектури вашого пристрою.'],
    usage: [
      ['Знайдіть джерело манґи', 'Відкрийте Джерела, щоб переглядати їх або шукати в кількох одночасно. Виберіть доступне джерело та відкрийте сторінку твору.'],
      ['Збережіть у бібліотеці', 'Додайте твір до бібліотеки й відкривайте його звідти, щоб продовжити з останнього місця читання.'],
      ['Читайте й перекладайте зображення', 'Відкрийте розділ і виберіть прокручування, одну або дві сторінки. Увійдіть у NodeLane для перекладу зображень; можна повернутися до оригіналу. Також можна читати сайти у вбудованому браузері з кількома вкладками.'],
    ],
    screenshots: 'Приклад спільного інтерфейсу: знімки китайською мовою із симулятора iOS. Android може виглядати інакше. Манґа й обкладинки належать відповідним правовласникам.',
  },
  tr: {
    downloads: "Eklentileri ve uygulamaları indirin", extensions: 'Tarayıcı eklentileri', apps: 'Bağımsız uygulamalar', firefoxAndroid: 'Android için Firefox',
    store: 'Mağazayı aç', available: 'Yayımlandı · APK', iosStatus: 'IPA uyarlaması sürüyor', iosNotice: 'iOS uygulaması IPA paketine uyarlanıyor. Henüz herkese açık olarak yayımlanmadı ve kurulum dosyası sunulmuyor. Şimdilik Android uygulamasını, tarayıcı eklentisini veya web görsel çevirisini kullanabilirsiniz.',
    guide: 'İndirme ve kurulum', status: 'Durumu gör', androidTitle: 'Android uygulaması: indirin, kurun ve okumaya başlayın', description: 'NodeLane Comics ile kitaplığınız, manga kaynaklarınız ve okuyucunuz cebinizde.',
    download: 'En güncel APK’yı indir', requirements: 'Android 7.0 veya üzeri · Eklenti gerektirmeyen bağımsız uygulama', choose: 'Tek bir APK kurun: çoğu telefon için arm64-v8a, 32 bit cihazlar için armeabi-v7a, uygun cihaz ve emülatörler için x86_64. Emin değilseniz cihaz özelliklerini kontrol edin.', devices: ['32 bit Android cihazlar', 'Uygun cihazlar veya emülatörler'],
    install: ['Uygulamayı kurun ve açın', 'İndirdiğiniz APK’yı açın. İstenirse kullandığınız tarayıcıya veya dosya yöneticisine bilinmeyen uygulamaları yükleme izni verip sistem yönergelerini izleyin. Sonrasında bu izni kapatabilirsiniz. Cihazınıza uygun tek bir APK kurmanız yeterlidir.'],
    usage: [
      ['Manga kaynağı bulun', 'Kaynaklar bölümünde gezinin veya kaynaklar arasında arama yapın. Erişilebilir bir kaynak seçip eserin ayrıntılarını açın.'],
      ['Kitaplığa kaydedin', 'Bir eseri kitaplığınıza ekleyin. Kitaplıktan açarak kaldığınız yerden okumaya devam edin.'],
      ['Okuyun ve görselleri çevirin', 'Bir bölüm açıp kaydırma, tek sayfa veya çift sayfa okumayı seçin. Görsel çevirisi için NodeLane hesabınıza giriş yapın; aslına geri dönebilirsiniz. Yerleşik çok sekmeli tarayıcıda web sitelerini de okuyabilirsiniz.'],
    ],
    screenshots: 'Ortak uygulama arayüzü örneği: Çince ekran görüntüleri iOS simülatöründendir. Android arayüzü farklı olabilir. Manga içerikleri ve kapaklar ilgili hak sahiplerine aittir.',
  },
  vi: {
    downloads: "Tải tiện ích và ứng dụng", extensions: 'Tiện ích trình duyệt', apps: 'Ứng dụng độc lập', firefoxAndroid: 'Firefox cho Android',
    store: 'Mở cửa hàng', available: 'Đã phát hành · APK', iosStatus: 'Đang điều chỉnh gói IPA', iosNotice: 'Ứng dụng iOS đang được điều chỉnh cho gói IPA, chưa phát hành công khai và chưa có tệp cài đặt. Hiện bạn có thể dùng ứng dụng Android, tiện ích trình duyệt hoặc dịch ảnh trên web.',
    guide: 'Tải xuống và cài đặt', status: 'Xem trạng thái', androidTitle: 'Ứng dụng Android: tải, cài đặt và bắt đầu đọc', description: 'Mang theo thư viện, nguồn truyện và trình đọc với NodeLane Comics.',
    download: 'Tải APK mới nhất', requirements: 'Android 7.0 trở lên · Ứng dụng độc lập, không cần tiện ích', choose: 'Chỉ cài một APK: arm64-v8a cho hầu hết điện thoại, armeabi-v7a cho thiết bị 32 bit, x86_64 cho thiết bị hoặc trình giả lập tương ứng. Nếu chưa rõ, hãy xem thông số thiết bị.', devices: ['Thiết bị Android 32 bit', 'Thiết bị hoặc trình giả lập tương ứng'],
    install: ['Cài đặt và mở ứng dụng', 'Mở APK đã tải. Nếu được yêu cầu, cho phép trình duyệt hoặc trình quản lý tệp đã dùng cài ứng dụng không rõ nguồn gốc, rồi làm theo hướng dẫn hệ thống. Bạn có thể tắt quyền này sau khi cài. Mỗi thiết bị chỉ cần một APK đúng kiến trúc.'],
    usage: [
      ['Tìm nguồn truyện', 'Mở Nguồn để duyệt hoặc tìm trên nhiều nguồn. Chọn nguồn truy cập được rồi mở chi tiết truyện.'],
      ['Lưu vào thư viện', 'Thêm truyện vào thư viện và mở từ đó để đọc tiếp vị trí lần trước.'],
      ['Đọc và dịch ảnh', 'Mở chương và chọn cuộn, một trang hoặc hai trang. Đăng nhập NodeLane để dùng dịch ảnh; bạn có thể chuyển lại ảnh gốc. Bạn cũng có thể đọc trang web trong trình duyệt nhiều thẻ tích hợp.'],
    ],
    screenshots: 'Minh họa giao diện chung: ảnh giao diện tiếng Trung từ trình giả lập iOS. Android có thể khác đôi chút. Nội dung truyện và bìa thuộc các chủ sở hữu quyền tương ứng.',
  },
  id: {
    downloads: "Unduh ekstensi dan aplikasi", extensions: 'Ekstensi browser', apps: 'Aplikasi mandiri', firefoxAndroid: 'Firefox untuk Android',
    store: 'Buka toko', available: 'Tersedia · APK', iosStatus: 'Adaptasi paket IPA berlangsung', iosNotice: 'Aplikasi iOS sedang disesuaikan untuk paket IPA. Belum dirilis untuk umum dan belum ada berkas instalasi. Untuk saat ini, gunakan aplikasi Android, ekstensi browser, atau penerjemahan gambar di web.',
    guide: 'Unduh dan pasang', status: 'Lihat status', androidTitle: 'Aplikasi Android: unduh, pasang, dan mulai membaca', description: 'Bawa pustaka, sumber komik, dan pembaca ke mana saja dengan NodeLane Comics.',
    download: 'Unduh APK terbaru', requirements: 'Android 7.0 atau lebih baru · Aplikasi mandiri tanpa ekstensi', choose: 'Pasang satu APK saja: arm64-v8a untuk kebanyakan ponsel, armeabi-v7a untuk perangkat 32 bit, atau x86_64 untuk perangkat dan emulator yang sesuai. Periksa spesifikasi jika ragu.', devices: ['Perangkat Android 32 bit', 'Perangkat atau emulator yang sesuai'],
    install: ['Pasang dan buka aplikasi', 'Buka APK yang diunduh. Jika diminta, izinkan browser atau pengelola berkas yang digunakan untuk memasang aplikasi tidak dikenal, lalu ikuti petunjuk sistem. Izin ini dapat dimatikan setelahnya. Pasang hanya satu APK yang sesuai dengan arsitektur perangkat.'],
    usage: [
      ['Cari sumber komik', 'Buka Sumber untuk menjelajahi sumber komik atau mencari di beberapa sumber sekaligus. Pilih sumber yang dapat diakses dan buka detail komik.'],
      ['Simpan ke pustaka', 'Tambahkan judul ke pustaka, lalu buka dari sana untuk melanjutkan dari posisi baca terakhir.'],
      ['Baca dan terjemahkan gambar', 'Buka bab dan pilih gulir, satu halaman, atau dua halaman. Masuk ke akun NodeLane untuk menerjemahkan gambar; Anda dapat kembali ke gambar asli. Situs web juga dapat dibaca di browser multitab bawaan.'],
    ],
    screenshots: 'Pratinjau antarmuka bersama: tangkapan layar berbahasa Mandarin dari simulator iOS. Tampilan Android mungkin berbeda. Isi komik dan sampul milik pemegang hak masing-masing.',
  },
  ar: {
    downloads: "تنزيل الإضافات والتطبيقات", extensions: 'إضافات المتصفح', apps: 'تطبيقات مستقلة', firefoxAndroid: 'Firefox على Android',
    store: 'فتح المتجر', available: 'متاح · APK', iosStatus: 'جارٍ تكييف حزمة IPA', iosNotice: 'يجري تكييف تطبيق iOS لحزمة IPA. لم يُطرح للعامة بعد ولا يتوفر ملف تثبيت. يمكنك حاليًا استخدام تطبيق Android أو إضافة المتصفح أو ترجمة الصور على الويب.',
    guide: 'التنزيل والتثبيت', status: 'عرض الحالة', androidTitle: 'تطبيق Android: التنزيل والتثبيت وبدء القراءة', description: 'احمل مكتبتك ومصادر المانغا والقارئ معك باستخدام NodeLane Comics.',
    download: 'تنزيل أحدث APK', requirements: 'Android 7.0 أو أحدث · تطبيق مستقل لا يحتاج إلى إضافة متصفح', choose: 'ثبّت ملف APK واحدًا فقط: arm64-v8a لمعظم الهواتف، أو armeabi-v7a للأجهزة ذات 32 بت، أو x86_64 للأجهزة والمحاكيات المطابقة. راجع مواصفات جهازك عند الشك.', devices: ['أجهزة Android بمعمارية 32 بت', 'الأجهزة أو المحاكيات المطابقة'],
    install: ['تثبيت التطبيق وفتحه', 'افتح ملف APK الذي نزّلته. إذا طُلب منك ذلك، اسمح للمتصفح أو مدير الملفات المستخدم بتثبيت تطبيقات غير معروفة، ثم اتبع تعليمات النظام. يمكنك إيقاف هذا الإذن بعد التثبيت. يحتاج كل جهاز إلى ملف APK واحد يطابق معماريته.'],
    usage: [
      ['البحث عن مصدر للمانغا', 'افتح المصادر لتصفحها أو للبحث في عدة مصادر. اختر مصدرًا متاحًا وافتح تفاصيل العمل.'],
      ['الحفظ في المكتبة', 'أضف العمل إلى مكتبتك، ثم افتحه منها لمتابعة القراءة من موضعك السابق.'],
      ['القراءة وترجمة الصور', 'افتح فصلًا واختر التمرير أو صفحة واحدة أو صفحتين. سجّل الدخول إلى NodeLane لاستخدام ترجمة الصور؛ يمكنك العودة إلى الأصل. ويمكنك قراءة المواقع في المتصفح المدمج متعدد التبويبات.'],
    ],
    screenshots: 'عرض توضيحي للواجهة المشتركة: لقطات باللغة الصينية من محاكي iOS. قد تختلف واجهة Android قليلًا. محتوى المانغا والأغلفة ملك لأصحاب الحقوق المعنيين.',
  },
};

export function appAvailability(locale: Locale) {
  const c = appCopy[locale];
  return `${c.extensions}: Chrome · Edge · Firefox · ${c.firefoxAndroid}. ${c.apps}: Android · ${c.available} / iOS · ${c.iosStatus}.`;
}

export function androidAppGuide(locale: Locale): Guide {
  const c = appCopy[locale];
  return {
    slug: appRelease.androidSlug, title: c.androidTitle, description: c.description,
    category: `Android · ${c.apps}`, minutes: 3, published: '2026-11-08', updated: '2026-11-08',
    related: ['android-firefox', appRelease.iosSlug],
    sections: [
      { title: c.install[0], paragraphs: [c.install[1], c.screenshots] },
      ...c.usage.map(([title, body], index) => ({ title, paragraphs: [body], screenshot: {
        id: `app-${index + 1}`, label: title, caption: title,
        src: `/guides/app/ios-${['sources', 'library', 'reader'][index]}.png`,
      } })),
    ],
  };
}

export function iosAppGuide(locale: Locale): Guide {
  const c = appCopy[locale];
  return {
    slug: appRelease.iosSlug, title: `iOS App · ${c.iosStatus}`, description: c.iosNotice,
    category: c.apps, minutes: 1, published: '2026-10-08', updated: '2026-11-08',
    related: [appRelease.androidSlug, 'android-firefox'],
    sections: [{ title: c.status, paragraphs: [c.iosNotice], links: [
      { label: `Android App · ${c.guide}`, href: `/guides/${appRelease.androidSlug}/` },
      { label: c.extensions, href: '/download/' },
      { label: 'GitHub · NodeLane Comics App', href: appRelease.repository },
    ] }],
  };
}

export const releaseCopy: Record<Locale, { loading: string; error: string; retry: string; notes: string; otherDownloads: string }> = {
  'zh-CN': { loading: '正在获取最新安装包…', error: '暂时无法读取安装包信息，请重试。', retry: '重试', notes: 'GitHub 发布页与说明', otherDownloads: "其他设备下载" },
  'zh-TW': { loading: '正在取得最新安裝套件…', error: '暫時無法讀取安裝套件資訊，請重試。', retry: '重試', notes: 'GitHub 發佈頁與說明', otherDownloads: "其他裝置下載" },
  en: { loading: 'Loading the latest packages…', error: 'Package information is unavailable. Please retry.', retry: 'Retry', notes: 'GitHub release page & notes', otherDownloads: "Downloads for other devices" },
  ja: { loading: '最新パッケージを取得中…', error: 'パッケージ情報を取得できません。再試行してください。', retry: '再試行', notes: 'GitHub リリースページ・更新内容', otherDownloads: "ほかの端末向けダウンロード" },
  ko: { loading: '최신 설치 파일 확인 중…', error: '설치 파일 정보를 불러올 수 없습니다. 다시 시도하세요.', retry: '다시 시도', notes: 'GitHub 릴리스 페이지 및 변경 사항', otherDownloads: "다른 기기용 다운로드" },
  fr: { loading: 'Chargement des derniers fichiers…', error: 'Les informations de téléchargement sont indisponibles. Réessayez.', retry: 'Réessayer', notes: 'Page et notes de version GitHub', otherDownloads: "Téléchargements pour d’autres appareils" },
  es: { loading: 'Cargando los últimos paquetes…', error: 'No se pudo cargar la información de descarga. Reinténtalo.', retry: 'Reintentar', notes: 'Página y notas de versión en GitHub', otherDownloads: "Descargas para otros dispositivos" },
  'pt-BR': { loading: 'Carregando os pacotes mais recentes…', error: 'As informações de download estão indisponíveis. Tente novamente.', retry: 'Tentar novamente', notes: 'Página e notas da versão no GitHub', otherDownloads: "Downloads para outros dispositivos" },
  de: { loading: 'Aktuelle Pakete werden geladen…', error: 'Paketinformationen sind nicht verfügbar. Bitte erneut versuchen.', retry: 'Erneut versuchen', notes: 'GitHub-Release und Versionshinweise', otherDownloads: "Downloads für andere Geräte" },
  it: { loading: 'Caricamento degli ultimi pacchetti…', error: 'Informazioni sui pacchetti non disponibili. Riprova.', retry: 'Riprova', notes: 'Pagina e note di rilascio su GitHub', otherDownloads: "Download per altri dispositivi" },
  ru: { loading: 'Загрузка актуальных пакетов…', error: 'Не удалось получить сведения о пакетах. Повторите попытку.', retry: 'Повторить', notes: 'Страница и описание релиза на GitHub', otherDownloads: "Загрузки для других устройств" },
  pl: { loading: 'Wczytywanie najnowszych pakietów…', error: 'Informacje o pakietach są niedostępne. Spróbuj ponownie.', retry: 'Spróbuj ponownie', notes: 'Strona i opis wydania na GitHubie', otherDownloads: "Pliki dla innych urządzeń" },
  uk: { loading: 'Завантаження актуальних пакетів…', error: 'Не вдалося отримати відомості про пакети. Спробуйте ще раз.', retry: 'Повторити', notes: 'Сторінка й опис випуску на GitHub', otherDownloads: "Завантаження для інших пристроїв" },
  tr: { loading: 'En güncel paketler yükleniyor…', error: 'Paket bilgileri alınamadı. Lütfen yeniden deneyin.', retry: 'Yeniden dene', notes: 'GitHub sürüm sayfası ve notları', otherDownloads: "Diğer cihazlar için indirmeler" },
  vi: { loading: 'Đang tải thông tin gói mới nhất…', error: 'Không thể đọc thông tin gói cài đặt. Vui lòng thử lại.', retry: 'Thử lại', notes: 'Trang phát hành và ghi chú trên GitHub', otherDownloads: "Tải cho thiết bị khác" },
  id: { loading: 'Memuat paket terbaru…', error: 'Informasi paket tidak tersedia. Silakan coba lagi.', retry: 'Coba lagi', notes: 'Halaman dan catatan rilis GitHub', otherDownloads: "Unduhan untuk perangkat lain" },
  ar: { loading: 'جارٍ تحميل أحدث الحزم…', error: 'تعذّر قراءة معلومات الحزم. يُرجى إعادة المحاولة.', retry: 'إعادة المحاولة', notes: 'صفحة الإصدار وملاحظاته على GitHub', otherDownloads: "تنزيلات للأجهزة الأخرى" },
};
