import type { Guide, Locale } from '../types';

type SearchGuide = { title: string; description: string; sections: [string, string][] };
const copy: Record<Locale, SearchGuide> = {
  'zh-CN': {
    title: '找到想看的漫画：按名称搜索与导入阅读',
    description: '输入作品名，选择网站，核对搜索结果，再导入阅读。也可翻译名称寻找其他语言的来源。',
    sections: [
      ['输入作品名，缩小网站范围', '打开插件的“搜索漫画”，选择“直接搜索”，输入作品名或已知别名。在右侧勾选想查找的网站，再点击“搜索网站”。只想查一两个来源时先取消其他网站，减少等待和无关结果。'],
      ['名称不对？试试别名或翻译名称', '找不到结果时，可改用原文名、英文名或其他常见别名。“翻译名称搜索”需要登录，可先翻译成所选语言的常用名称，再搜索；也可手动修改返回的名称。名称语言不会改变漫画翻译目标语言，也不会筛掉其他语言的来源。'],
      ['核对候选，再导入阅读', '结果陆续出现，不必等所有网站结束。先核对作品名、作者和封面；封面缺失时可“打开来源”确认。确定后点“导入并阅读”；已有的同来源漫画会显示“继续阅读”。不同来源会成为独立漫画，不替换原书或迁移阅读进度。'],
      ['没有结果或某个网站失败时', '点击网站状态可只看该站结果，并按提示重试或加载更多。一个站失败不影响已有结果。需要登录、付费或地区权限的内容仍须在源站正常获得访问权；搜索候选不是同一作品的自动认证。'],
    ],
  },
  'zh-TW': {
    title: '找到想看的漫畫：依名稱搜尋與匯入閱讀', description: '輸入作品名、選擇網站、核對候選，再匯入閱讀。也可翻譯名稱尋找其他語言的來源。',
    sections: [
      ['輸入作品名，縮小網站範圍', '開啟「搜尋漫畫」，選擇直接搜尋並輸入作品名或別名。勾選要查詢的網站後開始搜尋；先取消不需要的網站，可減少等待和無關結果。'],
      ['換個別名，或翻譯名稱', '找不到時可用原文名、英文名或常見別名。「翻譯名稱搜尋」需要登入，取得名稱後仍可手動修改。名稱語言不會改變圖片翻譯目標，也不會限制來源語言。'],
      ['核對候選，再匯入閱讀', '結果陸續出現。核對名稱、作者和封面；缺少封面時可先開啟來源確認。選擇「匯入並閱讀」，已有的同來源作品可繼續閱讀。不同來源會建立獨立漫畫，不取代原書或轉移進度。'],
      ['無結果或網站失敗時', '點選網站狀態以篩選結果，按提示重試或載入更多。一站失敗不影響其他候選；登入、付費與地區限制仍需在來源網站滿足。候選不是同作的自動認證。'],
    ],
  },
  en: {
    title: 'Find a comic: search by title, then import and read', description: 'Choose a title and a few websites, check the results, and open your next read. Translate a title when you need another name.',
    sections: [
      ['Enter a title and choose your websites', 'Open Search comics, choose Search by name, and enter a title or known alias. Select the websites to query, then search. Deselect sources you do not need to reduce waiting and unrelated results.'],
      ['Try an alias or translate the title', 'Try the original title, an English name, or another common alias. Translate and search requires sign-in; you can edit the returned name before searching again. The title language changes neither image translation settings nor the languages of eligible sources.'],
      ['Check the result before importing', 'Results arrive independently. Check the title, author and cover; if a cover is missing, open the source to confirm. Choose Import and read, or continue an existing comic from that source. A different source creates a separate comic without replacing the original or moving its progress.'],
      ['Handle missing results or a failed website', 'Select a website status to filter its results, retry, or load more when offered. One failed source does not remove other results. Source login, payment and regional access requirements still apply. Candidates are not automatically verified matches.'],
    ],
  },
  ja: {
    title: '読みたい漫画を探す：作品名で検索して読み込む', description: '作品名と検索先を選び、候補を確認して読み始めましょう。別名や作品名の翻訳も利用できます。',
    sections: [
      ['作品名と検索するサイトを選ぶ', '「漫画を検索」を開き、直接検索で作品名や別名を入力します。検索したいサイトを選んで実行してください。不要なサイトを外すと、待ち時間や関係のない結果を減らせます。'],
      ['別名や作品名の翻訳を試す', '原題や英語名などでも検索できます。作品名を翻訳して検索するにはログインが必要です。返された名前は編集できます。名称の言語は画像翻訳の設定や検索先の言語を変更しません。'],
      ['候補を確認して読み込む', '結果はサイトごとに表示されます。作品名、作者、表紙を確認し、表紙がない場合は元サイトで確認してください。読み込みを選ぶと読書を開始できます。同じ出典の登録済み作品は続きから読めます。別の出典は独立した作品になり、元の進捗は移りません。'],
      ['結果がない場合やサイトのエラー', 'サイトの状態を選ぶと結果を絞り込み、必要に応じて再試行や追加読み込みができます。一つの失敗は他の結果に影響しません。ログイン、有料アクセス、地域制限は元サイトの条件に従います。候補は同じ作品と自動認定されたものではありません。'],
    ],
  },
  ko: {
    title: '읽고 싶은 만화 찾기: 제목 검색부터 가져오기까지', description: '제목과 사이트를 선택하고 검색 결과를 확인한 뒤 읽어 보세요. 다른 이름이 필요하면 제목을 번역할 수도 있습니다.',
    sections: [
      ['제목을 입력하고 사이트 선택하기', '만화 검색에서 직접 검색을 선택하고 작품명이나 별칭을 입력하세요. 검색할 사이트를 선택한 다음 실행합니다. 필요 없는 사이트를 해제하면 대기 시간과 관련 없는 결과를 줄일 수 있습니다.'],
      ['별칭이나 제목 번역 사용하기', '원제, 영어 제목 또는 다른 별칭으로 검색해 보세요. 제목 번역 검색에는 로그인이 필요하며 번역된 이름을 수정할 수 있습니다. 제목 언어는 이미지 번역 설정이나 검색 대상 사이트의 언어를 바꾸지 않습니다.'],
      ['결과를 확인한 뒤 가져오기', '결과는 사이트별로 도착합니다. 제목, 작가, 표지를 확인하고 표지가 없으면 출처를 열어 확인하세요. 가져오고 읽기를 선택하거나 같은 출처의 기존 만화를 이어 읽을 수 있습니다. 다른 출처는 별도의 만화로 추가되며 원래 책과 진행 기록을 대체하지 않습니다.'],
      ['검색 결과가 없거나 사이트가 실패할 때', '사이트 상태를 선택하면 해당 결과만 볼 수 있고 지원되는 경우 재시도하거나 더 불러올 수 있습니다. 한 사이트의 실패는 다른 결과에 영향을 주지 않습니다. 출처의 로그인, 결제, 지역 제한은 그대로 적용되며 후보가 같은 작품인지 직접 확인해야 합니다.'],
    ],
  },
  fr: { title: 'Trouver un manga : chercher un titre et commencer à lire', description: 'Choisissez les sites, vérifiez les résultats et importez votre lecture. Essayez un autre nom grâce à la traduction du titre.', sections: [
    ['Saisir un titre et choisir les sites', 'Ouvrez la recherche de mangas, choisissez la recherche directe et saisissez un titre ou un alias. Cochez les sites souhaités, puis lancez la recherche. Limiter les sources réduit les attentes inutiles.'],
    ['Essayer un alias ou traduire le titre', 'Essayez le titre original ou un autre nom courant. La traduction du titre nécessite une connexion au compte ; le nom obtenu reste modifiable. Elle ne change ni la langue de traduction des images ni les langues des sources recherchées.'],
    ['Vérifier avant d’importer', 'Vérifiez le titre, l’auteur et la couverture à mesure que les résultats arrivent. Sans couverture, ouvrez la source. Importez pour lire, ou reprenez le livre déjà présent. Une autre source crée un manga distinct, sans remplacer le premier ni transférer sa progression.'],
    ['Gérer une recherche vide ou un échec', 'Sélectionnez un site pour filtrer ses résultats, réessayer ou en charger davantage. Un échec ne supprime pas les autres résultats. Les conditions de connexion, de paiement et d’accès régional de la source restent applicables. Vérifiez vous-même les correspondances.'],
  ] },
  es: { title: 'Encuentra un manga: busca por título e importa para leer', description: 'Elige sitios, comprueba los resultados y empieza a leer. Prueba otro nombre con la traducción del título.', sections: [
    ['Introduce un título y elige sitios', 'Abre la búsqueda de manga, selecciona la búsqueda directa e introduce el título o un alias. Marca los sitios que quieras consultar y busca. Desmarca los que no necesites para reducir la espera.'],
    ['Prueba un alias o traduce el título', 'Usa el nombre original, el inglés u otro alias. Traducir el título requiere iniciar sesión; puedes editar el nombre obtenido. No cambia el idioma de traducción de imágenes ni limita los idiomas de las fuentes.'],
    ['Comprueba antes de importar', 'Los resultados llegan por separado. Revisa título, autor y portada; si falta la portada, abre la fuente. Importa para leer o continúa el libro existente de esa fuente. Otra fuente crea un manga independiente, sin sustituir el original ni transferir el progreso.'],
    ['Si no hay resultados o falla un sitio', 'Selecciona el estado de un sitio para filtrar resultados, reintentar o cargar más. Un fallo no borra los demás resultados. Siguen vigentes los requisitos de acceso, pago y región de cada fuente. Comprueba las coincidencias antes de importar.'],
  ] },
  'pt-BR': { title: 'Encontre um mangá: pesquise o título e importe para ler', description: 'Escolha os sites, confira os resultados e comece a leitura. Traduza o título quando precisar de outro nome.', sections: [
    ['Digite o título e escolha os sites', 'Abra a busca de mangás, escolha a pesquisa direta e digite o título ou um nome alternativo. Marque os sites desejados e pesquise. Desmarcar fontes desnecessárias reduz a espera.'],
    ['Tente outro nome ou traduza o título', 'Experimente o título original, em inglês ou outro nome conhecido. Traduzir o título exige login; o nome retornado pode ser editado. Isso não muda o idioma de tradução das imagens nem limita o idioma das fontes.'],
    ['Confira antes de importar', 'Confira título, autor e capa conforme os resultados chegam. Sem capa, abra a fonte para confirmar. Importe para ler ou continue o livro já existente. Outra fonte cria um mangá separado, sem substituir o original nem transferir o progresso.'],
    ['Nenhum resultado ou falha em um site', 'Selecione o status de um site para filtrar, tentar novamente ou carregar mais. Uma falha não remove outros resultados. Login, pagamento e restrições regionais da fonte continuam valendo. Os candidatos precisam ser conferidos.'],
  ] },
  de: { title: 'Manga finden: Titel suchen und zum Lesen importieren', description: 'Wähle Websites, prüfe die Treffer und beginne zu lesen. Übersetze den Titel, wenn du einen anderen Namen brauchst.', sections: [
    ['Titel eingeben und Websites auswählen', 'Öffne die Manga-Suche und gib bei der direkten Suche einen Titel oder Alternativnamen ein. Wähle die Websites und starte die Suche. Nicht benötigte Quellen abzuwählen verkürzt unnötige Wartezeiten.'],
    ['Alternativnamen oder Titelübersetzung nutzen', 'Versuche den Originaltitel oder einen bekannten englischen Namen. Die Titelübersetzung erfordert eine Anmeldung; das Ergebnis ist bearbeitbar. Sie ändert weder die Bildübersetzung noch die Sprachen der durchsuchten Quellen.'],
    ['Treffer vor dem Import prüfen', 'Prüfe Titel, Autor und Cover, sobald Ergebnisse eintreffen. Fehlt das Cover, öffne die Quelle. Importiere zum Lesen oder setze das vorhandene Buch fort. Eine andere Quelle legt einen eigenständigen Manga an und übernimmt nicht den Lesefortschritt.'],
    ['Keine Treffer oder eine fehlerhafte Website', 'Wähle den Status einer Website, um ihre Ergebnisse zu filtern, erneut zu suchen oder mehr zu laden. Andere Treffer bleiben erhalten. Anmeldung, Zahlung und regionale Bedingungen der Quelle gelten weiterhin. Prüfe selbst, ob es dasselbe Werk ist.'],
  ] },
  it: { title: 'Trova un manga: cerca il titolo e importa per leggere', description: 'Scegli i siti, controlla i risultati e inizia a leggere. Traduci il titolo quando serve un altro nome.', sections: [
    ['Inserisci il titolo e scegli i siti', 'Apri la ricerca manga, scegli la ricerca diretta e inserisci titolo o alias. Seleziona i siti e avvia la ricerca. Deseleziona le fonti inutili per ridurre le attese.'],
    ['Prova un alias o traduci il titolo', 'Prova il titolo originale, inglese o un altro nome comune. La traduzione del titolo richiede l’accesso; puoi modificare il nome restituito. Non cambia la traduzione delle immagini né limita le lingue delle fonti.'],
    ['Verifica prima di importare', 'Controlla titolo, autore e copertina mentre arrivano i risultati. Se manca la copertina, apri la fonte. Importa per leggere o continua il libro già presente. Una fonte diversa crea un manga separato, senza sostituire l’originale o trasferire i progressi.'],
    ['Nessun risultato o un sito non risponde', 'Seleziona lo stato di un sito per filtrare, riprovare o caricare altri risultati. Gli altri risultati restano disponibili. Accesso, pagamento e restrizioni regionali dipendono dalla fonte. Verifica che il candidato sia l’opera cercata.'],
  ] },
  ru: { title: 'Найдите мангу: поиск по названию и импорт', description: 'Выберите сайты, проверьте результаты и начните читать. При необходимости переведите название.', sections: [
    ['Введите название и выберите сайты', 'Откройте поиск манги, выберите прямой поиск и введите название или псевдоним. Отметьте нужные сайты и начните поиск. Отключите лишние источники, чтобы сократить ожидание.'],
    ['Попробуйте другое название или перевод', 'Используйте оригинальное, английское или другое известное название. Перевод названия требует входа; полученное имя можно исправить. Он не меняет язык перевода изображений и не ограничивает языки источников.'],
    ['Проверьте результат перед импортом', 'Результаты появляются независимо. Сверьте название, автора и обложку; при отсутствии обложки откройте источник. Импортируйте для чтения или продолжите существующую книгу. Другая платформа создаёт отдельную мангу без переноса прогресса.'],
    ['Нет результатов или сайт выдал ошибку', 'Выберите статус сайта, чтобы отфильтровать результаты, повторить запрос или загрузить ещё. Ошибка не удаляет остальные результаты. Требования входа, оплаты и региона задаёт источник. Совпадения нужно проверять самостоятельно.'],
  ] },
  pl: { title: 'Znajdź mangę: wyszukaj tytuł i zaimportuj', description: 'Wybierz strony, sprawdź wyniki i zacznij czytać. W razie potrzeby przetłumacz tytuł.', sections: [
    ['Wpisz tytuł i wybierz strony', 'Otwórz wyszukiwanie mangi, wybierz wyszukiwanie bezpośrednie i wpisz tytuł lub alias. Zaznacz strony i rozpocznij. Odznacz niepotrzebne źródła, aby skrócić oczekiwanie.'],
    ['Wypróbuj alias lub tłumaczenie tytułu', 'Spróbuj tytułu oryginalnego, angielskiego lub innej znanej nazwy. Tłumaczenie tytułu wymaga logowania; wynik można zmienić. Nie zmienia języka tłumaczenia obrazów ani nie ogranicza języków źródeł.'],
    ['Sprawdź wynik przed importem', 'Porównaj tytuł, autora i okładkę. Jeśli okładki brakuje, otwórz źródło. Zaimportuj do czytania lub wznów istniejącą książkę. Inne źródło tworzy osobną mangę, bez zastępowania oryginału i przenoszenia postępu.'],
    ['Brak wyników lub błąd strony', 'Wybierz status strony, aby filtrować, ponowić próbę lub wczytać więcej. Inne wyniki pozostają dostępne. Wymogi logowania, płatności i regionu nadal obowiązują. Samodzielnie sprawdź, czy kandydat jest szukaną mangą.'],
  ] },
  uk: { title: 'Знайдіть манґу: пошук за назвою та імпорт', description: 'Виберіть сайти, перевірте результати й почніть читати. За потреби перекладіть назву.', sections: [
    ['Введіть назву й виберіть сайти', 'Відкрийте пошук манґи, виберіть прямий пошук і введіть назву або псевдонім. Позначте сайти та почніть пошук. Вимкніть непотрібні джерела, щоб зменшити очікування.'],
    ['Спробуйте іншу назву або переклад', 'Використайте оригінальну, англійську або іншу відому назву. Переклад назви потребує входу; отриманий текст можна редагувати. Це не змінює мову перекладу зображень і не обмежує мови джерел.'],
    ['Перевірте результат перед імпортом', 'Звірте назву, автора й обкладинку. Якщо обкладинки немає, відкрийте джерело. Імпортуйте для читання або продовжте наявну книгу. Інше джерело створює окрему манґу без заміни оригіналу та перенесення прогресу.'],
    ['Немає результатів або сайт не відповідає', 'Виберіть стан сайту для фільтрації, повтору запиту чи завантаження наступних результатів. Інші результати зберігаються. Вхід, оплата й регіональні умови джерела залишаються чинними. Перевіряйте відповідність самостійно.'],
  ] },
  tr: { title: 'Manga bulun: adına göre arayın ve okumak için içe aktarın', description: 'Siteleri seçin, sonuçları kontrol edin ve okumaya başlayın. Gerekirse başlığı çevirin.', sections: [
    ['Başlığı girin ve siteleri seçin', 'Manga aramasını açın, doğrudan aramayı seçip başlık veya alternatif ad girin. İstediğiniz siteleri işaretleyip arayın. Gereksiz kaynakları kaldırarak beklemeyi azaltabilirsiniz.'],
    ['Alternatif ad veya başlık çevirisini deneyin', 'Özgün başlığı, İngilizce adı veya bilinen başka bir adı deneyin. Başlık çevirisi giriş gerektirir; dönen adı düzenleyebilirsiniz. Bu işlem görüntü çevirisinin dilini veya kaynakların dillerini değiştirmez.'],
    ['İçe aktarmadan önce kontrol edin', 'Sonuçlar geldikçe başlık, yazar ve kapağı kontrol edin. Kapak yoksa kaynağı açın. İçe aktararak okuyun veya mevcut kitaba devam edin. Farklı kaynak, özgün kitabı değiştirmeden ve ilerlemeyi taşımadan ayrı manga oluşturur.'],
    ['Sonuç yoksa veya bir site hata verirse', 'Sonuçları süzmek, yeniden denemek veya daha fazlasını yüklemek için site durumunu seçin. Diğer sonuçlar silinmez. Kaynağın giriş, ödeme ve bölge şartları geçerlidir. Eşleşmeyi kendiniz doğrulayın.'],
  ] },
  vi: { title: 'Tìm truyện: tìm theo tên rồi nhập để đọc', description: 'Chọn website, kiểm tra kết quả rồi bắt đầu đọc. Dịch tên khi cần một cách gọi khác.', sections: [
    ['Nhập tên và chọn website', 'Mở tìm kiếm truyện, chọn tìm trực tiếp rồi nhập tên hoặc tên gọi khác. Đánh dấu các website cần tìm và chạy tìm kiếm. Bỏ các nguồn không cần để giảm thời gian chờ.'],
    ['Thử tên khác hoặc dịch tên', 'Thử tên gốc, tên tiếng Anh hoặc tên phổ biến khác. Dịch tên cần đăng nhập và cho phép sửa kết quả. Thao tác này không đổi ngôn ngữ dịch ảnh hay giới hạn ngôn ngữ của nguồn.'],
    ['Kiểm tra rồi mới nhập', 'Kiểm tra tên, tác giả và bìa khi kết quả xuất hiện. Nếu thiếu bìa, mở nguồn để xác nhận. Nhập để đọc hoặc đọc tiếp truyện đã có. Nguồn khác tạo một truyện riêng, không thay truyện gốc hay chuyển tiến độ.'],
    ['Không có kết quả hoặc một website lỗi', 'Chọn trạng thái website để lọc, thử lại hoặc tải thêm. Các kết quả khác vẫn được giữ. Yêu cầu đăng nhập, thanh toán và khu vực của nguồn vẫn áp dụng. Bạn cần tự kiểm tra kết quả có đúng tác phẩm không.'],
  ] },
  id: { title: 'Temukan manga: cari judul lalu impor untuk membaca', description: 'Pilih situs, periksa hasil, dan mulai membaca. Terjemahkan judul jika perlu nama lain.', sections: [
    ['Masukkan judul dan pilih situs', 'Buka pencarian manga, pilih pencarian langsung, lalu masukkan judul atau alias. Centang situs yang diinginkan dan cari. Batasi sumber untuk mengurangi waktu tunggu.'],
    ['Coba alias atau terjemahkan judul', 'Coba judul asli, judul Inggris, atau nama umum lain. Terjemahan judul memerlukan login; hasilnya dapat diedit. Ini tidak mengubah bahasa terjemahan gambar atau membatasi bahasa sumber.'],
    ['Periksa sebelum mengimpor', 'Periksa judul, penulis, dan sampul saat hasil muncul. Jika sampul tidak tersedia, buka sumber. Impor untuk membaca atau lanjutkan buku yang sudah ada. Sumber berbeda membuat manga terpisah tanpa mengganti buku asli atau memindahkan kemajuan.'],
    ['Tidak ada hasil atau situs gagal', 'Pilih status situs untuk menyaring hasil, mencoba lagi, atau memuat lebih banyak. Hasil lain tetap tersedia. Persyaratan login, pembayaran, dan wilayah sumber tetap berlaku. Pastikan sendiri bahwa hasilnya cocok.'],
  ] },
  ar: { title: 'اعثر على المانغا: ابحث بالعنوان ثم استورد للقراءة', description: 'اختر المواقع وتحقق من النتائج وابدأ القراءة. ترجم العنوان عند الحاجة إلى اسم آخر.', sections: [
    ['أدخل العنوان واختر المواقع', 'افتح بحث المانغا واختر البحث المباشر ثم أدخل عنواناً أو اسماً بديلاً. حدد المواقع المطلوبة وابدأ البحث. ألغِ المصادر غير المطلوبة لتقليل الانتظار.'],
    ['جرّب اسماً بديلاً أو ترجم العنوان', 'جرّب العنوان الأصلي أو الإنجليزي أو اسماً معروفاً آخر. ترجمة العنوان تتطلب تسجيل الدخول ويمكن تعديل الاسم الناتج. لا تغيّر لغة ترجمة الصور ولا تحدّ من لغات المصادر.'],
    ['تحقق من النتيجة قبل الاستيراد', 'راجع العنوان والمؤلف والغلاف عند وصول النتائج. افتح المصدر للتحقق إذا غاب الغلاف. استورد للقراءة أو تابع الكتاب الموجود من المصدر نفسه. المصدر المختلف ينشئ مانغا مستقلة دون استبدال الأصل أو نقل تقدم القراءة.'],
    ['عند غياب النتائج أو فشل موقع', 'اختر حالة الموقع لتصفية نتائجه أو إعادة المحاولة أو تحميل المزيد. تبقى النتائج الأخرى متاحة. تظل شروط تسجيل الدخول والدفع والمنطقة لدى المصدر سارية. تحقق بنفسك من تطابق العمل.'],
  ] },
};

export function findMangaGuide(locale: Locale, category: string): Guide {
  const { title, description, sections } = copy[locale];
  return {
    slug: 'find-manga', title, description, category, minutes: 4,
    published: '2026-10-10', updated: '2026-10-10',
    related: ['manga-translation', 'remote-library', 'translation-troubleshooting'],
    sections: sections.map(([title, paragraph]) => ({ title, paragraphs: [paragraph] })),
  };
}
