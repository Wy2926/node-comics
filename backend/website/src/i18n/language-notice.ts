import type {Locale} from './types';
interface Copy {title:string;message:string;switch:string;dismiss:string}
export const languageNoticeCopy:Record<Locale,Copy> = {
  ar:{title:'هل تفضّل قراءة هذه الصفحة بالعربية؟',message:'نقترحها بناءً على لغة متصفحك. ستبقى في الصفحة نفسها بعد التبديل.',switch:'التبديل إلى العربية',dismiss:'ليس الآن'},
  'zh-CN':{title:'要用简体中文浏览吗？',message:'根据你的浏览器语言推荐。切换后仍会打开当前内容。',switch:'切换到简体中文',dismiss:'暂不切换'},
  'zh-TW':{title:'要用繁體中文瀏覽嗎？',message:'根據你的瀏覽器語言推薦。切換後仍會開啟目前的內容。',switch:'切換到繁體中文',dismiss:'暫不切換'},
  en:{title:'Prefer to read in English?',message:'Suggested based on your browser language. You’ll stay on the same page when you switch.',switch:'Switch to English',dismiss:'Not now'},
  ja:{title:'日本語で表示しますか？',message:'ブラウザーの言語設定に合わせたご案内です。切り替えても、同じページを表示します。',switch:'日本語に切り替える',dismiss:'今は切り替えない'},
  ko:{title:'한국어로 보시겠어요?',message:'브라우저 언어 설정에 맞춰 추천해요. 언어를 바꿔도 같은 페이지가 열려요.',switch:'한국어로 전환',dismiss:'나중에'},
  fr:{title:'Vous préférez lire en français ?',message:'Suggestion basée sur la langue de votre navigateur. Vous resterez sur la même page.',switch:'Passer au français',dismiss:'Pas maintenant'},
  es:{title:'¿Prefieres leer en español?',message:'Te lo sugerimos según el idioma de tu navegador. Seguirás en la misma página al cambiar.',switch:'Cambiar a español',dismiss:'Ahora no'},
  'pt-BR':{title:'Prefere ler em português?',message:'Sugestão baseada no idioma do seu navegador. Você continuará na mesma página ao mudar.',switch:'Mudar para português',dismiss:'Agora não'},
  de:{title:'Lieber auf Deutsch lesen?',message:'Passend zu deiner Browsersprache vorgeschlagen. Du bleibst beim Wechsel auf derselben Seite.',switch:'Auf Deutsch wechseln',dismiss:'Nicht jetzt'},
  it:{title:'Preferisci leggere in italiano?',message:'Te lo suggeriamo in base alla lingua del browser. Cambiando lingua resterai sulla stessa pagina.',switch:'Passa all’italiano',dismiss:'Non ora'},
  ru:{title:'Удобнее читать по-русски?',message:'Предлагаем этот язык на основе настроек браузера. При переключении вы останетесь на той же странице.',switch:'Перейти на русский',dismiss:'Не сейчас'},
  pl:{title:'Wolisz czytać po polsku?',message:'Proponujemy ten język na podstawie ustawień przeglądarki. Po zmianie pozostaniesz na tej samej stronie.',switch:'Przełącz na polski',dismiss:'Nie teraz'},
  uk:{title:'Зручніше читати українською?',message:'Пропонуємо цю мову на основі налаштувань браузера. Після перемикання ви залишитеся на тій самій сторінці.',switch:'Перейти на українську',dismiss:'Не зараз'},
  tr:{title:'Türkçe okumak ister misiniz?',message:'Tarayıcınızın dil ayarına göre öneriyoruz. Dil değiştiğinde aynı sayfada kalırsınız.',switch:'Türkçeye geç',dismiss:'Şimdi değil'},
  vi:{title:'Bạn muốn đọc bằng tiếng Việt?',message:'Đề xuất dựa trên ngôn ngữ trình duyệt của bạn. Khi chuyển, bạn vẫn ở trang hiện tại.',switch:'Chuyển sang tiếng Việt',dismiss:'Để sau'},
  id:{title:'Ingin membaca dalam bahasa Indonesia?',message:'Disarankan berdasarkan bahasa browser Anda. Anda tetap berada di halaman yang sama setelah beralih.',switch:'Gunakan bahasa Indonesia',dismiss:'Nanti saja'},
};
