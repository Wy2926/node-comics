import type {Locale} from './types';
interface Copy {message:string;switch:string;dismiss:string}
export const languageNoticeCopy:Record<Locale,Copy> = {
  ar:{message:'لغة متصفحك المفضلة هي {language}. هل تريد التبديل؟',switch:'تغيير اللغة',dismiss:'متابعة بهذه اللغة'},
  'zh-CN':{message:'浏览器的首选语言是 {language}，要切换吗？',switch:'切换语言',dismiss:'暂不切换'},
  'zh-TW':{message:'瀏覽器的偏好語言是 {language}，要切換嗎？',switch:'切換語言',dismiss:'暫不切換'},
  en:{message:'Your browser prefers {language}. Switch language?',switch:'Switch language',dismiss:'Keep this language'},
  ja:{message:'ブラウザーの優先言語は {language} です。切り替えますか？',switch:'言語を切り替える',dismiss:'この言語を使う'},
  ko:{message:'브라우저의 기본 언어는 {language}입니다. 전환할까요?',switch:'언어 전환',dismiss:'현재 언어 유지'},
  fr:{message:'Votre navigateur préfère {language}. Changer de langue ?',switch:'Changer de langue',dismiss:'Garder cette langue'},
  es:{message:'Tu navegador prefiere {language}. ¿Cambiar de idioma?',switch:'Cambiar idioma',dismiss:'Mantener este idioma'},
  'pt-BR':{message:'Seu navegador prefere {language}. Mudar de idioma?',switch:'Mudar idioma',dismiss:'Manter este idioma'},
  de:{message:'Dein Browser bevorzugt {language}. Sprache wechseln?',switch:'Sprache wechseln',dismiss:'Diese Sprache behalten'},
  it:{message:'Il browser preferisce {language}. Cambiare lingua?',switch:'Cambia lingua',dismiss:'Mantieni questa lingua'},
  ru:{message:'Предпочтительный язык браузера — {language}. Переключить язык?',switch:'Сменить язык',dismiss:'Оставить этот язык'},
  pl:{message:'Preferowany język przeglądarki to {language}. Zmienić język?',switch:'Zmień język',dismiss:'Zachowaj ten język'},
  uk:{message:'Бажана мова браузера — {language}. Змінити мову?',switch:'Змінити мову',dismiss:'Залишити цю мову'},
  tr:{message:'Tarayıcınızın tercih ettiği dil {language}. Dil değiştirilsin mi?',switch:'Dili değiştir',dismiss:'Bu dili kullan'},
  vi:{message:'Trình duyệt ưu tiên {language}. Bạn muốn đổi ngôn ngữ?',switch:'Đổi ngôn ngữ',dismiss:'Giữ ngôn ngữ này'},
  id:{message:'Bahasa pilihan browser Anda adalah {language}. Ganti bahasa?',switch:'Ganti bahasa',dismiss:'Tetap gunakan bahasa ini'},
};
