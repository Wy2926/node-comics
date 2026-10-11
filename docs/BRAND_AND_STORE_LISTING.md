# 产品名称与 Chrome 应用商店文案

产品名称与当前扩展包的简短描述在插件语言字典维护，官网入口为 `https://comics.nodelane.net/`。商店后台的详细描述和截图单独维护；对外文案应与实际发布包及服务能力一致。

## 名称

| 使用位置 | 简体中文 | 英文 |
| --- | --- | --- |
| 产品品牌 | NodeLane 漫译 | NodeLane Comics |
| 简称 | 漫译 | NodeLane Comics |
| 商店标题 | NodeLane 漫译 - AI 漫画翻译与阅读器 | NodeLane Comics - AI Manga Translator & Reader |
| 宣传语 | 边看边译，读懂每一格。 | Translate as you read. Enjoy every panel. |

品牌统一使用 NodeLane 大小写，与 nodelane.net 对应。中文“漫译”直接表达漫画翻译；英文 Comics 保留漫画产品定位，标题以 Manga Translator & Reader 说明主要用途。产品界面使用品牌短名，商店标题承担功能说明。工程目录、包名和内部标识不需要随展示名称改动。

界面字典与构建生成的 Chrome 本地化元数据共用文案来源，详见[界面国际化](UI_INTERNATIONALIZATION.md)。仅更新商店详细描述不会改变已上传的软件包或其简短描述。

## 简短描述

简短描述统一维护在插件的 16 种语言字典中，商店使用已上传软件包中的本地化文案；更改须随新包上传生效。不在同一标题或简介里并排堆叠两个语言版本。

中文（36 字符）：

> 用 AI 边看边译网页与本地漫画，随时对照原图与译图，自动保存阅读进度。

英文（98 字符）：

> Translate comics as you read, compare originals and translations, and open your local comic files.

## 中文详细描述

NodeLane 漫译帮助你在浏览器里阅读漫画、翻译页面，并继续上次的阅读进度。

- 随读随译：选择目标语言，逐页查看翻译结果，随时切回原图或并排对照。
- 集中阅读：导入支持的网页漫画、本地漫画文件或 Google Drive 漫画，放入书架继续阅读。
- 找到想看的漫画：查看作品资料，按名称或别名搜索已适配网站。
- 离线续读：提前缓存支持的网站漫画，缓存完成的章节可离线阅读。
- 自选翻译渠道：使用官方服务，也可连接自行部署的翻译服务。

本地原图阅读无需登录。官方翻译需要联网和登录，提供免费额度及可选付费套餐，具体权益以账户页面为准。自行部署的翻译服务无需 NodeLane 账号。

使用官方翻译时，所选页面图片会上传处理。原图在任务完成、失败或取消后删除，有效翻译结果保留用于恢复与复用，详情见隐私政策。

网站导入仅支持已适配站点，不绕过访问限制。翻译可能出现错误，可随时对照原图。请仅阅读和翻译你有权使用的内容。

官网：https://comics.nodelane.net/

## English full description

NodeLane Comics helps you read comics in your browser, translate pages, and pick up where you left off.

- Translate as you read: Choose a target language, view results page by page, and switch back to originals or compare them side by side.
- Read in one place: Import comics from supported websites, local comic files, or Google Drive and keep reading from your bookshelf.
- Find comics: View work details and search supported websites by title or alternative names.
- Continue offline: Cache comics from supported websites in advance. Fully cached chapters can be read offline.
- Choose a translation service: Use the official service or connect a translation service you host yourself.

Reading local originals does not require sign-in. Official translation requires an internet connection and sign-in, with a free allowance and optional paid plans. The benefits shown in your account apply. A self-hosted translation service does not require a NodeLane account.

When you use official translation, selected page images are uploaded for processing. Original images are deleted after a task completes, fails, or is canceled. Valid translation results are retained for recovery and reuse. See the privacy policy for details.

Website import works only with supported sites and does not bypass access restrictions. Translations may contain errors; you can compare them with the originals at any time. Read and translate only content you have the right to use.

Website: https://comics.nodelane.net/

## 本地化与发布依据

- 简介用自然语言说明主要用途，不罗列文件格式缩写或重复关键词。详细兼容范围放官网或[导入格式与缓存](IMPORT_FORMATS_AND_CACHE.md)；网页能力见[网页内翻译](IN_PAGE_TRANSLATION.md)。
- 名称不超过 75 字符，简介不超过 132 字符；上述中英文标题分别为 25、46 字符，简介分别为 36、98 字符。
- 详细描述按上述中英文语义同步为 16 种语言。商店条目语言与应用内语言偏好分别管理；商店详细描述可独立保存草稿，名称和简介随软件包更新。
- 文案须与发布包及生产服务一致。不承诺排名提升、所有网站、所有语言、无限免费或即时完成，不写固定价格或额度。
- 官方翻译与自建服务的登录要求分别说明；图片上传与保留文案遵循[存储规则](OBJECT_STORAGE.md)。翻译语言选项不代表所有源语言已完成效果验收，详见[语言支持](NODE_CONFIGURATION.md#目标语言与节点能力)。

商店规范参考：

- [Creating a great listing page](https://developer.chrome.com/docs/webstore/best-listing)：标题清晰、简洁、有区分度，简介突出主要用途，说明排名与使用表现有关。
- [Manifest name](https://developer.chrome.com/docs/extensions/reference/manifest/name)：名称长度和本地化。
- [Manifest description](https://developer.chrome.com/docs/extensions/reference/manifest/description)：简介长度和本地化。
- [Listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)：信息须准确，禁止无关或过量关键词。

## 推广规范

面向海外漫画读者与浏览器扩展社区，优先英文介绍随读随译、原图对照和续读体验。以开发者身份说明产品，按社区调整内容，发布前核对当前规则与安装入口；不跨社区复制刷帖。截图使用已授权素材，展示真实翻译结果和当前功能；功能、价格和可用性以实际发布版本为准。

品牌图形与导出入口见[素材说明](../output/imagegen/nodelane-logo-v1/README.md)。
