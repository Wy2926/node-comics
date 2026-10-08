import type { Guide, Locale, UI } from './types';
import { mobilePlatforms } from '../data/mobile';
import { site } from '../data/site';
import { translationCopy } from './translate';

interface MobileCopy {
  label: string;
  iosStatus: string;
  screenshotNote: string;
  placeholder: string;
  before: string;
  sources: string;
  availability: string;
  titles: [string, string];
  descriptions: [string, string];
  notices: [string, string];
  // Android: browser, extension, open. iOS remains a status page until supported.
  steps: [string, string][];
  troubleshooting: [string, string];
}

export const mobileCopy: Record<Locale, MobileCopy> = {
  'zh-CN': {
    iosStatus: "适配中", screenshotNote: "模拟器截图：Android 14、Firefox 157.0.1。阅读器为临时加载的 Mozilla 签名版 0.10.3，展示原创样张的英文原图；不代表商店永久安装、账号登录或翻译流程已验证。",
    label: '安装教程', placeholder: '截图待补充', before: '开始之前', sources: '官方参考',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — 适配中",
    titles: ['在 Android 上，用 Firefox 阅读漫画', "iOS / iPadOS · Orion — 适配中"],
    descriptions: ['从安装 Firefox 到打开 NodeLane 漫译，按步骤在 Android 上使用漫画阅读与翻译插件。', "iOS / iPadOS 的 Orion 适配仍在进行，尚未正式支持。请暂用 Android Firefox、桌面浏览器或网页图片翻译。"],
    notices: ['这是浏览器插件教程，无需下载 NodeLane APK。请使用最新版 Firefox 安卓版，商店会检查版本兼容性；Firefox Focus 不适用。', "iOS / iPadOS 的 Orion 适配仍在进行，尚未正式支持。请暂用 Android Firefox、桌面浏览器或网页图片翻译。"],
    steps: [
      ['安装并打开 Firefox', '从 Firefox 官方下载页进入 Android 安装入口。安装后，在 Firefox 中重新打开本教程，后面的商店链接也要在 Firefox 中打开。'],
      ['从官方商店添加插件', '打开下方 NodeLane 漫译的 Firefox 商店页面，点“添加到 Firefox”，阅读权限说明后确认添加。也可从 Firefox 的“⋮ → 扩展”进入扩展管理。'],
      ['打开插件，试读一章', '在 Firefox 的“⋮ → 扩展”中选择 NodeLane 漫译，打开书架或阅读器。先导入一个小文件，或在已适配的网站打开漫画并按插件提示添加；需要翻译时再配置渠道。'],
    ],
    troubleshooting: ['没有安装按钮时，确认链接在 Firefox 中打开并更新浏览器；若商店提示不兼容，不要强行安装。已安装却无反应时，检查扩展是否启用、网站权限是否允许，并刷新漫画页。先用普通标签页测试；隐私浏览需要另行允许扩展运行。', "iOS / iPadOS 的 Orion 适配仍在进行，尚未正式支持。请暂用 Android Firefox、桌面浏览器或网页图片翻译。"],
  },
  'zh-TW': {
    iosStatus: "適配中", screenshotNote: "模擬器截圖：Android 14、Firefox 157.0.1。閱讀器為暫時載入的 Mozilla 簽署版 0.10.3，展示原創樣張的英文原圖；不代表商店永久安裝、帳號登入或翻譯流程已驗證。",
    label: '安裝教學', placeholder: '截圖待補充', before: '開始之前', sources: '官方參考',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — 適配中",
    titles: ['在 Android 上，用 Firefox 閱讀漫畫', "iOS / iPadOS · Orion — 適配中"],
    descriptions: ['從安裝 Firefox 到開啟 NodeLane 漫譯，逐步在 Android 上使用漫畫閱讀與翻譯擴充功能。', "iOS / iPadOS 的 Orion 適配仍在進行，尚未正式支援。請暫用 Android Firefox、桌面瀏覽器或網頁圖片翻譯。"],
    notices: ['這是瀏覽器擴充功能教學，不需下載 NodeLane APK。請使用最新版 Firefox Android，商店會檢查版本相容性；不適用 Firefox Focus。', "iOS / iPadOS 的 Orion 適配仍在進行，尚未正式支援。請暫用 Android Firefox、桌面瀏覽器或網頁圖片翻譯。"],
    steps: [
      ['安裝並開啟 Firefox', '從 Firefox 官方下載頁進入 Android 安裝入口。安裝後在 Firefox 重新開啟本教學，後續商店連結也須在 Firefox 開啟。'],
      ['從官方商店新增擴充功能', '開啟下方 NodeLane 漫譯的 Firefox 商店頁，選擇「新增至 Firefox」，閱讀權限後確認。也可從「⋮ → 擴充功能」進入管理頁。'],
      ['開啟擴充功能，試讀一章', '在 Firefox「⋮ → 擴充功能」選擇 NodeLane 漫譯並開啟書架。先匯入小檔案，或在支援網站依提示新增漫畫；需要翻譯時再設定管道。'],
    ],
    troubleshooting: ['沒有安裝按鈕時，確認使用 Firefox 並更新瀏覽器；商店提示不相容時不要強行安裝。無反應時檢查啟用狀態及網站權限，再重新整理。先用一般分頁測試，隱私瀏覽須另行允許擴充功能。', "iOS / iPadOS 的 Orion 適配仍在進行，尚未正式支援。請暫用 Android Firefox、桌面瀏覽器或網頁圖片翻譯。"],
  },
  en: {
    iosStatus: "Compatibility in progress", screenshotNote: "Emulator captures: Android 14, Firefox 157.0.1. The reader uses temporarily loaded, Mozilla-signed 0.10.3 and an original English sample; permanent store installation, sign-in and translation were not verified by these captures.",
    label: 'Setup guide', placeholder: 'Screenshot coming soon', before: 'Before you start', sources: 'Official references',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Compatibility in progress",
    titles: ['Read comics on Android with Firefox', "iOS / iPadOS · Orion — Compatibility in progress"],
    descriptions: ['Install Firefox, add NodeLane Comics and open your reader on Android. A step-by-step mobile extension guide.', "Orion compatibility on iOS / iPadOS is in progress, not officially supported yet. Please use Android Firefox, a desktop browser or web image translation for now."],
    notices: ['This is a browser extension guide, not a NodeLane APK. Use up-to-date Firefox for Android; the store checks version compatibility. Firefox Focus is not supported by this guide.', "Orion compatibility on iOS / iPadOS is in progress, not officially supported yet. Please use Android Firefox, a desktop browser or web image translation for now."],
    steps: [
      ['Install and open Firefox', 'Follow the Android download on the official Firefox page. Then reopen this guide in Firefox and keep using Firefox for the store link below.'],
      ['Add the extension from the official store', 'Open the NodeLane Comics Firefox listing below. Choose Add to Firefox, review the requested permissions and confirm. The ⋮ → Extensions menu also opens extension management.'],
      ['Open the reader and try a chapter', 'Choose NodeLane Comics from Firefox’s ⋮ → Extensions menu to open the library or reader. Try a small local file or add a comic from a supported site using the extension’s prompts. Configure translation when you need it.'],
    ],
    troubleshooting: ['No install button? Open the link in Firefox and update the browser. Do not force an install if the store reports incompatibility. If nothing happens, check the extension is enabled and site access is allowed, then reload. Test in a regular tab first; private browsing needs separate permission.', "Orion compatibility on iOS / iPadOS is in progress, not officially supported yet. Please use Android Firefox, a desktop browser or web image translation for now."],
  },
  ja: {
    iosStatus: "対応作業中", screenshotNote: "Android 14・Firefox 157.0.1 のエミュレーター画面です。リーダーは Mozilla 署名済み 0.10.3 の一時読み込みで、オリジナル作品の英語原画を表示しています。ストアからの永続インストール、ログイン、翻訳の検証を示すものではありません。",
    label: '導入ガイド', placeholder: 'スクリーンショット準備中', before: '始める前に', sources: '公式資料',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — 対応作業中",
    titles: ['Android の Firefox で漫画を読む', "iOS / iPadOS · Orion — 対応作業中"],
    descriptions: ['Firefox のインストールから NodeLane Comics の追加、リーダーの起動まで、Android での手順を紹介します。', "iOS / iPadOS の Orion は対応作業中で、正式対応ではありません。当面は Android の Firefox、デスクトップブラウザー、または Web 画像翻訳をご利用ください。"],
    notices: ['NodeLane APK ではなくブラウザー拡張機能のガイドです。最新の Android 版 Firefox を使用してください。対応バージョンはストアで確認されます。Firefox Focus は対象外です。', "iOS / iPadOS の Orion は対応作業中で、正式対応ではありません。当面は Android の Firefox、デスクトップブラウザー、または Web 画像翻訳をご利用ください。"],
    steps: [
      ['Firefox をインストール', 'Firefox 公式ページの Android ダウンロードから導入し、このガイドを Firefox で開き直します。以下のストアも Firefox で開いてください。'],
      ['公式ストアで拡張機能を追加', '下の NodeLane Comics の Firefox ストアを開き、「Firefox へ追加」を選択。権限を確認して追加します。「⋮ → 拡張機能」でも管理できます。'],
      ['リーダーを開いて試す', 'Firefox の「⋮ → 拡張機能」で NodeLane Comics を選択。小さなファイル、または対応サイトの漫画を案内に従って追加し、必要な場合に翻訳を設定します。'],
    ],
    troubleshooting: ['追加ボタンがない場合は Firefox で開き、更新してください。非対応表示が出たら無理に導入しないでください。無反応なら有効状態とサイト権限を確認し再読み込みします。まず通常タブで試し、プライベート閲覧は別途許可してください。', "iOS / iPadOS の Orion は対応作業中で、正式対応ではありません。当面は Android の Firefox、デスクトップブラウザー、または Web 画像翻訳をご利用ください。"],
  },
  ko: {
    iosStatus: "호환성 작업 중", screenshotNote: "Android 14, Firefox 157.0.1 에뮬레이터 화면입니다. 리더는 Mozilla 서명 0.10.3을 임시 로드하여 자체 제작 영어 원본을 표시합니다. 스토어 영구 설치, 로그인 및 번역 검증을 의미하지 않습니다.",
    label: '설치 안내', placeholder: '스크린샷 준비 중', before: '시작하기 전에', sources: '공식 자료',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — 호환성 작업 중",
    titles: ['Android의 Firefox에서 만화 읽기', "iOS / iPadOS · Orion — 호환성 작업 중"],
    descriptions: ['Firefox 설치부터 NodeLane Comics 추가와 리더 실행까지 Android용 확장 프로그램 설정을 안내합니다.', "iOS / iPadOS의 Orion 호환성 작업이 진행 중이며 아직 정식 지원하지 않습니다. 당분간 Android Firefox, 데스크톱 브라우저 또는 웹 이미지 번역을 이용하세요."],
    notices: ['NodeLane APK가 아닌 브라우저 확장 프로그램 안내입니다. 최신 Android용 Firefox를 사용하세요. 스토어가 버전 호환성을 확인합니다. Firefox Focus는 대상이 아닙니다.', "iOS / iPadOS의 Orion 호환성 작업이 진행 중이며 아직 정식 지원하지 않습니다. 당분간 Android Firefox, 데스크톱 브라우저 또는 웹 이미지 번역을 이용하세요."],
    steps: [
      ['Firefox 설치 및 실행', 'Firefox 공식 페이지에서 Android 다운로드로 이동하세요. 설치 후 이 안내와 아래 스토어 링크를 Firefox에서 여세요.'],
      ['공식 스토어에서 확장 추가', '아래 NodeLane Comics Firefox 스토어에서 Firefox에 추가를 누르고 권한을 확인하세요. ⋮ → 확장 프로그램에서도 관리할 수 있습니다.'],
      ['리더를 열고 시험해 보기', 'Firefox의 ⋮ → 확장 프로그램에서 NodeLane Comics를 선택하세요. 작은 파일을 가져오거나 지원 사이트의 만화를 안내에 따라 추가하세요. 번역은 필요할 때 설정합니다.'],
    ],
    troubleshooting: ['설치 버튼이 없으면 Firefox에서 열었는지 확인하고 업데이트하세요. 호환되지 않는다는 안내가 있으면 강제 설치하지 마세요. 반응이 없으면 활성화와 사이트 권한을 확인하고 새로고침하세요. 먼저 일반 탭에서 테스트하세요. 비공개 탐색은 별도 허용이 필요합니다.', "iOS / iPadOS의 Orion 호환성 작업이 진행 중이며 아직 정식 지원하지 않습니다. 당분간 Android Firefox, 데스크톱 브라우저 또는 웹 이미지 번역을 이용하세요."],
  },
  fr: {
    iosStatus: "Compatibilité en cours", screenshotNote: "Captures sur émulateur Android 14, Firefox 157.0.1. Le lecteur utilise la version 0.10.3 signée par Mozilla, chargée temporairement, et un exemple original en anglais. Installation permanente, connexion et traduction non vérifiées par ces captures.",
    label: 'Guide d’installation', placeholder: 'Capture à venir', before: 'Avant de commencer', sources: 'Références officielles',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Compatibilité en cours",
    titles: ['Lire des mangas sur Android avec Firefox', "iOS / iPadOS · Orion — Compatibilité en cours"],
    descriptions: ['Installez Firefox, ajoutez NodeLane Comics et ouvrez le lecteur sur Android, étape par étape.', "La compatibilité Orion sur iOS / iPadOS est en cours, sans prise en charge officielle. Utilisez pour le moment Firefox Android, un navigateur de bureau ou la traduction web."],
    notices: ['Ce guide concerne une extension, pas un APK NodeLane. Utilisez Firefox pour Android à jour ; la boutique vérifie la compatibilité. Firefox Focus ne convient pas.', "La compatibilité Orion sur iOS / iPadOS est en cours, sans prise en charge officielle. Utilisez pour le moment Firefox Android, un navigateur de bureau ou la traduction web."],
    steps: [
      ['Installer et ouvrir Firefox', 'Passez par le téléchargement Android du site officiel de Firefox. Rouvrez ensuite ce guide et le lien de la boutique dans Firefox.'],
      ['Ajouter l’extension officielle', 'Ouvrez la fiche Firefox de NodeLane Comics ci-dessous. Choisissez Ajouter à Firefox, lisez les permissions et confirmez. Le menu ⋮ → Extensions permet aussi de les gérer.'],
      ['Ouvrir le lecteur et essayer', 'Sélectionnez NodeLane Comics dans ⋮ → Extensions de Firefox. Importez un petit fichier ou ajoutez un manga d’un site compatible en suivant les indications. Configurez la traduction au besoin.'],
    ],
    troubleshooting: ['Bouton absent ? Ouvrez le lien dans Firefox et mettez-le à jour. Ne forcez pas une installation déclarée incompatible. Vérifiez l’activation et les permissions du site, puis rechargez. Essayez un onglet normal ; le mode privé exige une autorisation distincte.', "La compatibilité Orion sur iOS / iPadOS est en cours, sans prise en charge officielle. Utilisez pour le moment Firefox Android, un navigateur de bureau ou la traduction web."],
  },
  es: {
    iosStatus: "Compatibilidad en desarrollo", screenshotNote: "Capturas de emulador Android 14, Firefox 157.0.1. El lector usa la versión 0.10.3 firmada por Mozilla, cargada temporalmente, y una muestra original en inglés. No verifican la instalación permanente, el inicio de sesión ni la traducción.",
    label: 'Guía de instalación', placeholder: 'Captura pendiente', before: 'Antes de empezar', sources: 'Referencias oficiales',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Compatibilidad en desarrollo",
    titles: ['Lee manga en Android con Firefox', "iOS / iPadOS · Orion — Compatibilidad en desarrollo"],
    descriptions: ['Instala Firefox, añade NodeLane Comics y abre el lector en Android con esta guía paso a paso.', "La compatibilidad con Orion en iOS / iPadOS está en desarrollo, sin soporte oficial todavía. Usa Firefox para Android, un navegador de escritorio o la traducción web."],
    notices: ['Es una guía de extensiones, no un APK de NodeLane. Usa Firefox para Android actualizado; la tienda comprueba la compatibilidad. Firefox Focus no sirve para esta guía.', "La compatibilidad con Orion en iOS / iPadOS está en desarrollo, sin soporte oficial todavía. Usa Firefox para Android, un navegador de escritorio o la traducción web."],
    steps: [
      ['Instala y abre Firefox', 'Usa la descarga de Android en la web oficial de Firefox. Después, abre esta guía y el enlace de la tienda en Firefox.'],
      ['Añade la extensión oficial', 'Abre la ficha de NodeLane Comics en Firefox que aparece abajo. Pulsa Añadir a Firefox, revisa los permisos y confirma. También puedes gestionar extensiones desde ⋮ → Extensiones.'],
      ['Abre el lector y prueba un capítulo', 'Selecciona NodeLane Comics en ⋮ → Extensiones de Firefox. Importa un archivo pequeño o añade un manga de un sitio compatible siguiendo las indicaciones. Configura la traducción cuando la necesites.'],
    ],
    troubleshooting: ['Si no aparece el botón, usa Firefox y actualízalo. No fuerces la instalación si la tienda indica incompatibilidad. Comprueba que la extensión esté activa y tenga permiso para el sitio; recarga. Prueba una pestaña normal: la navegación privada requiere permiso aparte.', "La compatibilidad con Orion en iOS / iPadOS está en desarrollo, sin soporte oficial todavía. Usa Firefox para Android, un navegador de escritorio o la traducción web."],
  },
  'pt-BR': {
    iosStatus: "Compatibilidade em desenvolvimento", screenshotNote: "Capturas de emulador Android 14, Firefox 157.0.1. O leitor usa a versão 0.10.3 assinada pela Mozilla, carregada temporariamente, e uma amostra original em inglês. Não comprovam instalação permanente, login ou tradução.",
    label: 'Guia de instalação', placeholder: 'Captura em breve', before: 'Antes de começar', sources: 'Referências oficiais',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Compatibilidade em desenvolvimento",
    titles: ['Leia mangás no Android com Firefox', "iOS / iPadOS · Orion — Compatibilidade em desenvolvimento"],
    descriptions: ['Instale o Firefox, adicione o NodeLane Comics e abra o leitor no Android, passo a passo.', "A compatibilidade com Orion no iOS / iPadOS está em desenvolvimento, ainda sem suporte oficial. Use Firefox Android, um navegador de computador ou a tradução web."],
    notices: ['Este é um guia de extensão, não um APK do NodeLane. Use o Firefox para Android atualizado; a loja verifica a compatibilidade. O Firefox Focus não se aplica.', "A compatibilidade com Orion no iOS / iPadOS está em desenvolvimento, ainda sem suporte oficial. Use Firefox Android, um navegador de computador ou a tradução web."],
    steps: [
      ['Instale e abra o Firefox', 'Use o download para Android no site oficial do Firefox. Depois, reabra este guia e o link da loja no Firefox.'],
      ['Adicione a extensão oficial', 'Abra a página do NodeLane Comics na loja Firefox abaixo. Toque em Adicionar ao Firefox, confira as permissões e confirme. O menu ⋮ → Extensões também permite gerenciá-las.'],
      ['Abra o leitor e experimente', 'Escolha NodeLane Comics em ⋮ → Extensões no Firefox. Importe um arquivo pequeno ou adicione um mangá de um site compatível seguindo as instruções. Configure a tradução quando precisar.'],
    ],
    troubleshooting: ['Sem botão? Abra no Firefox e atualize o navegador. Não force uma instalação incompatível. Verifique se a extensão está ativa e tem acesso ao site, depois recarregue. Teste em aba normal; a navegação privativa exige autorização separada.', "A compatibilidade com Orion no iOS / iPadOS está em desenvolvimento, ainda sem suporte oficial. Use Firefox Android, um navegador de computador ou a tradução web."],
  },
  de: {
    iosStatus: "Kompatibilität in Arbeit", screenshotNote: "Emulator-Aufnahmen: Android 14, Firefox 157.0.1. Der Reader nutzt die temporär geladene, Mozilla-signierte Version 0.10.3 mit einer eigenen englischen Originalseite. Dauerhafte Store-Installation, Anmeldung und Übersetzung wurden damit nicht verifiziert.",
    label: 'Installationsanleitung', placeholder: 'Screenshot folgt', before: 'Vor dem Start', sources: 'Offizielle Quellen',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Kompatibilität in Arbeit",
    titles: ['Comics auf Android mit Firefox lesen', "iOS / iPadOS · Orion — Kompatibilität in Arbeit"],
    descriptions: ['Firefox installieren, NodeLane Comics hinzufügen und den Reader auf Android öffnen – Schritt für Schritt.', "Die Orion-Kompatibilität für iOS / iPadOS ist in Arbeit, noch ohne offizielle Unterstützung. Bitte vorerst Android Firefox, einen Desktop-Browser oder die Web-Bildübersetzung nutzen."],
    notices: ['Dies ist eine Anleitung für eine Browser-Erweiterung, keine NodeLane-APK. Nutze aktuelles Firefox für Android; der Store prüft die Kompatibilität. Firefox Focus ist nicht geeignet.', "Die Orion-Kompatibilität für iOS / iPadOS ist in Arbeit, noch ohne offizielle Unterstützung. Bitte vorerst Android Firefox, einen Desktop-Browser oder die Web-Bildübersetzung nutzen."],
    steps: [
      ['Firefox installieren und öffnen', 'Nutze den Android-Download auf der offiziellen Firefox-Seite. Öffne danach diese Anleitung und den Store-Link in Firefox.'],
      ['Offizielle Erweiterung hinzufügen', 'Öffne unten den Firefox-Eintrag von NodeLane Comics. Wähle Zu Firefox hinzufügen, prüfe die Berechtigungen und bestätige. Unter ⋮ → Erweiterungen findest du die Verwaltung.'],
      ['Reader öffnen und ausprobieren', 'Wähle NodeLane Comics unter ⋮ → Erweiterungen in Firefox. Importiere eine kleine Datei oder füge einen Comic einer unterstützten Website nach den Hinweisen hinzu. Richte Übersetzung bei Bedarf ein.'],
    ],
    troubleshooting: ['Kein Installationsknopf? Öffne den Link in Firefox und aktualisiere den Browser. Erzwinge keine inkompatible Installation. Prüfe Aktivierung und Website-Zugriff und lade neu. Teste zuerst im normalen Tab; privates Surfen benötigt eine eigene Erlaubnis.', "Die Orion-Kompatibilität für iOS / iPadOS ist in Arbeit, noch ohne offizielle Unterstützung. Bitte vorerst Android Firefox, einen Desktop-Browser oder die Web-Bildübersetzung nutzen."],
  },
  it: {
    iosStatus: "Compatibilità in sviluppo", screenshotNote: "Schermate da emulatore Android 14, Firefox 157.0.1. Il lettore usa la versione 0.10.3 firmata da Mozilla, caricata temporaneamente, con un esempio originale in inglese. Non verificano installazione permanente, accesso o traduzione.",
    label: 'Guida all’installazione', placeholder: 'Schermata in arrivo', before: 'Prima di iniziare', sources: 'Fonti ufficiali',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Compatibilità in sviluppo",
    titles: ['Leggi manga su Android con Firefox', "iOS / iPadOS · Orion — Compatibilità in sviluppo"],
    descriptions: ['Installa Firefox, aggiungi NodeLane Comics e apri il lettore su Android con questa guida passo passo.', "La compatibilità con Orion su iOS / iPadOS è in sviluppo, non ancora supportata ufficialmente. Usa Firefox Android, un browser desktop o la traduzione web."],
    notices: ['È una guida per un’estensione, non un APK NodeLane. Usa Firefox per Android aggiornato; lo store verifica la compatibilità. Firefox Focus non è adatto.', "La compatibilità con Orion su iOS / iPadOS è in sviluppo, non ancora supportata ufficialmente. Usa Firefox Android, un browser desktop o la traduzione web."],
    steps: [
      ['Installa e apri Firefox', 'Usa il download Android sul sito ufficiale Firefox. Poi riapri questa guida e il link allo store in Firefox.'],
      ['Aggiungi l’estensione ufficiale', 'Apri la scheda Firefox di NodeLane Comics qui sotto. Scegli Aggiungi a Firefox, controlla i permessi e conferma. Puoi gestirla da ⋮ → Estensioni.'],
      ['Apri il lettore e prova', 'Seleziona NodeLane Comics in ⋮ → Estensioni di Firefox. Importa un file piccolo o aggiungi un manga da un sito supportato seguendo le indicazioni. Configura la traduzione se serve.'],
    ],
    troubleshooting: ['Manca il pulsante? Apri in Firefox e aggiornalo. Non forzare un’installazione incompatibile. Controlla attivazione e permessi del sito, poi ricarica. Prova una scheda normale: la navigazione privata richiede un consenso distinto.', "La compatibilità con Orion su iOS / iPadOS è in sviluppo, non ancora supportata ufficialmente. Usa Firefox Android, un browser desktop o la traduzione web."],
  },
  ru: {
    iosStatus: "Адаптация в процессе", screenshotNote: "Снимки эмулятора Android 14, Firefox 157.0.1. Ридер использует временно загруженную версию 0.10.3 с подписью Mozilla и оригинальный английский пример. Постоянная установка из магазина, вход и перевод этими снимками не подтверждены.",
    label: 'Инструкция', placeholder: 'Скриншот появится позже', before: 'Перед началом', sources: 'Официальные материалы',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Адаптация в процессе",
    titles: ['Читайте мангу на Android через Firefox', "iOS / iPadOS · Orion — Адаптация в процессе"],
    descriptions: ['Пошаговая установка Firefox и NodeLane Comics и запуск читалки на Android.', "Адаптация Orion для iOS / iPadOS продолжается; официальной поддержки пока нет. Используйте Firefox для Android, настольный браузер или веб-перевод изображений."],
    notices: ['Это инструкция для расширения, а не APK NodeLane. Используйте актуальный Firefox для Android: магазин проверит совместимость. Firefox Focus не подходит.', "Адаптация Orion для iOS / iPadOS продолжается; официальной поддержки пока нет. Используйте Firefox для Android, настольный браузер или веб-перевод изображений."],
    steps: [
      ['Установите и откройте Firefox', 'Скачайте Android-версию с официальной страницы Firefox. Затем откройте эту инструкцию и ссылку магазина в Firefox.'],
      ['Добавьте официальное расширение', 'Откройте страницу NodeLane Comics в магазине Firefox ниже. Нажмите «Добавить в Firefox», изучите разрешения и подтвердите. Управление доступно в ⋮ → Расширения.'],
      ['Откройте читалку и попробуйте', 'Выберите NodeLane Comics в меню Firefox ⋮ → Расширения. Импортируйте небольшой файл или добавьте мангу с поддерживаемого сайта по подсказкам. Настройте перевод при необходимости.'],
    ],
    troubleshooting: ['Нет кнопки установки? Откройте ссылку в Firefox и обновите браузер. Не обходите предупреждение о несовместимости. Проверьте включение расширения и доступ к сайту, затем обновите страницу. Начните с обычной вкладки; приватный режим требует отдельного разрешения.', "Адаптация Orion для iOS / iPadOS продолжается; официальной поддержки пока нет. Используйте Firefox для Android, настольный браузер или веб-перевод изображений."],
  },
  pl: {
    iosStatus: "Dostosowanie w toku", screenshotNote: "Zrzuty z emulatora Android 14, Firefox 157.0.1. Czytnik używa tymczasowo załadowanej wersji 0.10.3 podpisanej przez Mozillę i oryginalnego angielskiego przykładu. Nie potwierdzają trwałej instalacji ze sklepu, logowania ani tłumaczenia.",
    label: 'Instrukcja instalacji', placeholder: 'Zrzut ekranu wkrótce', before: 'Zanim zaczniesz', sources: 'Oficjalne źródła',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Dostosowanie w toku",
    titles: ['Czytaj mangę na Androidzie w Firefoksie', "iOS / iPadOS · Orion — Dostosowanie w toku"],
    descriptions: ['Zainstaluj Firefoksa, dodaj NodeLane Comics i otwórz czytnik na Androidzie krok po kroku.', "Dostosowanie Oriona do iOS / iPadOS trwa; brak jeszcze oficjalnego wsparcia. Użyj Firefoksa na Androidzie, przeglądarki komputerowej lub tłumaczenia obrazów online."],
    notices: ['To instrukcja rozszerzenia, nie plik APK NodeLane. Użyj aktualnego Firefoksa na Androida; sklep sprawdzi zgodność. Firefox Focus nie jest odpowiedni.', "Dostosowanie Oriona do iOS / iPadOS trwa; brak jeszcze oficjalnego wsparcia. Użyj Firefoksa na Androidzie, przeglądarki komputerowej lub tłumaczenia obrazów online."],
    steps: [
      ['Zainstaluj i otwórz Firefoksa', 'Skorzystaj z pobierania na Androida na oficjalnej stronie Firefoksa. Otwórz ponownie tę instrukcję i link sklepu w Firefoksie.'],
      ['Dodaj oficjalne rozszerzenie', 'Otwórz poniższą stronę NodeLane Comics w sklepie Firefox. Wybierz Dodaj do Firefoksa, sprawdź uprawnienia i potwierdź. Zarządzanie znajdziesz w ⋮ → Rozszerzenia.'],
      ['Otwórz czytnik i wypróbuj', 'Wybierz NodeLane Comics w ⋮ → Rozszerzenia. Zaimportuj mały plik lub dodaj mangę z obsługiwanej strony według wskazówek. Skonfiguruj tłumaczenie, gdy będzie potrzebne.'],
    ],
    troubleshooting: ['Brak przycisku? Otwórz w Firefoksie i zaktualizuj go. Nie wymuszaj niezgodnej instalacji. Sprawdź włączenie rozszerzenia i dostęp do witryny, potem odśwież. Użyj zwykłej karty; tryb prywatny wymaga osobnej zgody.', "Dostosowanie Oriona do iOS / iPadOS trwa; brak jeszcze oficjalnego wsparcia. Użyj Firefoksa na Androidzie, przeglądarki komputerowej lub tłumaczenia obrazów online."],
  },
  uk: {
    iosStatus: "Адаптація триває", screenshotNote: "Знімки емулятора Android 14, Firefox 157.0.1. Читач використовує тимчасово завантажену версію 0.10.3 з підписом Mozilla та оригінальний англомовний зразок. Постійне встановлення з магазину, вхід і переклад цими знімками не підтверджені.",
    label: 'Посібник зі встановлення', placeholder: 'Знімок екрана згодом', before: 'Перед початком', sources: 'Офіційні джерела',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Адаптація триває",
    titles: ['Читайте манґу на Android через Firefox', "iOS / iPadOS · Orion — Адаптація триває"],
    descriptions: ['Покрокове встановлення Firefox і NodeLane Comics та відкриття читача на Android.', "Адаптація Orion для iOS / iPadOS триває; офіційної підтримки ще немає. Скористайтеся Firefox для Android, настільним браузером або вебперекладом зображень."],
    notices: ['Це посібник для розширення, не APK NodeLane. Використовуйте оновлений Firefox для Android; магазин перевіряє сумісність. Firefox Focus не підходить.', "Адаптація Orion для iOS / iPadOS триває; офіційної підтримки ще немає. Скористайтеся Firefox для Android, настільним браузером або вебперекладом зображень."],
    steps: [
      ['Встановіть і відкрийте Firefox', 'Завантажте Android-версію з офіційної сторінки Firefox. Потім відкрийте цей посібник і посилання магазину у Firefox.'],
      ['Додайте офіційне розширення', 'Відкрийте сторінку NodeLane Comics у магазині Firefox нижче. Натисніть «Додати до Firefox», перегляньте дозволи й підтвердьте. Керування доступне в ⋮ → Розширення.'],
      ['Відкрийте читач і спробуйте', 'Виберіть NodeLane Comics у ⋮ → Розширення Firefox. Імпортуйте невеликий файл або додайте манґу з підтримуваного сайту за підказками. Налаштуйте переклад за потреби.'],
    ],
    troubleshooting: ['Немає кнопки? Відкрийте посилання у Firefox та оновіть його. Не примушуйте несумісне встановлення. Перевірте ввімкнення та доступ до сайту й оновіть сторінку. Почніть зі звичайної вкладки; приватний режим потребує окремого дозволу.', "Адаптація Orion для iOS / iPadOS триває; офіційної підтримки ще немає. Скористайтеся Firefox для Android, настільним браузером або вебперекладом зображень."],
  },
  tr: {
    iosStatus: "Uyumluluk çalışmaları sürüyor", screenshotNote: "Android 14, Firefox 157.0.1 emülatör görüntüleri. Okuyucu, geçici yüklenen Mozilla imzalı 0.10.3 ve özgün İngilizce örnek kullanır. Kalıcı mağaza kurulumu, oturum açma ve çeviri bu görüntülerle doğrulanmamıştır.",
    label: 'Kurulum rehberi', placeholder: 'Ekran görüntüsü eklenecek', before: 'Başlamadan önce', sources: 'Resmî kaynaklar',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Uyumluluk çalışmaları sürüyor",
    titles: ['Android’de Firefox ile manga okuyun', "iOS / iPadOS · Orion — Uyumluluk çalışmaları sürüyor"],
    descriptions: ['Firefox’u yükleyin, NodeLane Comics’i ekleyin ve Android’de okuyucuyu adım adım açın.', "iOS / iPadOS için Orion uyumluluğu geliştiriliyor; henüz resmî destek yok. Şimdilik Android Firefox, masaüstü tarayıcı veya web görsel çevirisini kullanın."],
    notices: ['Bu bir uzantı rehberidir, NodeLane APK’sı değildir. Güncel Android Firefox kullanın; mağaza sürüm uyumluluğunu denetler. Firefox Focus uygun değildir.', "iOS / iPadOS için Orion uyumluluğu geliştiriliyor; henüz resmî destek yok. Şimdilik Android Firefox, masaüstü tarayıcı veya web görsel çevirisini kullanın."],
    steps: [
      ['Firefox’u yükleyip açın', 'Firefox’un resmî sayfasındaki Android indirmesini kullanın. Ardından bu rehberi ve mağaza bağlantısını Firefox’ta açın.'],
      ['Resmî uzantıyı ekleyin', 'Aşağıdaki NodeLane Comics Firefox mağaza sayfasını açın. Firefox’a ekle seçeneğine dokunun, izinleri okuyup onaylayın. Yönetim için ⋮ → Uzantılar menüsünü kullanabilirsiniz.'],
      ['Okuyucuyu açıp deneyin', 'Firefox’ta ⋮ → Uzantılar menüsünden NodeLane Comics’i seçin. Küçük bir dosya alın veya desteklenen siteden yönergelerle manga ekleyin. Gerektiğinde çeviriyi ayarlayın.'],
    ],
    troubleshooting: ['Kurulum düğmesi yoksa Firefox’ta açıp tarayıcıyı güncelleyin. Uyumsuz kurulumu zorlamayın. Uzantının ve site erişiminin açık olduğunu kontrol edip yenileyin. Önce normal sekmede deneyin; gizli gezinme ayrı izin gerektirir.', "iOS / iPadOS için Orion uyumluluğu geliştiriliyor; henüz resmî destek yok. Şimdilik Android Firefox, masaüstü tarayıcı veya web görsel çevirisini kullanın."],
  },
  vi: {
    iosStatus: "Đang hoàn thiện tương thích", screenshotNote: "Ảnh từ trình giả lập Android 14, Firefox 157.0.1. Trình đọc dùng bản 0.10.3 có chữ ký Mozilla được nạp tạm và mẫu gốc tiếng Anh tự sáng tác. Ảnh không xác nhận cài đặt lâu dài từ cửa hàng, đăng nhập hay dịch.",
    label: 'Hướng dẫn cài đặt', placeholder: 'Sẽ bổ sung ảnh chụp', before: 'Trước khi bắt đầu', sources: 'Tài liệu chính thức',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Đang hoàn thiện tương thích",
    titles: ['Đọc truyện trên Android bằng Firefox', "iOS / iPadOS · Orion — Đang hoàn thiện tương thích"],
    descriptions: ['Từng bước cài Firefox, thêm NodeLane Comics và mở trình đọc trên Android.', "Khả năng tương thích Orion trên iOS / iPadOS đang được hoàn thiện, chưa hỗ trợ chính thức. Tạm dùng Firefox Android, trình duyệt máy tính hoặc dịch ảnh trên web."],
    notices: ['Đây là hướng dẫn tiện ích trình duyệt, không phải APK NodeLane. Dùng Firefox Android mới nhất; cửa hàng kiểm tra phiên bản tương thích. Không áp dụng cho Firefox Focus.', "Khả năng tương thích Orion trên iOS / iPadOS đang được hoàn thiện, chưa hỗ trợ chính thức. Tạm dùng Firefox Android, trình duyệt máy tính hoặc dịch ảnh trên web."],
    steps: [
      ['Cài và mở Firefox', 'Dùng mục tải Android trên trang Firefox chính thức. Sau đó mở lại hướng dẫn này và liên kết cửa hàng trong Firefox.'],
      ['Thêm tiện ích chính thức', 'Mở trang NodeLane Comics trên cửa hàng Firefox bên dưới. Chọn Thêm vào Firefox, đọc quyền và xác nhận. Có thể quản lý qua ⋮ → Tiện ích.'],
      ['Mở trình đọc và thử', 'Chọn NodeLane Comics trong ⋮ → Tiện ích của Firefox. Nhập tệp nhỏ hoặc thêm truyện từ trang được hỗ trợ theo hướng dẫn của tiện ích. Cấu hình dịch khi cần.'],
    ],
    troubleshooting: ['Không có nút cài? Mở bằng Firefox và cập nhật trình duyệt. Không ép cài nếu cửa hàng báo không tương thích. Kiểm tra tiện ích đã bật và được truy cập trang rồi tải lại. Thử thẻ thường trước; chế độ riêng tư cần cho phép riêng.', "Khả năng tương thích Orion trên iOS / iPadOS đang được hoàn thiện, chưa hỗ trợ chính thức. Tạm dùng Firefox Android, trình duyệt máy tính hoặc dịch ảnh trên web."],
  },
  id: {
    iosStatus: "Penyesuaian sedang berlangsung", screenshotNote: "Tangkapan emulator Android 14, Firefox 157.0.1. Pembaca memakai versi 0.10.3 bertanda tangan Mozilla yang dimuat sementara dan contoh asli berbahasa Inggris. Pemasangan permanen dari toko, login dan terjemahan tidak dibuktikan oleh gambar ini.",
    label: 'Panduan pemasangan', placeholder: 'Tangkapan layar menyusul', before: 'Sebelum memulai', sources: 'Referensi resmi',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — Penyesuaian sedang berlangsung",
    titles: ['Baca manga di Android dengan Firefox', "iOS / iPadOS · Orion — Penyesuaian sedang berlangsung"],
    descriptions: ['Pasang Firefox, tambahkan NodeLane Comics dan buka pembaca di Android langkah demi langkah.', "Penyesuaian Orion untuk iOS / iPadOS sedang berlangsung, belum didukung resmi. Gunakan Firefox Android, peramban desktop atau penerjemah gambar web sementara."],
    notices: ['Ini panduan ekstensi, bukan APK NodeLane. Gunakan Firefox Android terbaru; toko memeriksa kompatibilitas versi. Firefox Focus tidak sesuai untuk panduan ini.', "Penyesuaian Orion untuk iOS / iPadOS sedang berlangsung, belum didukung resmi. Gunakan Firefox Android, peramban desktop atau penerjemah gambar web sementara."],
    steps: [
      ['Pasang dan buka Firefox', 'Gunakan unduhan Android dari situs resmi Firefox. Lalu buka kembali panduan dan tautan toko ini di Firefox.'],
      ['Tambahkan ekstensi resmi', 'Buka halaman NodeLane Comics di toko Firefox di bawah. Pilih Tambahkan ke Firefox, periksa izin dan konfirmasi. Kelola ekstensi melalui ⋮ → Ekstensi.'],
      ['Buka pembaca dan coba', 'Pilih NodeLane Comics di ⋮ → Ekstensi Firefox. Impor berkas kecil atau tambahkan manga dari situs yang didukung sesuai petunjuk. Atur terjemahan saat diperlukan.'],
    ],
    troubleshooting: ['Tidak ada tombol? Buka di Firefox dan perbarui peramban. Jangan paksa pemasangan yang tidak kompatibel. Periksa ekstensi aktif dan izin situs, lalu muat ulang. Uji tab biasa; mode privat memerlukan izin terpisah.', "Penyesuaian Orion untuk iOS / iPadOS sedang berlangsung, belum didukung resmi. Gunakan Firefox Android, peramban desktop atau penerjemah gambar web sementara."],
  },
  ar: {
    iosStatus: "التوافق قيد التطوير", screenshotNote: "لقطات محاكي Android 14 وFirefox 157.0.1. يستخدم القارئ الإصدار 0.10.3 الموقّع من Mozilla والمحمّل مؤقتًا وعينة أصلية بالإنجليزية. لا تثبت اللقطات التثبيت الدائم من المتجر أو تسجيل الدخول أو الترجمة.",
    label: 'دليل التثبيت', placeholder: 'ستُضاف لقطة الشاشة لاحقًا', before: 'قبل البدء', sources: 'المراجع الرسمية',
    availability: "Chrome · Edge · Firefox / Android · Firefox / iOS · Orion — التوافق قيد التطوير",
    titles: ['اقرأ المانغا على Android باستخدام Firefox', "iOS / iPadOS · Orion — التوافق قيد التطوير"],
    descriptions: ['ثبّت Firefox وأضف NodeLane Comics وافتح القارئ على Android خطوة بخطوة.', "توافق Orion على iOS / iPadOS قيد التطوير ولم يُدعم رسميًا بعد. استخدم حاليًا Firefox على Android أو متصفح الكمبيوتر أو ترجمة الصور على الويب."],
    notices: ['هذا دليل لإضافة متصفح وليس ملف APK لـ NodeLane. استخدم Firefox المحدّث على Android؛ يتحقق المتجر من توافق الإصدار. لا ينطبق الدليل على Firefox Focus.', "توافق Orion على iOS / iPadOS قيد التطوير ولم يُدعم رسميًا بعد. استخدم حاليًا Firefox على Android أو متصفح الكمبيوتر أو ترجمة الصور على الويب."],
    steps: [
      ['ثبّت Firefox وافتحه', 'استخدم تنزيل Android من موقع Firefox الرسمي. ثم أعد فتح هذا الدليل ورابط المتجر داخل Firefox.'],
      ['أضف الإضافة الرسمية', 'افتح صفحة NodeLane Comics في متجر Firefox أدناه. اختر الإضافة إلى Firefox وراجع الأذونات ثم أكّد. يمكنك إدارتها من قائمة ⋮ ثم الإضافات.'],
      ['افتح القارئ وجرّب', 'اختر NodeLane Comics من قائمة الإضافات في Firefox. استورد ملفًا صغيرًا أو أضف مانغا من موقع مدعوم باتباع الإرشادات. اضبط الترجمة عند الحاجة.'],
    ],
    troubleshooting: ['لا يظهر زر التثبيت؟ افتح الرابط في Firefox وحدّثه. لا تفرض تثبيت إصدار غير متوافق. تحقق من تفعيل الإضافة وأذونات الموقع ثم أعد التحميل. جرّب تبويبًا عاديًا؛ التصفح الخاص يحتاج إذنًا منفصلًا.', "توافق Orion على iOS / iPadOS قيد التطوير ولم يُدعم رسميًا بعد. استخدم حاليًا Firefox على Android أو متصفح الكمبيوتر أو ترجمة الصور على الويب."],
  },
};

