import type { HomeCopy } from './types';

const copy: HomeCopy = {
  comparison: { title: '同一页，多种语言。', group: '翻译效果对照', labels: ['日文原图', '中文', '英文', '韩文'], loading: '正在加载图片…', error: '图片加载失败。', retry: '重新加载', caption: '已记录的常规翻译实测效果' },
    eyebrow: "你的藏书，你的来源，你的节奏", title: ["在浏览器里看漫画，","需要时，随读随译。"],
    description: "在 Chrome、Edge、Firefox 中阅读漫画与 EPUB。打开本地文件，连接 Google Drive、OPDS 或已适配网站；图片翻译可用官方服务，也可用自己的 manga-translator-ui。",
    install: '获取插件', seeReader: '看看阅读器', desktop: '为桌面阅读设计',
    readerPath: "漫画与书库，汇入同一个阅读器", readerAccess: "阅读原图无需 NodeLane 账号。官方翻译使用账户额度，自建 MTU 无需登录 NodeLane；来源自身的访问条件仍需满足。",
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
    stepsTitle: '三步，打开下一本。', stepsIntro: "安装插件，打开书籍或连接来源，再选择适合自己的阅读方式。",
    steps: [['安装浏览器插件', "选择桌面浏览器对应的商店或安装包，安装后固定到工具栏。"], ["打开漫画或书库", "导入本地漫画与 EPUB，连接 Google Drive、OPDS，或从已适配网站选择作品。"], ["需要时，开启翻译", "先读原图，再选择翻译渠道与目标语言；随时对照图片，从保存的位置继续。"]],
    compareEyebrow: '看清每一页', compareTitle: '看懂译文，也保留原图。',
    compareBody: "切换查看日文原图和已记录的常规翻译结果。阅读器中可切换原译图，也可并排对照，继续保持阅读位置。",
    compareNote: '原创 AI 插画上的常规翻译实测样例。效果因画面、文字和语言而异。', compareLink: '了解翻译方式',
    readerEyebrow: '六个画面，看看里面', readerTitle: '从下一本，到下一页。', readerBody: "发现作品、跨站搜索、放进书架、缓存后离线阅读。截图展示真实产品界面；OPDS 与 EPUB 同样使用阅读器的工具和偏好设置。",
    galleryLabels: ['我的漫画', '发现漫画', '搜索漫画', '离线中心', '阅读与目录', '原图与译图'],
    galleryBodies: ["导入和管理漫画，从保存的阅读位置继续。", "浏览 AniList 榜单、简介、评分和别名，也可翻译书名与简介。", "按书名或别名搜索已适配网站，也可先翻译名称，再选择来源。", "缓存所选语言与章节，查看空间占用，暂停继续并补齐失败页。", "浏览章节与语言选项，查看页数、缓存状态和阅读进度。", "并排对照原图与常规译图，或切回原图，保持阅读位置。"],
    galleryAlt: ['中文界面的漫画书架与阅读进度。', '中文界面的漫画发现榜单与作品详情。', '中文界面的漫画名称、网站选择与搜索结果。', '中文界面的离线缓存任务、章节进度与空间占用。', '中文阅读器与展开的多语言章节目录。', '中文阅读器中的原图与中文译图并排对照。'],
    enlarge: '查看完整截图', close: '关闭截图', galleryName: '浏览插件截图',
    screenshotNote: '与项目介绍共用的真实截图，以中文界面展示；点击可查看完整原图。功能可能因安装版本而异，漫画作品归各自权利人所有。',
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
    modesEyebrow: "常规图片翻译", modesTitle: "选择图片交给哪个服务处理。",
    modes: [["NodeLane 官方服务", "登录后使用账户额度，由官方服务处理图片。本地译图缓存缺失时，可取回仍有效的已有结果。"], ["自己的 manga-translator-ui", "填写 MTU 服务地址与凭据，无需 NodeLane 账号，不消耗官方额度；处理方式和 API 费用由你的配置决定。"]],
    controlNote: "新漫画默认显示原图。插件使用常规方式翻译漫画图片，需要时再选择渠道。",
    privacyTitle: '了解漫画图片如何处理。', privacyBody: '官方翻译将所选图片发送到服务端，原图在任务完成、失败或取消后清理。账户的私有结果在仍有有效请求时保留；游客的服务器结果自任务结束起保留 24 小时，本地已保存的译图不受此期限影响。连接本地翻译服务时，图片处理与保留由该服务决定。',
    privacy: '隐私政策', pricing: '套餐与额度', ctaTitle: '准备好翻开下一页了吗？', ctaBody: "打开书籍，连接书库，找到适合你的阅读节奏。",
  };

export default copy;
