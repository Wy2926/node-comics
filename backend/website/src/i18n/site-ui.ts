import type { Locale } from './locales';
// Shared appearance and image-viewer labels, in every published website language.
const keys = ['theme', 'system', 'light', 'dark', 'view', 'close', 'fit', 'actual', 'unavailable', 'retry'] as const;
const values: Record<Locale, string[]> = {
  'zh-CN': ['外观', '跟随系统', '浅色', '深色', '查看', '关闭预览', '适合宽度', '实际大小', '图片暂时无法显示', '重新加载'],
  'zh-TW': ['外觀', '跟隨系統', '淺色', '深色', '查看', '關閉預覽', '符合寬度', '實際大小', '暫時無法顯示圖片', '重新載入'],
  en: ['Appearance', 'System', 'Light', 'Dark', 'View', 'Close preview', 'Fit width', 'Actual size', 'Image unavailable', 'Reload image'],
  ja: ['外観', 'システムに合わせる', 'ライト', 'ダーク', '表示', 'プレビューを閉じる', '幅に合わせる', '実際のサイズ', '画像を表示できません', '再読み込み'],
  ko: ['화면 모드', '시스템 설정', '라이트', '다크', '보기', '미리보기 닫기', '너비에 맞춤', '실제 크기', '이미지를 표시할 수 없습니다', '다시 불러오기'],
  fr: ['Apparence', 'Système', 'Clair', 'Sombre', 'Voir', 'Fermer l’aperçu', 'Ajuster à la largeur', 'Taille réelle', 'Image indisponible', 'Recharger l’image'],
  es: ['Apariencia', 'Sistema', 'Claro', 'Oscuro', 'Ver', 'Cerrar vista previa', 'Ajustar al ancho', 'Tamaño real', 'Imagen no disponible', 'Recargar imagen'],
  'pt-BR': ['Aparência', 'Sistema', 'Claro', 'Escuro', 'Ver', 'Fechar prévia', 'Ajustar à largura', 'Tamanho real', 'Imagem indisponível', 'Recarregar imagem'],
  de: ['Darstellung', 'System', 'Hell', 'Dunkel', 'Ansehen', 'Vorschau schließen', 'An Breite anpassen', 'Originalgröße', 'Bild nicht verfügbar', 'Bild neu laden'],
  it: ['Aspetto', 'Sistema', 'Chiaro', 'Scuro', 'Visualizza', 'Chiudi anteprima', 'Adatta alla larghezza', 'Dimensioni reali', 'Immagine non disponibile', 'Ricarica immagine'],
  ru: ['Оформление', 'Как в системе', 'Светлое', 'Тёмное', 'Просмотр', 'Закрыть просмотр', 'По ширине', 'Исходный размер', 'Изображение недоступно', 'Загрузить снова'],
  pl: ['Wygląd', 'Systemowy', 'Jasny', 'Ciemny', 'Zobacz', 'Zamknij podgląd', 'Dopasuj szerokość', 'Rzeczywisty rozmiar', 'Obraz niedostępny', 'Wczytaj ponownie'],
  uk: ['Вигляд', 'Як у системі', 'Світлий', 'Темний', 'Переглянути', 'Закрити перегляд', 'За шириною', 'Початковий розмір', 'Зображення недоступне', 'Завантажити знову'],
  tr: ['Görünüm', 'Sistem', 'Açık', 'Koyu', 'Görüntüle', 'Önizlemeyi kapat', 'Genişliğe sığdır', 'Gerçek boyut', 'Görsel kullanılamıyor', 'Yeniden yükle'],
  vi: ['Giao diện', 'Theo hệ thống', 'Sáng', 'Tối', 'Xem', 'Đóng xem trước', 'Vừa chiều rộng', 'Kích thước thực', 'Không thể hiển thị ảnh', 'Tải lại ảnh'],
  id: ['Tampilan', 'Sistem', 'Terang', 'Gelap', 'Lihat', 'Tutup pratinjau', 'Sesuaikan lebar', 'Ukuran asli', 'Gambar tidak tersedia', 'Muat ulang gambar'],
  ar: ['المظهر', 'حسب النظام', 'فاتح', 'داكن', 'عرض', 'إغلاق المعاينة', 'ملاءمة العرض', 'الحجم الفعلي', 'الصورة غير متاحة', 'إعادة تحميل الصورة'],
};
export const siteUi = Object.fromEntries(Object.entries(values).map(([locale, labels]) => [locale, Object.fromEntries(keys.map((key, index) => [key, labels[index]]))])) as Record<Locale, Record<typeof keys[number], string>>;
