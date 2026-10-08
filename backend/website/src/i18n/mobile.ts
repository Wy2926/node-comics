import type { Guide, Locale, UI } from './types';
import { mobilePlatforms } from '../data/mobile';
import { site } from '../data/site';
import { translationCopy } from './translate';

interface MobileCopy {
  label: string;
  placeholder: string;
  before: string;
  sources: string;
  availability: string;
  titles: [string, string];
  descriptions: [string, string];
  notices: [string, string];
  // Android: browser, extension, open. iOS: browser, setting, extension, open.
  steps: [string, string][];
  troubleshooting: [string, string];
}

export const mobileCopy: Record<Locale, MobileCopy> = {
  'zh-CN': {
    label: '安装教程', placeholder: '截图待补充', before: '开始之前', sources: '官方参考',
    availability: '电脑使用 Chrome、Edge 或 Firefox；Android 通过 Firefox，iPhone / iPad 通过 Orion 安装浏览器插件。手机入口是教程，不是独立 App 下载。',
    titles: ['在 Android 上，用 Firefox 阅读漫画', '在 iPhone 与 iPad 上，通过 Orion 开始阅读'],
    descriptions: ['从安装 Firefox 到打开 NodeLane 漫译，按步骤在 Android 上使用漫画阅读与翻译插件。', '在 Orion 中开启扩展支持、安装 NodeLane 漫译并打开阅读器。包含 iOS / iPadOS 兼容性提醒。'],
    notices: ['这是浏览器插件教程，无需下载 NodeLane APK。请使用最新版 Firefox 安卓版，商店会检查版本兼容性；Firefox Focus 不适用。', '这不是 NodeLane iOS App，也不是 Safari 扩展。Orion 的扩展支持仍在测试中，部分功能可能受限；安装成功不代表登录、导入和翻译均可用，请先用少量内容验证。'],
    steps: [
      ['安装并打开 Firefox', '从 Firefox 官方下载页进入 Android 安装入口。安装后，在 Firefox 中重新打开本教程，后面的商店链接也要在 Firefox 中打开。'],
      ['从官方商店添加插件', '打开下方 NodeLane 漫译的 Firefox 商店页面，点“添加到 Firefox”，阅读权限说明后确认添加。也可从 Firefox 的“⋮ → 扩展”进入扩展管理。'],
      ['打开插件，试读一章', '在 Firefox 的“⋮ → 扩展”中选择 NodeLane 漫译，打开书架或阅读器。先导入一个小文件，或在已适配的网站打开漫画并按插件提示添加；需要翻译时再配置渠道。'],
      ['安装并打开 Orion', '通过下方 Orion 官方安装页前往 App Store，安装“Orion Browser by Kagi”。打开 Orion 后，在其中重新访问本教程，不要继续在 Safari 内操作。'],
      ['开启 Firefox 扩展支持', '打开 Orion 的“••• → Settings（设置）”，找到 Extensions（扩展），开启 Firefox 扩展支持。本教程使用 Firefox 商店版，不必同时开启 Chrome 扩展支持。'],
      ['在 Orion 中安装插件', '用 Orion 打开下方 NodeLane 漫译的 Firefox 商店页面，选择添加扩展，并按 Orion 弹出的提示确认。若只下载了文件而未安装，先返回设置确认扩展支持已开启。'],
      ['从扩展菜单打开阅读器', '打开 Orion 的“••• → Extensions（扩展）”，选择 NodeLane 漫译。iPhone 菜单通常在右下角，iPad 在右上角。先测试打开书架、少量导入和翻译，再开始长篇阅读。'],
    ],
    troubleshooting: ['没有安装按钮时，确认链接在 Firefox 中打开并更新浏览器；若商店提示不兼容，不要强行安装。已安装却无反应时，检查扩展是否启用、网站权限是否允许，并刷新漫画页。先用普通标签页测试；隐私浏览需要另行允许扩展运行。', '找不到安装入口时，确认正在使用 Orion 且 Firefox 扩展支持已开启。打不开或运行异常时，在扩展列表停用后重新启用，并更新 Orion。若仍失败，记录系统、Orion 与插件版本及复现步骤后反馈；可临时使用官网图片翻译。'],
  },
  'zh-TW': {
    label: '安裝教學', placeholder: '截圖待補充', before: '開始之前', sources: '官方參考',
    availability: '電腦使用 Chrome、Edge 或 Firefox；Android 透過 Firefox，iPhone / iPad 透過 Orion 安裝擴充功能。手機入口是教學，不是獨立 App 下載。',
    titles: ['在 Android 上，用 Firefox 閱讀漫畫', '在 iPhone 與 iPad 上，透過 Orion 開始閱讀'],
    descriptions: ['從安裝 Firefox 到開啟 NodeLane 漫譯，逐步在 Android 上使用漫畫閱讀與翻譯擴充功能。', '在 Orion 中啟用擴充功能支援、安裝 NodeLane 漫譯並開啟閱讀器，含 iOS / iPadOS 相容性提醒。'],
    notices: ['這是瀏覽器擴充功能教學，不需下載 NodeLane APK。請使用最新版 Firefox Android，商店會檢查版本相容性；不適用 Firefox Focus。', '這不是 NodeLane iOS App，也不是 Safari 擴充功能。Orion 的擴充功能支援仍在測試中；安裝成功不代表登入、匯入及翻譯均可用，請先用少量內容測試。'],
    steps: [
      ['安裝並開啟 Firefox', '從 Firefox 官方下載頁進入 Android 安裝入口。安裝後在 Firefox 重新開啟本教學，後續商店連結也須在 Firefox 開啟。'],
      ['從官方商店新增擴充功能', '開啟下方 NodeLane 漫譯的 Firefox 商店頁，選擇「新增至 Firefox」，閱讀權限後確認。也可從「⋮ → 擴充功能」進入管理頁。'],
      ['開啟擴充功能，試讀一章', '在 Firefox「⋮ → 擴充功能」選擇 NodeLane 漫譯並開啟書架。先匯入小檔案，或在支援網站依提示新增漫畫；需要翻譯時再設定管道。'],
      ['安裝並開啟 Orion', '透過下方 Orion 官方安裝頁前往 App Store，安裝「Orion Browser by Kagi」。請在 Orion 重新開啟本教學，不要繼續使用 Safari。'],
      ['啟用 Firefox 擴充功能支援', '在 Orion「••• → Settings（設定）」找到 Extensions（擴充功能），啟用 Firefox 支援。本教學使用 Firefox 商店版，不必同時啟用 Chrome 支援。'],
      ['在 Orion 安裝擴充功能', '在 Orion 開啟下方 NodeLane 漫譯 Firefox 商店頁，選擇新增並依提示確認。若只下載檔案，請先確認擴充功能支援已啟用。'],
      ['從擴充功能選單開啟閱讀器', '在 Orion「••• → Extensions」選擇 NodeLane 漫譯。iPhone 選單通常在右下，iPad 在右上。先測試書架、小量匯入與翻譯，再開始長篇閱讀。'],
    ],
    troubleshooting: ['沒有安裝按鈕時，確認使用 Firefox 並更新瀏覽器；商店提示不相容時不要強行安裝。無反應時檢查啟用狀態及網站權限，再重新整理。先用一般分頁測試，隱私瀏覽須另行允許擴充功能。', '確認使用 Orion 並已啟用 Firefox 擴充功能支援。異常時停用再啟用擴充功能，並更新 Orion。仍失敗請提供系統、瀏覽器與擴充功能版本及重現步驟；可暫用官網圖片翻譯。'],
  },
  en: {
    label: 'Setup guide', placeholder: 'Screenshot coming soon', before: 'Before you start', sources: 'Official references',
    availability: 'Use Chrome, Edge or Firefox on desktop; Firefox on Android; Orion on iPhone / iPad. Mobile links open setup guides, not standalone app downloads.',
    titles: ['Read comics on Android with Firefox', 'Start reading on iPhone and iPad with Orion'],
    descriptions: ['Install Firefox, add NodeLane Comics and open your reader on Android. A step-by-step mobile extension guide.', 'Enable extension support in Orion, install NodeLane Comics and open the reader, with iOS / iPadOS compatibility notes.'],
    notices: ['This is a browser extension guide, not a NodeLane APK. Use up-to-date Firefox for Android; the store checks version compatibility. Firefox Focus is not supported by this guide.', 'This is not a NodeLane iOS app or a Safari extension. Orion extension support is in beta. Installation alone does not prove sign-in, imports or translation work; test with a little content first.'],
    steps: [
      ['Install and open Firefox', 'Follow the Android download on the official Firefox page. Then reopen this guide in Firefox and keep using Firefox for the store link below.'],
      ['Add the extension from the official store', 'Open the NodeLane Comics Firefox listing below. Choose Add to Firefox, review the requested permissions and confirm. The ⋮ → Extensions menu also opens extension management.'],
      ['Open the reader and try a chapter', 'Choose NodeLane Comics from Firefox’s ⋮ → Extensions menu to open the library or reader. Try a small local file or add a comic from a supported site using the extension’s prompts. Configure translation when you need it.'],
      ['Install and open Orion', 'Follow the official Orion installation page below to the App Store and install Orion Browser by Kagi. Reopen this guide inside Orion, not Safari.'],
      ['Enable Firefox extension support', 'In Orion, open ••• → Settings and find Extensions. Enable Firefox extensions. This guide uses the Firefox store version, so Chrome extension support is not also required.'],
      ['Install the extension in Orion', 'Open the NodeLane Comics Firefox listing below inside Orion. Add the extension and confirm Orion’s prompts. If a file downloads without installing, check that extension support is enabled first.'],
      ['Open the reader from Extensions', 'Choose NodeLane Comics in Orion’s ••• → Extensions menu, usually at the bottom right on iPhone and top right on iPad. Test the library, a small import and translation before a longer session.'],
    ],
    troubleshooting: ['No install button? Open the link in Firefox and update the browser. Do not force an install if the store reports incompatibility. If nothing happens, check the extension is enabled and site access is allowed, then reload. Test in a regular tab first; private browsing needs separate permission.', 'Check you are in Orion with Firefox extension support enabled. Disable and re-enable the extension and update Orion. If it still fails, report your OS, browser and extension versions with reproduction steps. The website image translator is a temporary alternative.'],
  },
  ja: {
    label: '導入ガイド', placeholder: 'スクリーンショット準備中', before: '始める前に', sources: '公式資料',
    availability: 'PC は Chrome・Edge・Firefox、Android は Firefox、iPhone / iPad は Orion を使います。モバイルのリンクは導入ガイドで、専用アプリの配布ではありません。',
    titles: ['Android の Firefox で漫画を読む', 'iPhone・iPad の Orion で読み始める'],
    descriptions: ['Firefox のインストールから NodeLane Comics の追加、リーダーの起動まで、Android での手順を紹介します。', 'Orion の拡張機能を有効にして NodeLane Comics を追加する手順と、iOS / iPadOS の互換性の注意点。'],
    notices: ['NodeLane APK ではなくブラウザー拡張機能のガイドです。最新の Android 版 Firefox を使用してください。対応バージョンはストアで確認されます。Firefox Focus は対象外です。', 'NodeLane の iOS アプリや Safari 拡張機能ではありません。Orion の拡張機能対応はベータ版です。インストールできてもログイン・読み込み・翻訳が動くとは限らないため、少量で試してください。'],
    steps: [
      ['Firefox をインストール', 'Firefox 公式ページの Android ダウンロードから導入し、このガイドを Firefox で開き直します。以下のストアも Firefox で開いてください。'],
      ['公式ストアで拡張機能を追加', '下の NodeLane Comics の Firefox ストアを開き、「Firefox へ追加」を選択。権限を確認して追加します。「⋮ → 拡張機能」でも管理できます。'],
      ['リーダーを開いて試す', 'Firefox の「⋮ → 拡張機能」で NodeLane Comics を選択。小さなファイル、または対応サイトの漫画を案内に従って追加し、必要な場合に翻訳を設定します。'],
      ['Orion をインストール', '下の Orion 公式案内から App Store の「Orion Browser by Kagi」をインストール。このガイドを Safari ではなく Orion で開きます。'],
      ['Firefox 拡張機能を有効にする', 'Orion の「••• → Settings → Extensions」で Firefox 拡張機能を有効にします。このガイドでは Firefox 版を使用し、Chrome の設定は不要です。'],
      ['Orion に拡張機能を追加', 'Orion で下の Firefox ストアを開き、NodeLane Comics を追加して確認します。ファイルが保存されるだけの場合は、拡張機能の設定を確認してください。'],
      ['拡張機能メニューから読む', '「••• → Extensions」で NodeLane Comics を選択。通常 iPhone は右下、iPad は右上にメニューがあります。本棚・少量の読み込み・翻訳を先に試してください。'],
    ],
    troubleshooting: ['追加ボタンがない場合は Firefox で開き、更新してください。非対応表示が出たら無理に導入しないでください。無反応なら有効状態とサイト権限を確認し再読み込みします。まず通常タブで試し、プライベート閲覧は別途許可してください。', 'Orion で Firefox 拡張機能が有効か確認し、拡張機能を無効・再有効化して Orion を更新します。解決しなければ OS・ブラウザー・拡張機能のバージョンと再現手順を報告してください。一時的にサイトの画像翻訳も使えます。'],
  },
  ko: {
    label: '설치 안내', placeholder: '스크린샷 준비 중', before: '시작하기 전에', sources: '공식 자료',
    availability: 'PC에서는 Chrome·Edge·Firefox, Android에서는 Firefox, iPhone / iPad에서는 Orion을 사용합니다. 모바일 링크는 별도 앱 다운로드가 아닌 설치 안내입니다.',
    titles: ['Android의 Firefox에서 만화 읽기', 'iPhone과 iPad의 Orion에서 시작하기'],
    descriptions: ['Firefox 설치부터 NodeLane Comics 추가와 리더 실행까지 Android용 확장 프로그램 설정을 안내합니다.', 'Orion에서 확장 지원을 켜고 NodeLane Comics를 설치하는 방법과 iOS / iPadOS 호환성 주의 사항입니다.'],
    notices: ['NodeLane APK가 아닌 브라우저 확장 프로그램 안내입니다. 최신 Android용 Firefox를 사용하세요. 스토어가 버전 호환성을 확인합니다. Firefox Focus는 대상이 아닙니다.', 'NodeLane iOS 앱이나 Safari 확장이 아닙니다. Orion 확장 지원은 베타입니다. 설치 성공이 로그인·가져오기·번역 작동을 보장하지 않으므로 적은 콘텐츠로 먼저 확인하세요.'],
    steps: [
      ['Firefox 설치 및 실행', 'Firefox 공식 페이지에서 Android 다운로드로 이동하세요. 설치 후 이 안내와 아래 스토어 링크를 Firefox에서 여세요.'],
      ['공식 스토어에서 확장 추가', '아래 NodeLane Comics Firefox 스토어에서 Firefox에 추가를 누르고 권한을 확인하세요. ⋮ → 확장 프로그램에서도 관리할 수 있습니다.'],
      ['리더를 열고 시험해 보기', 'Firefox의 ⋮ → 확장 프로그램에서 NodeLane Comics를 선택하세요. 작은 파일을 가져오거나 지원 사이트의 만화를 안내에 따라 추가하세요. 번역은 필요할 때 설정합니다.'],
      ['Orion 설치 및 실행', '아래 Orion 공식 설치 페이지를 통해 App Store에서 Orion Browser by Kagi를 설치하세요. Safari가 아닌 Orion에서 이 안내를 다시 여세요.'],
      ['Firefox 확장 지원 켜기', 'Orion의 ••• → Settings → Extensions에서 Firefox 확장을 켜세요. 이 안내는 Firefox 스토어 버전을 사용하므로 Chrome 지원까지 켤 필요는 없습니다.'],
      ['Orion에서 확장 설치', 'Orion에서 아래 Firefox 스토어 링크를 열고 NodeLane Comics를 추가한 뒤 확인하세요. 파일만 다운로드되면 확장 지원 설정부터 확인하세요.'],
      ['확장 메뉴에서 리더 열기', 'Orion의 ••• → Extensions에서 NodeLane Comics를 선택하세요. 메뉴는 보통 iPhone 오른쪽 아래, iPad 오른쪽 위에 있습니다. 책장·소량 가져오기·번역을 먼저 시험하세요.'],
    ],
    troubleshooting: ['설치 버튼이 없으면 Firefox에서 열었는지 확인하고 업데이트하세요. 호환되지 않는다는 안내가 있으면 강제 설치하지 마세요. 반응이 없으면 활성화와 사이트 권한을 확인하고 새로고침하세요. 먼저 일반 탭에서 테스트하세요. 비공개 탐색은 별도 허용이 필요합니다.', 'Orion의 Firefox 확장 지원을 확인하고 확장을 껐다 켠 뒤 Orion을 업데이트하세요. 계속 실패하면 OS·브라우저·확장 버전과 재현 절차를 알려 주세요. 임시로 웹사이트 이미지 번역을 사용할 수 있습니다.'],
  },
  fr: {
    label: 'Guide d’installation', placeholder: 'Capture à venir', before: 'Avant de commencer', sources: 'Références officielles',
    availability: 'Chrome, Edge ou Firefox sur ordinateur ; Firefox sur Android ; Orion sur iPhone / iPad. Les liens mobiles ouvrent des guides, pas des applications autonomes.',
    titles: ['Lire des mangas sur Android avec Firefox', 'Commencer sur iPhone et iPad avec Orion'],
    descriptions: ['Installez Firefox, ajoutez NodeLane Comics et ouvrez le lecteur sur Android, étape par étape.', 'Activez les extensions dans Orion et installez NodeLane Comics, avec les précautions de compatibilité iOS / iPadOS.'],
    notices: ['Ce guide concerne une extension, pas un APK NodeLane. Utilisez Firefox pour Android à jour ; la boutique vérifie la compatibilité. Firefox Focus ne convient pas.', 'Il ne s’agit ni d’une app NodeLane iOS ni d’une extension Safari. La prise en charge d’Orion est en bêta. Une installation réussie ne garantit pas la connexion, l’importation ou la traduction : testez d’abord un petit contenu.'],
    steps: [
      ['Installer et ouvrir Firefox', 'Passez par le téléchargement Android du site officiel de Firefox. Rouvrez ensuite ce guide et le lien de la boutique dans Firefox.'],
      ['Ajouter l’extension officielle', 'Ouvrez la fiche Firefox de NodeLane Comics ci-dessous. Choisissez Ajouter à Firefox, lisez les permissions et confirmez. Le menu ⋮ → Extensions permet aussi de les gérer.'],
      ['Ouvrir le lecteur et essayer', 'Sélectionnez NodeLane Comics dans ⋮ → Extensions de Firefox. Importez un petit fichier ou ajoutez un manga d’un site compatible en suivant les indications. Configurez la traduction au besoin.'],
      ['Installer et ouvrir Orion', 'Depuis la page officielle d’installation ci-dessous, rejoignez l’App Store et installez Orion Browser by Kagi. Rouvrez ce guide dans Orion, pas Safari.'],
      ['Activer les extensions Firefox', 'Dans Orion, ouvrez ••• → Settings → Extensions et activez Firefox. Ce guide utilise la version Firefox ; inutile d’activer aussi les extensions Chrome.'],
      ['Installer dans Orion', 'Ouvrez la fiche Firefox de NodeLane Comics dans Orion, ajoutez l’extension et confirmez. Si seul un fichier est téléchargé, vérifiez d’abord l’activation des extensions.'],
      ['Ouvrir depuis le menu Extensions', 'Choisissez NodeLane Comics dans ••• → Extensions, généralement en bas à droite sur iPhone et en haut à droite sur iPad. Testez la bibliothèque, un petit import et la traduction.'],
    ],
    troubleshooting: ['Bouton absent ? Ouvrez le lien dans Firefox et mettez-le à jour. Ne forcez pas une installation déclarée incompatible. Vérifiez l’activation et les permissions du site, puis rechargez. Essayez un onglet normal ; le mode privé exige une autorisation distincte.', 'Vérifiez l’activation des extensions Firefox dans Orion. Désactivez puis réactivez l’extension et mettez Orion à jour. Si le problème persiste, indiquez les versions du système, du navigateur et de l’extension avec les étapes de reproduction. La traduction d’images du site peut dépanner.'],
  },
  es: {
    label: 'Guía de instalación', placeholder: 'Captura pendiente', before: 'Antes de empezar', sources: 'Referencias oficiales',
    availability: 'Chrome, Edge o Firefox en el ordenador; Firefox en Android; Orion en iPhone / iPad. Los enlaces móviles son guías, no descargas de apps independientes.',
    titles: ['Lee manga en Android con Firefox', 'Empieza en iPhone y iPad con Orion'],
    descriptions: ['Instala Firefox, añade NodeLane Comics y abre el lector en Android con esta guía paso a paso.', 'Activa las extensiones de Orion e instala NodeLane Comics, con notas de compatibilidad para iOS / iPadOS.'],
    notices: ['Es una guía de extensiones, no un APK de NodeLane. Usa Firefox para Android actualizado; la tienda comprueba la compatibilidad. Firefox Focus no sirve para esta guía.', 'No es una app de NodeLane para iOS ni una extensión de Safari. El soporte de Orion está en beta. Instalar no garantiza que funcionen el acceso, la importación o la traducción; prueba primero con poco contenido.'],
    steps: [
      ['Instala y abre Firefox', 'Usa la descarga de Android en la web oficial de Firefox. Después, abre esta guía y el enlace de la tienda en Firefox.'],
      ['Añade la extensión oficial', 'Abre la ficha de NodeLane Comics en Firefox que aparece abajo. Pulsa Añadir a Firefox, revisa los permisos y confirma. También puedes gestionar extensiones desde ⋮ → Extensiones.'],
      ['Abre el lector y prueba un capítulo', 'Selecciona NodeLane Comics en ⋮ → Extensiones de Firefox. Importa un archivo pequeño o añade un manga de un sitio compatible siguiendo las indicaciones. Configura la traducción cuando la necesites.'],
      ['Instala y abre Orion', 'Desde la página oficial de instalación de Orion, ve a App Store e instala Orion Browser by Kagi. Abre esta guía en Orion, no en Safari.'],
      ['Activa las extensiones de Firefox', 'En Orion, abre ••• → Settings → Extensions y activa Firefox. Esta guía usa la versión de Firefox; no necesitas activar también Chrome.'],
      ['Instala la extensión en Orion', 'Abre la ficha de NodeLane Comics en la tienda de Firefox desde Orion, añade la extensión y confirma. Si solo descarga un archivo, revisa primero el ajuste de extensiones.'],
      ['Abre el lector desde Extensiones', 'Elige NodeLane Comics en ••• → Extensions de Orion, normalmente abajo a la derecha en iPhone y arriba a la derecha en iPad. Prueba la biblioteca, una importación pequeña y la traducción.'],
    ],
    troubleshooting: ['Si no aparece el botón, usa Firefox y actualízalo. No fuerces la instalación si la tienda indica incompatibilidad. Comprueba que la extensión esté activa y tenga permiso para el sitio; recarga. Prueba una pestaña normal: la navegación privada requiere permiso aparte.', 'Comprueba que Orion tenga activadas las extensiones de Firefox. Desactiva y reactiva la extensión y actualiza Orion. Si sigue fallando, comunica las versiones del sistema, navegador y extensión junto con los pasos para reproducirlo. Puedes usar temporalmente el traductor de imágenes web.'],
  },
  'pt-BR': {
    label: 'Guia de instalação', placeholder: 'Captura em breve', before: 'Antes de começar', sources: 'Referências oficiais',
    availability: 'Chrome, Edge ou Firefox no computador; Firefox no Android; Orion no iPhone / iPad. Os links móveis abrem guias, não downloads de aplicativos próprios.',
    titles: ['Leia mangás no Android com Firefox', 'Comece no iPhone e iPad com Orion'],
    descriptions: ['Instale o Firefox, adicione o NodeLane Comics e abra o leitor no Android, passo a passo.', 'Ative extensões no Orion e instale o NodeLane Comics, com observações de compatibilidade para iOS / iPadOS.'],
    notices: ['Este é um guia de extensão, não um APK do NodeLane. Use o Firefox para Android atualizado; a loja verifica a compatibilidade. O Firefox Focus não se aplica.', 'Não é um app NodeLane para iOS nem uma extensão do Safari. O suporte do Orion está em beta. Instalar não garante login, importação ou tradução; teste primeiro com pouco conteúdo.'],
    steps: [
      ['Instale e abra o Firefox', 'Use o download para Android no site oficial do Firefox. Depois, reabra este guia e o link da loja no Firefox.'],
      ['Adicione a extensão oficial', 'Abra a página do NodeLane Comics na loja Firefox abaixo. Toque em Adicionar ao Firefox, confira as permissões e confirme. O menu ⋮ → Extensões também permite gerenciá-las.'],
      ['Abra o leitor e experimente', 'Escolha NodeLane Comics em ⋮ → Extensões no Firefox. Importe um arquivo pequeno ou adicione um mangá de um site compatível seguindo as instruções. Configure a tradução quando precisar.'],
      ['Instale e abra o Orion', 'Acesse a App Store pela página oficial de instalação abaixo e instale Orion Browser by Kagi. Reabra este guia no Orion, não no Safari.'],
      ['Ative as extensões Firefox', 'No Orion, abra ••• → Settings → Extensions e ative Firefox. O guia usa a versão da loja Firefox; não é preciso ativar também Chrome.'],
      ['Instale a extensão no Orion', 'Abra a página Firefox do NodeLane Comics no Orion, adicione a extensão e confirme. Se apenas baixar um arquivo, confira primeiro se o suporte a extensões está ativo.'],
      ['Abra pelo menu de extensões', 'Escolha NodeLane Comics em ••• → Extensions no Orion, normalmente no canto inferior direito no iPhone e superior direito no iPad. Teste a biblioteca, uma pequena importação e a tradução.'],
    ],
    troubleshooting: ['Sem botão? Abra no Firefox e atualize o navegador. Não force uma instalação incompatível. Verifique se a extensão está ativa e tem acesso ao site, depois recarregue. Teste em aba normal; a navegação privativa exige autorização separada.', 'Confira o suporte Firefox no Orion. Desative e reative a extensão e atualize o Orion. Se persistir, informe as versões do sistema, navegador e extensão e os passos para reproduzir. O tradutor de imagens do site é uma alternativa temporária.'],
  },
  de: {
    label: 'Installationsanleitung', placeholder: 'Screenshot folgt', before: 'Vor dem Start', sources: 'Offizielle Quellen',
    availability: 'Am Computer: Chrome, Edge oder Firefox. Auf Android: Firefox. Auf iPhone / iPad: Orion. Mobile Links öffnen Anleitungen, keine eigenständigen Apps.',
    titles: ['Comics auf Android mit Firefox lesen', 'Auf iPhone und iPad mit Orion starten'],
    descriptions: ['Firefox installieren, NodeLane Comics hinzufügen und den Reader auf Android öffnen – Schritt für Schritt.', 'Erweiterungen in Orion aktivieren und NodeLane Comics installieren, mit Hinweisen zur Kompatibilität unter iOS / iPadOS.'],
    notices: ['Dies ist eine Anleitung für eine Browser-Erweiterung, keine NodeLane-APK. Nutze aktuelles Firefox für Android; der Store prüft die Kompatibilität. Firefox Focus ist nicht geeignet.', 'Keine NodeLane-iOS-App und keine Safari-Erweiterung. Orions Erweiterungsunterstützung ist in der Beta. Eine Installation bestätigt nicht, dass Anmeldung, Import oder Übersetzung funktionieren. Teste zuerst mit wenig Inhalt.'],
    steps: [
      ['Firefox installieren und öffnen', 'Nutze den Android-Download auf der offiziellen Firefox-Seite. Öffne danach diese Anleitung und den Store-Link in Firefox.'],
      ['Offizielle Erweiterung hinzufügen', 'Öffne unten den Firefox-Eintrag von NodeLane Comics. Wähle Zu Firefox hinzufügen, prüfe die Berechtigungen und bestätige. Unter ⋮ → Erweiterungen findest du die Verwaltung.'],
      ['Reader öffnen und ausprobieren', 'Wähle NodeLane Comics unter ⋮ → Erweiterungen in Firefox. Importiere eine kleine Datei oder füge einen Comic einer unterstützten Website nach den Hinweisen hinzu. Richte Übersetzung bei Bedarf ein.'],
      ['Orion installieren und öffnen', 'Folge der offiziellen Orion-Installationsseite zum App Store und installiere Orion Browser by Kagi. Öffne diese Anleitung in Orion, nicht in Safari.'],
      ['Firefox-Erweiterungen aktivieren', 'Öffne in Orion ••• → Settings → Extensions und aktiviere Firefox. Diese Anleitung nutzt die Firefox-Version; Chrome muss nicht zusätzlich aktiviert werden.'],
      ['Erweiterung in Orion installieren', 'Öffne den Firefox-Store-Eintrag in Orion, füge NodeLane Comics hinzu und bestätige. Wird nur eine Datei heruntergeladen, prüfe zuerst die Erweiterungseinstellung.'],
      ['Reader im Erweiterungsmenü öffnen', 'Wähle NodeLane Comics unter ••• → Extensions, auf dem iPhone meist unten rechts, auf dem iPad oben rechts. Teste Bibliothek, kleinen Import und Übersetzung vor längerer Nutzung.'],
    ],
    troubleshooting: ['Kein Installationsknopf? Öffne den Link in Firefox und aktualisiere den Browser. Erzwinge keine inkompatible Installation. Prüfe Aktivierung und Website-Zugriff und lade neu. Teste zuerst im normalen Tab; privates Surfen benötigt eine eigene Erlaubnis.', 'Prüfe die Firefox-Unterstützung in Orion. Deaktiviere und aktiviere die Erweiterung und aktualisiere Orion. Melde bei weiteren Problemen System-, Browser- und Erweiterungsversion samt Schritten. Die Bildübersetzung auf der Website ist eine vorübergehende Alternative.'],
  },
  it: {
    label: 'Guida all’installazione', placeholder: 'Schermata in arrivo', before: 'Prima di iniziare', sources: 'Fonti ufficiali',
    availability: 'Chrome, Edge o Firefox su computer; Firefox su Android; Orion su iPhone / iPad. I link mobili aprono guide, non app autonome.',
    titles: ['Leggi manga su Android con Firefox', 'Inizia su iPhone e iPad con Orion'],
    descriptions: ['Installa Firefox, aggiungi NodeLane Comics e apri il lettore su Android con questa guida passo passo.', 'Abilita le estensioni in Orion e installa NodeLane Comics, con note sulla compatibilità iOS / iPadOS.'],
    notices: ['È una guida per un’estensione, non un APK NodeLane. Usa Firefox per Android aggiornato; lo store verifica la compatibilità. Firefox Focus non è adatto.', 'Non è un’app NodeLane per iOS né un’estensione Safari. Il supporto di Orion è in beta. L’installazione non garantisce accesso, importazione o traduzione: prova prima pochi contenuti.'],
    steps: [
      ['Installa e apri Firefox', 'Usa il download Android sul sito ufficiale Firefox. Poi riapri questa guida e il link allo store in Firefox.'],
      ['Aggiungi l’estensione ufficiale', 'Apri la scheda Firefox di NodeLane Comics qui sotto. Scegli Aggiungi a Firefox, controlla i permessi e conferma. Puoi gestirla da ⋮ → Estensioni.'],
      ['Apri il lettore e prova', 'Seleziona NodeLane Comics in ⋮ → Estensioni di Firefox. Importa un file piccolo o aggiungi un manga da un sito supportato seguendo le indicazioni. Configura la traduzione se serve.'],
      ['Installa e apri Orion', 'Dalla pagina ufficiale di installazione vai all’App Store e installa Orion Browser by Kagi. Riapri la guida in Orion, non in Safari.'],
      ['Abilita le estensioni Firefox', 'In Orion apri ••• → Settings → Extensions e abilita Firefox. Questa guida usa la versione Firefox; non occorre abilitare anche Chrome.'],
      ['Installa l’estensione in Orion', 'Apri la scheda Firefox di NodeLane Comics dentro Orion, aggiungi l’estensione e conferma. Se viene solo scaricato un file, controlla prima il supporto alle estensioni.'],
      ['Apri dal menu Estensioni', 'Scegli NodeLane Comics in ••• → Extensions, di solito in basso a destra su iPhone e in alto a destra su iPad. Prova libreria, piccola importazione e traduzione.'],
    ],
    troubleshooting: ['Manca il pulsante? Apri in Firefox e aggiornalo. Non forzare un’installazione incompatibile. Controlla attivazione e permessi del sito, poi ricarica. Prova una scheda normale: la navigazione privata richiede un consenso distinto.', 'Controlla il supporto Firefox in Orion, disattiva e riattiva l’estensione e aggiorna Orion. Se persiste, invia versioni di sistema, browser ed estensione e passaggi di riproduzione. Il traduttore di immagini web è un’alternativa temporanea.'],
  },
  ru: {
    label: 'Инструкция', placeholder: 'Скриншот появится позже', before: 'Перед началом', sources: 'Официальные материалы',
    availability: 'На компьютере — Chrome, Edge или Firefox; на Android — Firefox; на iPhone / iPad — Orion. Мобильные ссылки ведут к инструкциям, а не отдельным приложениям.',
    titles: ['Читайте мангу на Android через Firefox', 'Начните чтение на iPhone и iPad через Orion'],
    descriptions: ['Пошаговая установка Firefox и NodeLane Comics и запуск читалки на Android.', 'Включение расширений Orion и установка NodeLane Comics с примечаниями о совместимости iOS / iPadOS.'],
    notices: ['Это инструкция для расширения, а не APK NodeLane. Используйте актуальный Firefox для Android: магазин проверит совместимость. Firefox Focus не подходит.', 'Это не приложение NodeLane для iOS и не расширение Safari. Поддержка расширений Orion находится в бета-версии. Установка не гарантирует работу входа, импорта и перевода — сначала проверьте небольшой объём.'],
    steps: [
      ['Установите и откройте Firefox', 'Скачайте Android-версию с официальной страницы Firefox. Затем откройте эту инструкцию и ссылку магазина в Firefox.'],
      ['Добавьте официальное расширение', 'Откройте страницу NodeLane Comics в магазине Firefox ниже. Нажмите «Добавить в Firefox», изучите разрешения и подтвердите. Управление доступно в ⋮ → Расширения.'],
      ['Откройте читалку и попробуйте', 'Выберите NodeLane Comics в меню Firefox ⋮ → Расширения. Импортируйте небольшой файл или добавьте мангу с поддерживаемого сайта по подсказкам. Настройте перевод при необходимости.'],
      ['Установите и откройте Orion', 'Перейдите в App Store по официальной инструкции Orion и установите Orion Browser by Kagi. Откройте это руководство в Orion, не Safari.'],
      ['Включите расширения Firefox', 'В Orion откройте ••• → Settings → Extensions и включите Firefox. Здесь используется версия из Firefox; включать Chrome дополнительно не нужно.'],
      ['Установите расширение в Orion', 'Откройте страницу NodeLane Comics в магазине Firefox через Orion, добавьте расширение и подтвердите. Если лишь скачался файл, сначала проверьте настройку поддержки расширений.'],
      ['Запустите из меню расширений', 'Выберите NodeLane Comics в ••• → Extensions: обычно справа внизу на iPhone и справа вверху на iPad. Проверьте библиотеку, небольшой импорт и перевод.'],
    ],
    troubleshooting: ['Нет кнопки установки? Откройте ссылку в Firefox и обновите браузер. Не обходите предупреждение о несовместимости. Проверьте включение расширения и доступ к сайту, затем обновите страницу. Начните с обычной вкладки; приватный режим требует отдельного разрешения.', 'Проверьте поддержку Firefox в Orion. Отключите и включите расширение, обновите Orion. Если ошибка остаётся, сообщите версии ОС, браузера и расширения и шаги воспроизведения. Временно можно использовать перевод изображений на сайте.'],
  },
  pl: {
    label: 'Instrukcja instalacji', placeholder: 'Zrzut ekranu wkrótce', before: 'Zanim zaczniesz', sources: 'Oficjalne źródła',
    availability: 'Na komputerze Chrome, Edge lub Firefox; na Androidzie Firefox; na iPhonie / iPadzie Orion. Linki mobilne prowadzą do instrukcji, nie do osobnych aplikacji.',
    titles: ['Czytaj mangę na Androidzie w Firefoksie', 'Zacznij na iPhonie i iPadzie z Orionem'],
    descriptions: ['Zainstaluj Firefoksa, dodaj NodeLane Comics i otwórz czytnik na Androidzie krok po kroku.', 'Włącz rozszerzenia w Orionie i zainstaluj NodeLane Comics z uwagami o zgodności z iOS / iPadOS.'],
    notices: ['To instrukcja rozszerzenia, nie plik APK NodeLane. Użyj aktualnego Firefoksa na Androida; sklep sprawdzi zgodność. Firefox Focus nie jest odpowiedni.', 'To nie aplikacja NodeLane na iOS ani rozszerzenie Safari. Obsługa rozszerzeń Oriona jest w fazie beta. Instalacja nie gwarantuje logowania, importu ani tłumaczenia — sprawdź najpierw małą próbkę.'],
    steps: [
      ['Zainstaluj i otwórz Firefoksa', 'Skorzystaj z pobierania na Androida na oficjalnej stronie Firefoksa. Otwórz ponownie tę instrukcję i link sklepu w Firefoksie.'],
      ['Dodaj oficjalne rozszerzenie', 'Otwórz poniższą stronę NodeLane Comics w sklepie Firefox. Wybierz Dodaj do Firefoksa, sprawdź uprawnienia i potwierdź. Zarządzanie znajdziesz w ⋮ → Rozszerzenia.'],
      ['Otwórz czytnik i wypróbuj', 'Wybierz NodeLane Comics w ⋮ → Rozszerzenia. Zaimportuj mały plik lub dodaj mangę z obsługiwanej strony według wskazówek. Skonfiguruj tłumaczenie, gdy będzie potrzebne.'],
      ['Zainstaluj i otwórz Oriona', 'Przejdź z oficjalnej strony instalacji Oriona do App Store i zainstaluj Orion Browser by Kagi. Otwórz poradnik w Orionie, nie w Safari.'],
      ['Włącz rozszerzenia Firefox', 'W Orionie otwórz ••• → Settings → Extensions i włącz Firefox. Korzystamy z wersji Firefox; nie trzeba dodatkowo włączać Chrome.'],
      ['Zainstaluj rozszerzenie w Orionie', 'Otwórz stronę NodeLane Comics w sklepie Firefox przez Oriona, dodaj rozszerzenie i potwierdź. Jeśli pobiera się tylko plik, sprawdź najpierw obsługę rozszerzeń.'],
      ['Otwórz z menu rozszerzeń', 'Wybierz NodeLane Comics w ••• → Extensions, zwykle na dole po prawej na iPhonie, u góry po prawej na iPadzie. Przetestuj bibliotekę, mały import i tłumaczenie.'],
    ],
    troubleshooting: ['Brak przycisku? Otwórz w Firefoksie i zaktualizuj go. Nie wymuszaj niezgodnej instalacji. Sprawdź włączenie rozszerzenia i dostęp do witryny, potem odśwież. Użyj zwykłej karty; tryb prywatny wymaga osobnej zgody.', 'Sprawdź obsługę Firefox w Orionie. Wyłącz i włącz rozszerzenie oraz zaktualizuj Oriona. Jeśli problem trwa, podaj wersje systemu, przeglądarki i rozszerzenia oraz kroki odtworzenia. Tymczasowo możesz tłumaczyć obrazy na stronie.'],
  },
  uk: {
    label: 'Посібник зі встановлення', placeholder: 'Знімок екрана згодом', before: 'Перед початком', sources: 'Офіційні джерела',
    availability: 'На комп’ютері — Chrome, Edge або Firefox; на Android — Firefox; на iPhone / iPad — Orion. Мобільні посилання відкривають посібники, а не окремі застосунки.',
    titles: ['Читайте манґу на Android через Firefox', 'Почніть читати на iPhone та iPad через Orion'],
    descriptions: ['Покрокове встановлення Firefox і NodeLane Comics та відкриття читача на Android.', 'Увімкніть розширення Orion та встановіть NodeLane Comics з урахуванням сумісності iOS / iPadOS.'],
    notices: ['Це посібник для розширення, не APK NodeLane. Використовуйте оновлений Firefox для Android; магазин перевіряє сумісність. Firefox Focus не підходить.', 'Це не застосунок NodeLane для iOS і не розширення Safari. Підтримка Orion перебуває в бета-версії. Встановлення не гарантує роботу входу, імпорту чи перекладу — спочатку перевірте невеликий обсяг.'],
    steps: [
      ['Встановіть і відкрийте Firefox', 'Завантажте Android-версію з офіційної сторінки Firefox. Потім відкрийте цей посібник і посилання магазину у Firefox.'],
      ['Додайте офіційне розширення', 'Відкрийте сторінку NodeLane Comics у магазині Firefox нижче. Натисніть «Додати до Firefox», перегляньте дозволи й підтвердьте. Керування доступне в ⋮ → Розширення.'],
      ['Відкрийте читач і спробуйте', 'Виберіть NodeLane Comics у ⋮ → Розширення Firefox. Імпортуйте невеликий файл або додайте манґу з підтримуваного сайту за підказками. Налаштуйте переклад за потреби.'],
      ['Встановіть і відкрийте Orion', 'З офіційної сторінки встановлення Orion перейдіть до App Store й встановіть Orion Browser by Kagi. Відкрийте посібник в Orion, не Safari.'],
      ['Увімкніть розширення Firefox', 'В Orion відкрийте ••• → Settings → Extensions і ввімкніть Firefox. Тут використовується версія Firefox; Chrome додатково вмикати не потрібно.'],
      ['Встановіть розширення в Orion', 'Відкрийте сторінку NodeLane Comics у магазині Firefox через Orion, додайте й підтвердьте. Якщо лише завантажується файл, спочатку перевірте підтримку розширень.'],
      ['Відкрийте з меню розширень', 'Виберіть NodeLane Comics у ••• → Extensions: зазвичай унизу праворуч на iPhone й угорі праворуч на iPad. Перевірте бібліотеку, малий імпорт і переклад.'],
    ],
    troubleshooting: ['Немає кнопки? Відкрийте посилання у Firefox та оновіть його. Не примушуйте несумісне встановлення. Перевірте ввімкнення та доступ до сайту й оновіть сторінку. Почніть зі звичайної вкладки; приватний режим потребує окремого дозволу.', 'Перевірте підтримку Firefox в Orion. Вимкніть і ввімкніть розширення, оновіть Orion. Якщо помилка лишилася, повідомте версії ОС, браузера й розширення та кроки відтворення. Тимчасова альтернатива — переклад зображень на сайті.'],
  },
  tr: {
    label: 'Kurulum rehberi', placeholder: 'Ekran görüntüsü eklenecek', before: 'Başlamadan önce', sources: 'Resmî kaynaklar',
    availability: 'Bilgisayarda Chrome, Edge veya Firefox; Android’de Firefox; iPhone / iPad’de Orion kullanın. Mobil bağlantılar bağımsız uygulama değil, kurulum rehberidir.',
    titles: ['Android’de Firefox ile manga okuyun', 'iPhone ve iPad’de Orion ile başlayın'],
    descriptions: ['Firefox’u yükleyin, NodeLane Comics’i ekleyin ve Android’de okuyucuyu adım adım açın.', 'Orion’da uzantıları etkinleştirip NodeLane Comics’i kurun; iOS / iPadOS uyumluluk notlarını inceleyin.'],
    notices: ['Bu bir uzantı rehberidir, NodeLane APK’sı değildir. Güncel Android Firefox kullanın; mağaza sürüm uyumluluğunu denetler. Firefox Focus uygun değildir.', 'NodeLane iOS uygulaması veya Safari uzantısı değildir. Orion uzantı desteği beta aşamasındadır. Kurulum; giriş, içe aktarma veya çevirinin çalıştığını kanıtlamaz. Önce az içerikle deneyin.'],
    steps: [
      ['Firefox’u yükleyip açın', 'Firefox’un resmî sayfasındaki Android indirmesini kullanın. Ardından bu rehberi ve mağaza bağlantısını Firefox’ta açın.'],
      ['Resmî uzantıyı ekleyin', 'Aşağıdaki NodeLane Comics Firefox mağaza sayfasını açın. Firefox’a ekle seçeneğine dokunun, izinleri okuyup onaylayın. Yönetim için ⋮ → Uzantılar menüsünü kullanabilirsiniz.'],
      ['Okuyucuyu açıp deneyin', 'Firefox’ta ⋮ → Uzantılar menüsünden NodeLane Comics’i seçin. Küçük bir dosya alın veya desteklenen siteden yönergelerle manga ekleyin. Gerektiğinde çeviriyi ayarlayın.'],
      ['Orion’u yükleyip açın', 'Resmî Orion kurulum sayfasından App Store’a giderek Orion Browser by Kagi’yi yükleyin. Rehberi Safari yerine Orion’da açın.'],
      ['Firefox uzantılarını etkinleştirin', 'Orion’da ••• → Settings → Extensions yolunda Firefox’u açın. Bu rehber Firefox sürümünü kullanır; Chrome desteğini ayrıca açmanız gerekmez.'],
      ['Uzantıyı Orion’a kurun', 'NodeLane Comics’in Firefox mağaza sayfasını Orion’da açın, uzantıyı ekleyip onaylayın. Yalnızca dosya iniyorsa önce uzantı desteğini kontrol edin.'],
      ['Uzantılar menüsünden açın', '••• → Extensions menüsünde NodeLane Comics’i seçin. Menü genellikle iPhone’da sağ altta, iPad’de sağ üsttedir. Önce kitaplığı, küçük bir içe aktarmayı ve çeviriyi deneyin.'],
    ],
    troubleshooting: ['Kurulum düğmesi yoksa Firefox’ta açıp tarayıcıyı güncelleyin. Uyumsuz kurulumu zorlamayın. Uzantının ve site erişiminin açık olduğunu kontrol edip yenileyin. Önce normal sekmede deneyin; gizli gezinme ayrı izin gerektirir.', 'Orion’da Firefox desteğini kontrol edin. Uzantıyı kapatıp açın ve Orion’u güncelleyin. Sorun sürerse sistem, tarayıcı ve uzantı sürümlerini tekrarlama adımlarıyla bildirin. Geçici olarak web görsel çevirisini kullanabilirsiniz.'],
  },
  vi: {
    label: 'Hướng dẫn cài đặt', placeholder: 'Sẽ bổ sung ảnh chụp', before: 'Trước khi bắt đầu', sources: 'Tài liệu chính thức',
    availability: 'Máy tính dùng Chrome, Edge hoặc Firefox; Android dùng Firefox; iPhone / iPad dùng Orion. Liên kết di động mở hướng dẫn, không tải ứng dụng riêng.',
    titles: ['Đọc truyện trên Android bằng Firefox', 'Bắt đầu trên iPhone và iPad bằng Orion'],
    descriptions: ['Từng bước cài Firefox, thêm NodeLane Comics và mở trình đọc trên Android.', 'Bật tiện ích trong Orion, cài NodeLane Comics và xem lưu ý tương thích iOS / iPadOS.'],
    notices: ['Đây là hướng dẫn tiện ích trình duyệt, không phải APK NodeLane. Dùng Firefox Android mới nhất; cửa hàng kiểm tra phiên bản tương thích. Không áp dụng cho Firefox Focus.', 'Đây không phải ứng dụng NodeLane iOS hay tiện ích Safari. Hỗ trợ tiện ích của Orion đang ở bản beta. Cài được chưa chứng minh đăng nhập, nhập tệp hay dịch hoạt động; hãy thử ít nội dung trước.'],
    steps: [
      ['Cài và mở Firefox', 'Dùng mục tải Android trên trang Firefox chính thức. Sau đó mở lại hướng dẫn này và liên kết cửa hàng trong Firefox.'],
      ['Thêm tiện ích chính thức', 'Mở trang NodeLane Comics trên cửa hàng Firefox bên dưới. Chọn Thêm vào Firefox, đọc quyền và xác nhận. Có thể quản lý qua ⋮ → Tiện ích.'],
      ['Mở trình đọc và thử', 'Chọn NodeLane Comics trong ⋮ → Tiện ích của Firefox. Nhập tệp nhỏ hoặc thêm truyện từ trang được hỗ trợ theo hướng dẫn của tiện ích. Cấu hình dịch khi cần.'],
      ['Cài và mở Orion', 'Từ trang cài đặt Orion chính thức, đến App Store và cài Orion Browser by Kagi. Mở lại hướng dẫn bằng Orion, không phải Safari.'],
      ['Bật tiện ích Firefox', 'Trong Orion, mở ••• → Settings → Extensions và bật Firefox. Hướng dẫn dùng bản Firefox, không cần bật thêm Chrome.'],
      ['Cài tiện ích trong Orion', 'Mở trang cửa hàng Firefox của NodeLane Comics trong Orion, thêm và xác nhận. Nếu chỉ tải tệp mà không cài, hãy kiểm tra hỗ trợ tiện ích đã bật.'],
      ['Mở từ menu tiện ích', 'Chọn NodeLane Comics trong ••• → Extensions, thường ở dưới bên phải trên iPhone, trên bên phải trên iPad. Thử thư viện, nhập tệp nhỏ và dịch trước.'],
    ],
    troubleshooting: ['Không có nút cài? Mở bằng Firefox và cập nhật trình duyệt. Không ép cài nếu cửa hàng báo không tương thích. Kiểm tra tiện ích đã bật và được truy cập trang rồi tải lại. Thử thẻ thường trước; chế độ riêng tư cần cho phép riêng.', 'Kiểm tra hỗ trợ Firefox trong Orion. Tắt rồi bật lại tiện ích và cập nhật Orion. Nếu vẫn lỗi, gửi phiên bản hệ điều hành, trình duyệt, tiện ích và bước tái hiện. Có thể tạm dùng dịch ảnh trên website.'],
  },
  id: {
    label: 'Panduan pemasangan', placeholder: 'Tangkapan layar menyusul', before: 'Sebelum memulai', sources: 'Referensi resmi',
    availability: 'Gunakan Chrome, Edge atau Firefox di komputer; Firefox di Android; Orion di iPhone / iPad. Tautan seluler membuka panduan, bukan aplikasi tersendiri.',
    titles: ['Baca manga di Android dengan Firefox', 'Mulai di iPhone dan iPad dengan Orion'],
    descriptions: ['Pasang Firefox, tambahkan NodeLane Comics dan buka pembaca di Android langkah demi langkah.', 'Aktifkan ekstensi di Orion dan pasang NodeLane Comics, dengan catatan kompatibilitas iOS / iPadOS.'],
    notices: ['Ini panduan ekstensi, bukan APK NodeLane. Gunakan Firefox Android terbaru; toko memeriksa kompatibilitas versi. Firefox Focus tidak sesuai untuk panduan ini.', 'Ini bukan aplikasi NodeLane iOS atau ekstensi Safari. Dukungan Orion masih beta. Pemasangan tidak menjamin login, impor atau terjemahan berfungsi; uji sedikit konten dahulu.'],
    steps: [
      ['Pasang dan buka Firefox', 'Gunakan unduhan Android dari situs resmi Firefox. Lalu buka kembali panduan dan tautan toko ini di Firefox.'],
      ['Tambahkan ekstensi resmi', 'Buka halaman NodeLane Comics di toko Firefox di bawah. Pilih Tambahkan ke Firefox, periksa izin dan konfirmasi. Kelola ekstensi melalui ⋮ → Ekstensi.'],
      ['Buka pembaca dan coba', 'Pilih NodeLane Comics di ⋮ → Ekstensi Firefox. Impor berkas kecil atau tambahkan manga dari situs yang didukung sesuai petunjuk. Atur terjemahan saat diperlukan.'],
      ['Pasang dan buka Orion', 'Ikuti halaman pemasangan resmi Orion ke App Store dan pasang Orion Browser by Kagi. Buka panduan ini di Orion, bukan Safari.'],
      ['Aktifkan ekstensi Firefox', 'Di Orion, buka ••• → Settings → Extensions dan aktifkan Firefox. Panduan memakai versi Firefox; dukungan Chrome tidak perlu diaktifkan juga.'],
      ['Pasang ekstensi di Orion', 'Buka halaman toko Firefox NodeLane Comics melalui Orion, tambahkan ekstensi dan konfirmasi. Jika hanya berkas yang terunduh, periksa dukungan ekstensi dahulu.'],
      ['Buka melalui menu ekstensi', 'Pilih NodeLane Comics di ••• → Extensions, biasanya kanan bawah di iPhone dan kanan atas di iPad. Uji pustaka, impor kecil dan terjemahan dahulu.'],
    ],
    troubleshooting: ['Tidak ada tombol? Buka di Firefox dan perbarui peramban. Jangan paksa pemasangan yang tidak kompatibel. Periksa ekstensi aktif dan izin situs, lalu muat ulang. Uji tab biasa; mode privat memerlukan izin terpisah.', 'Periksa dukungan Firefox di Orion. Nonaktifkan lalu aktifkan ekstensi dan perbarui Orion. Jika tetap gagal, laporkan versi sistem, peramban dan ekstensi beserta langkah reproduksi. Penerjemah gambar web dapat dipakai sementara.'],
  },
  ar: {
    label: 'دليل التثبيت', placeholder: 'ستُضاف لقطة الشاشة لاحقًا', before: 'قبل البدء', sources: 'المراجع الرسمية',
    availability: 'استخدم Chrome أو Edge أو Firefox على الكمبيوتر، وFirefox على Android، وOrion على iPhone / iPad. روابط الهاتف أدلة إعداد وليست تنزيلات لتطبيق مستقل.',
    titles: ['اقرأ المانغا على Android باستخدام Firefox', 'ابدأ القراءة على iPhone وiPad باستخدام Orion'],
    descriptions: ['ثبّت Firefox وأضف NodeLane Comics وافتح القارئ على Android خطوة بخطوة.', 'فعّل الإضافات في Orion وثبّت NodeLane Comics مع ملاحظات التوافق مع iOS / iPadOS.'],
    notices: ['هذا دليل لإضافة متصفح وليس ملف APK لـ NodeLane. استخدم Firefox المحدّث على Android؛ يتحقق المتجر من توافق الإصدار. لا ينطبق الدليل على Firefox Focus.', 'ليس تطبيق NodeLane لنظام iOS ولا إضافة Safari. دعم إضافات Orion تجريبي. نجاح التثبيت لا يضمن تسجيل الدخول أو الاستيراد أو الترجمة؛ جرّب محتوى قليلًا أولًا.'],
    steps: [
      ['ثبّت Firefox وافتحه', 'استخدم تنزيل Android من موقع Firefox الرسمي. ثم أعد فتح هذا الدليل ورابط المتجر داخل Firefox.'],
      ['أضف الإضافة الرسمية', 'افتح صفحة NodeLane Comics في متجر Firefox أدناه. اختر الإضافة إلى Firefox وراجع الأذونات ثم أكّد. يمكنك إدارتها من قائمة ⋮ ثم الإضافات.'],
      ['افتح القارئ وجرّب', 'اختر NodeLane Comics من قائمة الإضافات في Firefox. استورد ملفًا صغيرًا أو أضف مانغا من موقع مدعوم باتباع الإرشادات. اضبط الترجمة عند الحاجة.'],
      ['ثبّت Orion وافتحه', 'انتقل من صفحة تثبيت Orion الرسمية إلى App Store وثبّت Orion Browser by Kagi. افتح هذا الدليل في Orion وليس Safari.'],
      ['فعّل إضافات Firefox', 'افتح قائمة ••• ثم Settings ثم Extensions في Orion وفعّل Firefox. يستخدم الدليل إصدار متجر Firefox؛ لا حاجة إلى تفعيل Chrome أيضًا.'],
      ['ثبّت الإضافة في Orion', 'افتح صفحة NodeLane Comics في متجر Firefox داخل Orion، وأضفها وأكّد التعليمات. إذا نُزّل ملف فقط، فتحقق أولًا من تفعيل دعم الإضافات.'],
      ['افتح القارئ من الإضافات', 'اختر NodeLane Comics من ••• ثم Extensions، عادة أسفل اليمين على iPhone وأعلى اليمين على iPad. اختبر المكتبة واستيرادًا صغيرًا والترجمة قبل جلسة طويلة.'],
    ],
    troubleshooting: ['لا يظهر زر التثبيت؟ افتح الرابط في Firefox وحدّثه. لا تفرض تثبيت إصدار غير متوافق. تحقق من تفعيل الإضافة وأذونات الموقع ثم أعد التحميل. جرّب تبويبًا عاديًا؛ التصفح الخاص يحتاج إذنًا منفصلًا.', 'تحقق من دعم Firefox في Orion. عطّل الإضافة ثم فعّلها وحدّث Orion. إذا استمر العطل، أرسل إصدارات النظام والمتصفح والإضافة وخطوات إعادة المشكلة. يمكنك استخدام مترجم الصور على الموقع مؤقتًا.'],
  },
};

