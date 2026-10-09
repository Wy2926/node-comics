import type {Locale} from './types';

// Model names and quantities come from the catalog, never from translated copy.
const labels:Record<Locale,[string,string,string,string,string,string,string,string,string]>={
  'zh-CN':['轻量翻译','日常追漫','更多翻译用量','免费模型','付费额外支持','免费档不含','已包含','未包含','比 {plan} 每月多 {pages} 页'],
  'zh-TW':['輕量翻譯','日常追漫','更多翻譯用量','免費模型','付費額外支援','免費方案不含','已包含','未包含','比 {plan} 每月多 {pages} 頁'],
  en:['Light translation','Everyday reading','More translation pages','Free models','Additional paid models','Not in Free','Included','Not included','{pages} more pages per month than {plan}'],
  ja:['気軽に翻訳','日々の漫画に','より多くの翻訳に','無料モデル','有料で追加','無料枠の対象外','含まれます','含まれません','{plan} より毎月 {pages} ページ多く翻訳'],
  ko:['가벼운 번역','매일 만화 읽기','더 많은 번역','무료 모델','유료 추가 모델','무료 요금제 미포함','포함','미포함','{plan}보다 매월 {pages}페이지 더 제공'],
  fr:['Traduction occasionnelle','Lecture quotidienne','Plus de pages à traduire','Modèles gratuits','Modèles payants en plus','Non inclus en gratuit','Inclus','Non inclus','{pages} pages de plus par mois que {plan}'],
  es:['Traducción ocasional','Lectura diaria','Más páginas para traducir','Modelos gratuitos','Modelos de pago adicionales','No incluidos en el plan gratuito','Incluido','No incluido','{pages} páginas más al mes que {plan}'],
  'pt-BR':['Tradução ocasional','Leitura diária','Mais páginas para traduzir','Modelos gratuitos','Modelos pagos adicionais','Não incluídos no plano grátis','Incluído','Não incluído','{pages} páginas a mais por mês que {plan}'],
  de:['Gelegentlich übersetzen','Täglich lesen','Mehr Seiten übersetzen','Kostenlose Modelle','Zusätzliche Bezahlmodelle','Nicht im Gratisplan','Enthalten','Nicht enthalten','{pages} Seiten mehr pro Monat als {plan}'],
  it:['Traduzione occasionale','Lettura quotidiana','Più pagine da tradurre','Modelli gratuiti','Modelli a pagamento in più','Non inclusi nel piano gratuito','Incluso','Non incluso','{pages} pagine in più al mese rispetto a {plan}'],
  ru:['Редкие переводы','Ежедневное чтение','Больше страниц перевода','Бесплатные модели','Дополнительные платные модели','Нет в бесплатном плане','Включено','Не включено','На {pages} страниц в месяц больше, чем в {plan}'],
  pl:['Okazjonalne tłumaczenia','Codzienne czytanie','Więcej stron do tłumaczenia','Darmowe modele','Dodatkowe płatne modele','Poza darmowym planem','W cenie','Brak','O {pages} stron miesięcznie więcej niż {plan}'],
  uk:['Нечасті переклади','Щоденне читання','Більше сторінок перекладу','Безкоштовні моделі','Додаткові платні моделі','Немає в безкоштовному плані','Включено','Не включено','На {pages} сторінок на місяць більше, ніж у {plan}'],
  tr:['Ara sıra çeviri','Günlük okuma','Daha fazla çeviri','Ücretsiz modeller','Ek ücretli modeller','Ücretsiz plana dahil değil','Dahil','Dahil değil','{plan} planından ayda {pages} sayfa daha fazla'],
  vi:['Dịch nhẹ nhàng','Đọc truyện mỗi ngày','Dịch nhiều trang hơn','Mô hình miễn phí','Mô hình trả phí bổ sung','Không có trong gói miễn phí','Có','Không có','Nhiều hơn {plan} {pages} trang mỗi tháng'],
  id:['Terjemahan ringan','Membaca setiap hari','Lebih banyak terjemahan','Model gratis','Model berbayar tambahan','Tidak termasuk paket gratis','Termasuk','Tidak termasuk','{pages} halaman lebih banyak per bulan dari {plan}'],
  ar:['ترجمة خفيفة','قراءة يومية','صفحات ترجمة أكثر','نماذج مجانية','نماذج إضافية مدفوعة','غير مشمولة في المجاني','مشمول','غير مشمول','{pages} صفحة إضافية شهريًا مقارنةً بـ {plan}'],
};

export function pricingHighlightsCopy(locale:string){
  const [free,plus,pro,freeModels,paidModels,paidOnly,included,notIncluded,morePages]=labels[locale as Locale]??labels.en;
  return {free,plus,pro,freeModels,paidModels,paidOnly,included,notIncluded,morePages};
}
