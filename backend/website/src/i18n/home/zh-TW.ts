import type { HomeCopy } from './types';

const copy: HomeCopy = {
  comparison: { title: '同一頁，多種語言。', group: '翻譯效果對照', labels: ['日文原圖', '中文', '英文', '韓文'], loading: '正在載入圖片…', error: '圖片載入失敗。', retry: '重新載入', caption: '已記錄的一般翻譯實測效果' },
    eyebrow: '你的故事，你的節奏', title: ["漫畫閱讀與翻譯，","在瀏覽器裡完成。"],
    description: "把本機漫畫、Google Drive、OPDS 書庫與適配網站帶進 Chrome、Edge、Firefox。支援 EPUB 閱讀、常規圖片翻譯與網頁劃圖，隨時對照原圖。",
    install: '取得擴充功能', seeReader: '看看閱讀器', desktop: '為桌面閱讀設計',
    readerPath: '用擴充功能，連續閱讀漫畫', readerAccess: '免費閱讀本機原圖，無需帳戶。官方翻譯使用帳戶額度，也可連接自己的本機翻譯服務。',
    webAccess: '可匿名體驗，登入後使用帳戶額度。目前可用次數以圖片工作台顯示為準。',
    platformHeading: '支援你的桌面瀏覽器', guestEyebrow: '線上圖片翻譯',
    popupAlt: 'NodeLane Comics 擴充功能彈窗，已選擇英語，顯示翻譯目前分頁按鈕。', popupCaption: '下一章，從瀏覽器工具列開始。',
    trustLinks: [['公開原始碼', '在 GitHub 查看專案程式碼與問題回報。'], ['官方安裝管道', "Chrome、Edge、Firefox 官方商店與安裝套件。"], ['圖片與隱私', '瞭解圖片處理方式與保存期限。']],
    quickStart: {
      eyebrow: '影片快速開始', title: '跟著操作，開始閱讀。', description: '用現有教學熟悉查找、匯入、閱讀與翻譯。',
      watch: '觀看教學', channel: '前往 YouTube 頻道',
      clips: [
        { title: '查找、匯入與離線閱讀', description: '從加入漫畫到離線閱讀，瞭解如何在閱讀時開啟翻譯。', language: '中文影片' },
        { title: '閱讀與翻譯入門', description: '用英文教學瞭解閱讀器，以及原圖與翻譯的使用方式。', language: '英文影片' },
      ],
    },
    stepsTitle: '三步，開啟下一本。', stepsIntro: '安裝擴充功能，加入漫畫，按自己的節奏閱讀。',
    steps: [
      [
        "安裝瀏覽器擴充功能",
        "從 Chrome、Edge、Firefox 官方商店安裝，或取得對應瀏覽器安裝套件。"
      ],
      [
        "加入漫畫或連接書庫",
        "匯入本機或 Google Drive 漫畫、連接 OPDS，或從已適配網站開啟閱讀。"
      ],
      [
        "需要時開啟翻譯",
        "選擇官方或自架管道與目標語言，在閱讀器或原網站對照原圖與譯圖。"
      ]
    ],
    compareEyebrow: '看清每一頁', compareTitle: '看懂譯文，也保留原圖。',
    compareBody: '切換查看日文原圖和已記錄的翻譯結果。在閱讀器裡，原圖與譯圖也隨時可選。',
    compareNote: '原創 AI 插畫上的一般翻譯實測範例。效果因畫面、文字和語言而異。', compareLink: '瞭解翻譯方式',
    readerEyebrow: '六個畫面，看看裡面', readerTitle: '從下一本，到下一頁。', readerBody: '發現想看的漫畫，整理進書架，快取後慢慢讀。這裡展示專案介紹中的真實介面。',
    galleryLabels: ['我的漫畫', '發現漫畫', '搜尋漫畫', '離線中心', '閱讀與目錄', '原圖與譯圖'],
    galleryBodies: ['匯入、搜尋和管理漫畫，從上次讀到的位置繼續。', '瀏覽榜單，查看作品簡介、評分和別名，發現下一本。', '按名稱或別名搜尋網站，也可先翻譯名稱，再選擇來源。', '查看章節快取進度與空間佔用，隨時暫停或繼續。', '展開章節目錄，查看語言、頁數、快取和閱讀狀態。', '並排查看原圖與譯圖，也可切回原圖繼續閱讀。'],
    galleryAlt: ['中文介面的漫畫書架與閱讀進度。', '中文介面的漫畫發現榜單與作品詳情。', '中文介面的漫畫名稱、網站選擇與搜尋結果。', '中文介面的離線快取任務、章節進度與空間佔用。', '中文閱讀器與展開的多語言章節目錄。', '中文閱讀器中的原圖與中文譯圖並排對照。'],
    enlarge: '查看完整截圖', close: '關閉截圖', galleryName: '瀏覽擴充功能截圖',
    screenshotNote: '與專案介紹共用的真實截圖，以中文介面展示；點擊可查看完整原圖。功能可能因安裝版本而異，漫畫作品歸各自權利人所有。',
    sourcesEyebrow: "檔案、雲端硬碟、書庫與網站", sourcesTitle: '帶上你能存取的漫畫。',
    sources: [
      [
        "本機漫畫與 EPUB",
        "匯入 CBZ/ZIP、CBR/RAR、PDF、無 DRM MOBI、EPUB，免費閱讀原圖與原文，無需帳戶。",
        "查看格式與匯入方式"
      ],
      [
        "Google Drive",
        "透過 Google 授權選擇 CBZ/ZIP 或無 DRM MOBI，按需讀取自己的漫畫，無需先下載整包。",
        "了解來源與格式"
      ],
      [
        "OPDS 遠端書庫",
        "連接自己的 OPDS 目錄，瀏覽、搜尋與按需閱讀；下載和進度同步依來源支援與存取權限而定。",
        "設定遠端書庫"
      ],
      [
        "已適配漫畫網站",
        "從專門適配的網站加入漫畫。目錄、可讀內容與存取條件依源站提供，不繞過登入或付費限制。",
        "了解網站閱讀與翻譯"
      ]
    ],
    modesEyebrow: '需要時，再翻譯', modesTitle: "選擇適合你的翻譯管道",
    modes: [
      [
        "NodeLane 官方管道",
        "登入後使用官方常規翻譯，按帳戶方案與額度處理圖片；譯圖逐頁顯示，可隨時切回原圖。"
      ],
      [
        "自架 manga-translator-ui",
        "新增自己的服務位址與 MTU 帳密，可保存多個設定並選擇目前管道；無需 NodeLane 帳號或官方額度。"
      ]
    ],
    controlNote: "新漫畫預設顯示原圖。選擇管道與目標語言，再開啟常規翻譯；閱讀器與網頁共用目前管道。",
    privacyTitle: '瞭解漫畫圖片如何處理。', privacyBody: '官方翻譯將選取的圖片傳送到伺服器，原圖在任務完成、失敗或取消後清理。帳戶的私有結果在仍有有效請求時保留；訪客的伺服器結果自任務結束起保留 24 小時，本機已保存的譯圖不受此期限影響。連接本機翻譯服務時，圖片處理與保留由該服務決定。',
    privacy: '隱私政策', pricing: '方案與額度', ctaTitle: '準備好翻開下一頁了嗎？', ctaBody: '取得擴充功能，開啟漫畫，找到舒服的閱讀節奏。',
  };

export default copy;