export function mobileGuides(locale: Locale, ui: UI): Guide[] {
  const copy = mobileCopy[locale];
  return mobilePlatforms.map((platform, platformIndex) => {
    const steps = platform.id === 'android' ? copy.steps.slice(0, 3) : copy.steps.slice(3);
    return {
      slug: platform.slug, title: copy.titles[platformIndex], description: copy.descriptions[platformIndex],
      category: `${platform.name} · ${platform.browser}`, minutes: platform.id === 'android' ? 3 : 4,
      published: '2026-10-08', updated: '2026-10-08',
      related: [mobilePlatforms[1 - platformIndex].slug, 'manga-translation', 'translation-troubleshooting'],
      sections: [
        { title: copy.before, paragraphs: [copy.notices[platformIndex]] },
        ...steps.map(([title, body], index) => ({
          title: `${index + 1}. ${title}`, paragraphs: [body],
          screenshot: { id: `${platform.id}-${index + 1}`, label: copy.placeholder, caption: `${platform.browser} · ${title}` },
          ...(index === 0 ? { links: [{ label: `${platform.browser} ↗`, href: platform.browserUrl }] } :
            index === (platform.id === 'android' ? 1 : 2) ? { links: [{ label: 'NodeLane Comics · Firefox Add-ons ↗', href: site.stores.firefox }] } : {}),
        })),
        { title: ui.faq, paragraphs: [copy.troubleshooting[platformIndex]], links: [{ label: ui.help, href: '/help/' }, { label: ui.guides, href: '/guides/manga-translation/' }, { label: translationCopy[locale].open, href: '/translate/' }] },
        { title: copy.sources, paragraphs: [copy.availability], links: [{ label: `${platform.browser} · ${copy.label} ↗`, href: platform.sourceUrl }] },
      ],
    };
  });
}