export function mobileGuides(locale: Locale, ui: UI): Guide[] {
  const copy = mobileCopy[locale];
  return mobilePlatforms.map((platform, platformIndex) => {
    const steps = platform.id === 'android' ? copy.steps.slice(0, 3) : [];
    return {
      slug: platform.slug, title: copy.titles[platformIndex], description: copy.descriptions[platformIndex],
      category: `${platform.name} · ${platform.browser}`, minutes: platform.id === 'android' ? 3 : 1,
      published: '2026-10-08', updated: '2026-10-09',
      related: [mobilePlatforms[1 - platformIndex].slug, 'manga-translation', 'translation-troubleshooting'],
      sections: [
        { title: copy.before, paragraphs: platform.id === 'android' ? [copy.notices[0], copy.screenshotNote] : [copy.notices[1]] },
        ...steps.map(([title, body], index) => ({
          title: `${index + 1}. ${title}`, paragraphs: [body],
          screenshot: { id: `${platform.id}-${index + 1}`, label: copy.placeholder, caption: `${platform.browser} · ${title}`, src: `/guides/firefox/${locale.startsWith('zh') ? 'zh-CN' : 'en'}/${['01-firefox-open', '02-add-extension', '03-read-sample'][index]}.png` },
          ...(index === 0 ? { links: [{ label: `${platform.browser} ↗`, href: platform.browserUrl }] } :
            index === 1 ? { links: [{ label: 'NodeLane Comics · Firefox Add-ons ↗', href: site.stores.firefox }] } : {}),
        })),
        { title: platform.id === 'android' ? ui.faq : ui.help, paragraphs: platform.id === 'android' ? [copy.troubleshooting[0]] : [], links: [{ label: ui.help, href: '/help/' }, { label: ui.guides, href: '/guides/manga-translation/' }, { label: translationCopy[locale].open, href: '/translate/' }] },
        { title: copy.sources, paragraphs: [copy.availability], links: [{ label: `${platform.browser} · ${copy.label} ↗`, href: platform.sourceUrl }] },
      ],
    };
  });
}
