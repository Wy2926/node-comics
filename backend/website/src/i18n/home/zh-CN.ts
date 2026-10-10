import type { HomeCopy } from './types';

const copy: HomeCopy = {
  comparison: { title: '同一页，多种语言。', group: '翻译效果对照', labels: ['日文原图', '中文', '英文', '韩文'], loading: '正在加载图片…', error: '图片加载失败。', retry: '重新加载', caption: '已记录的翻译实测效果' },
    eyebrow: "漫画翻译浏览器插件", title: ["看懂漫画，","继续你的阅读。"],
    description: "适用于桌面 Chrome、Edge 和 Firefox 的漫画翻译插件。用 NodeLane 云端服务翻译漫画图片，在阅读器中随时对照原图。",
    install: '获取插件', seeReader: "查看翻译效果", desktop: '为桌面阅读设计',
    readerPath: "漫画与书库，汇入同一个阅读器", readerAccess: "插件免费安装。云端翻译需登录，免费额度与付费套餐各有使用限制。",
    webAccess: '可匿名体验，登录后使用账户额度。当前可用次数以图片工作台显示为准。',
    platformHeading: '支持你的桌面浏览器', guestEyebrow: '在线图片翻译',
    popupAlt: 'NodeLane Comics 插件弹窗，已选择英语，显示翻译当前标签页按钮。', popupCaption: "翻译当前标签页、划取选区，或打开已适配漫画的阅读器。",
    trustLinks: [['公开源码', '在 GitHub 查看项目代码与问题反馈。'], ['官方安装渠道', "Chrome、Edge、Firefox 官方商店与安装包。"], ['图片与隐私', '了解图片处理方式与保存期限。']],
    quickStart: {
      eyebrow: '视频快速开始', title: '跟着操作，开始阅读。', description: '用现有教程熟悉查找、导入、阅读与翻译。',
      watch: '观看教程', channel: '前往 YouTube 频道',
      clips: [
        { title: '查找、导入与离线阅读', description: '从添加漫画到离线阅读，了解如何在阅读时开启翻译。', language: '中文视频' },
        { title: '阅读与翻译入门', description: '用英文教程了解阅读器，以及原图与翻译的使用方式。', language: '英文视频' },
      ],
    },
    stepsTitle: "三步，开始阅读与翻译。", stepsIntro: "安装插件，打开书籍或连接来源，再选择适合自己的阅读方式。",
    steps: [["安装插件","从 Chrome、Edge 或 Firefox 官方商店安装。"],["打开漫画","导入本地漫画，或打开已适配的漫画网站。"],["选择翻译语言","使用所选服务翻译图片，随时对照原图继续阅读。"]],
    compareEyebrow: '看清每一页', compareTitle: '看懂译文，也保留原图。',
    compareBody: "切换查看日文原图和已记录的翻译结果。阅读器中可切换原译图，也可并排对照，继续保持阅读位置。",
    compareNote: '原创 AI 插画上的翻译实测样例。效果因画面、文字和语言而异。', compareLink: '了解翻译方式',
    readerEyebrow: '六个画面，看看里面', readerTitle: '从下一本，到下一页。', readerBody: "发现作品、跨站搜索、放进书架、缓存后离线阅读。截图展示真实产品界面；OPDS 与 EPUB 同样使用阅读器的工具和偏好设置。",
    galleryLabels: ['我的漫画', '发现漫画', '搜索漫画', '离线中心', '阅读与目录', '原图与译图'],
    galleryBodies: ["导入和管理漫画，从保存的阅读位置继续。", "浏览 AniList 榜单、简介、评分和别名，也可翻译书名与简介。", "按书名或别名搜索已适配网站，也可先翻译名称，再选择来源。", "缓存所选语言与章节，查看空间占用，暂停继续并补齐失败页。", "浏览章节与语言选项，查看页数、缓存状态和阅读进度。", "并排对照原图与译图，或切回原图，保持阅读位置。"],
    galleryAlt: ['中文界面的漫画书架与阅读进度。', '中文界面的漫画发现榜单与作品详情。', '中文界面的漫画名称、网站选择与搜索结果。', '中文界面的离线缓存任务、章节进度与空间占用。', '中文阅读器与展开的多语言章节目录。', '中文阅读器中的原图与中文译图并排对照。'],
    enlarge: '查看完整截图', close: '关闭截图', galleryName: '浏览插件截图',
    screenshotNote: "真实产品截图：中文界面，原图与中文译图并排展示。翻译效果因内容而异，漫画作品归各自权利人所有。",
    sourcesEyebrow: "本地文件、云端书库与漫画网站", sourcesTitle: "打开你有权访问的藏书。",
    sources: [
    [
      "本地漫画与 EPUB",
      "支持 CBZ／ZIP、CBR／RAR、PDF、无 DRM MOBI 和 EPUB。EPUB 翻译仅处理内嵌位图，不翻译正文。",
      "了解文件格式"
    ],
    [
      "Google Drive",
      "从自己的 Drive 选择 CBZ／ZIP 或无 DRM MOBI，按需打开受支持的书籍。",
      "了解来源阅读"
    ],
    [
      "OPDS 远程书库",
      "连接多个书库，按需浏览、搜索与阅读。来源提供相应能力时，可同步阅读进度。",
      "连接 OPDS 书库"
    ],
    [
      "已适配的漫画网站",
      "查找作品、核对访问条件后加入书架。其他网页也可翻译图片或划取可见选区，但不能直接导入书架。",
      "了解网页翻译与阅读"
    ]
  ],
    modesEyebrow: "图片翻译", modesTitle: "选择图片交给哪个服务处理。",
    modes: [["NodeLane 官方服务", "登录后使用账户额度，由官方服务处理图片。本地译图缓存缺失时，可取回仍有效的已有结果。"], ["自己的 manga-translator-ui", "填写 MTU 服务地址与凭据，无需 NodeLane 账号，不消耗官方额度；处理方式和 API 费用由你的配置决定。"]],
    controlNote: "新漫画默认显示原图。需要翻译时，选择渠道和目标语言即可。",
    privacyTitle: "免费阅读，按需选择翻译套餐。", privacyBody: "NodeLane Comics 提供免费插件与按账户计量的云端翻译服务。套餐受速率与服务容量限制；订阅前可查看实时购买状态、完整权益和账单规则。",
    privacy: '隐私政策', pricing: "对比 Free 与 PLUS / Pro", ctaTitle: "从下一页，读懂更多。", ctaBody: "为桌面 Chrome、Edge 或 Firefox 安装 NodeLane Comics。",
  };

export default copy;
