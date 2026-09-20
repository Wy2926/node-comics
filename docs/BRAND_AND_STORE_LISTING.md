# 产品名称与 Chrome 应用商店文案

日期：2026-09-20。交付状态：用户已采纳中英文名称；客户端名称、manifest 名称与简介已接入 15 种语言字典，尚未发布商店。官网为 https://comics.nodelane.net/ 。

## 名称

| 使用位置 | 简体中文 | 英文 |
| --- | --- | --- |
| 产品品牌 | NodeLane 漫译 | NodeLane Comics |
| 简称 | 漫译 | NodeLane Comics |
| 商店标题 | NodeLane 漫译 - AI 漫画翻译与阅读器 | NodeLane Comics - AI Manga Translator & Reader |
| 宣传语 | 边看边译，读懂每一格。 | Translate as you read. Enjoy every panel. |

品牌统一使用 NodeLane 大小写，与 nodelane.net 对应。中文“漫译”直接表达漫画翻译；英文 Comics 保留漫画产品定位，标题以 Manga Translator & Reader 说明主要用途。产品界面使用品牌短名，商店标题承担功能说明。工程目录、包名和内部标识不需要随展示名称改动。

客户端品牌与 manifest 已统一到上表。界面字典与构建生成的 Chrome 本地化元数据共用文案来源，详见[界面国际化](UI_INTERNATIONALIZATION.md)。商店后台的详细描述与截图仍需在发布时填写。

## 商店简短描述

以下分别用于中文与英文条目；不在同一标题或简介里并排堆叠两个语言版本。

中文（72 字符）：

> AI 漫画翻译与漫画阅读器，支持网页漫画和本地文件。边看边译、原图译图对照，导入 CBZ、CBR、PDF 和未加密 MOBI，自动保存阅读进度。

英文（131 字符）：

> AI manga translator and comic reader for manga, manhwa and manhua. Translate as you read, compare originals and import local files.

## 中文详细描述

NodeLane 漫译是一款集 AI 漫画翻译与漫画阅读器于一体的浏览器插件。将支持的网页漫画或本地文件放入阅读器，选择目标语言，边看边译，随时对照原图与译图。

- 边看边译：开启自动翻译后，随阅读进度处理当前页和后续页面，逐页显示翻译结果。
- 网页漫画翻译：在支持的网页中显示译图，也可将漫画图片导入独立阅读器。
- 沉浸阅读：支持连续滚动、单页阅读、左右阅读方向、缩放和全屏，自动记录阅读位置。
- 原图译图对照：随时切换原图与译图，切换时保留阅读位置。
- 本地漫画导入：支持图片、CBZ/ZIP、CBR/RAR、PDF 和未加密 MOBI 漫画。
- 整理与保存：管理作品和章节，将原图或译图导出为 CBZ、图片 ZIP 或 PDF。
- 翻译方式：提供常规翻译与 AI 重绘翻译，可选语言与使用权益以账户内显示为准。

阅读本地原图无需登录；翻译需要登录和网络连接，并受账户权益与额度限制。发起翻译的图片会上传至云端处理。网页兼容性和翻译效果取决于站点结构、图片质量及语言支持。

官网：https://comics.nodelane.net/

## English full description

NodeLane Comics combines an AI manga translator with a dedicated comic reader. Bring comics from supported websites or import local files, choose a target language, and translate as you read. Keep the original pages available for comparison.

- Translate as you read: enable automatic translation to process the current page and upcoming pages, with results appearing page by page.
- Read on the web: display translations on supported pages or bring comic images into the dedicated reader.
- Read comfortably: use continuous scrolling or single-page mode, choose your reading direction, zoom in, and go full screen. Your reading position is saved automatically.
- Compare originals and translations: switch views without losing your place.
- Import local comics: open images, CBZ/ZIP, CBR/RAR, PDF, and DRM-free MOBI comics.
- Organize and export: manage works and chapters, and export original or translated pages as CBZ, image ZIP, or PDF.
- Choose a translation mode: use standard translation or AI redraw translation. Available languages and access depend on the options shown in your account.

Use NodeLane Comics to read manga, manhwa, manhua, and other image-based comics in one place.

Reading local originals does not require an account. Translation requires sign-in and an internet connection and is subject to account entitlements and usage limits. Images submitted for translation are uploaded for cloud processing. Website compatibility and translation quality depend on site structure, image quality, and language support.

Website: https://comics.nodelane.net/

## 搜索与发布依据

- 中文标题自然包含“漫画翻译”和“阅读器”；英文标题包含 Manga Translator 与 Reader，简介补充 comic reader、manhwa、manhua。此关键词取舍依据功能与搜索意图，不是已验证的搜索量或排名权重。
- NodeLane 提供品牌区分和域名关联。避免仅使用泛称“漫画翻译器”，也不在标题罗列同类品牌或重复关键词。
- 名称不超过 75 字符，简介不超过 132 字符；上述中英文标题分别为 25、46 字符，简介分别为 72、131 字符。
- 通过扩展本地化机制分别提供名称与简介，并在商店后台提供对应语言的详细描述与截图。客户端已实现 15 种界面语言；商店后台的条目语言与应用内语言偏好分别管理。
- Google 官方说明排名会考虑用户评价以及下载、卸载等使用统计。此方案旨在提高用途辨识和相关性，不承诺排名提升或具体名次。
- 文案基于当前仓库声明的功能范围。正式上架时须与发布包和生产服务一致；仅展示可用的翻译模式和语言，不宣称支持所有网站、所有语言、无限免费或即时完成。
- 当前产品语言选项不等于源语言 OCR 已完成效果验收，详见[语言支持](LANGUAGE_SUPPORT.md)。格式边界见[导入格式与缓存](IMPORT_FORMATS_AND_CACHE.md)，网页能力见[网页内翻译](IN_PAGE_TRANSLATION.md)。

官方依据（2026-09-20 查阅）：

- [Creating a great listing page](https://developer.chrome.com/docs/webstore/best-listing)：标题清晰、简洁、有区分度，简介突出主要用途，说明排名与使用表现有关。
- [Manifest name](https://developer.chrome.com/docs/extensions/reference/manifest/name)：名称长度和本地化。
- [Manifest description](https://developer.chrome.com/docs/extensions/reference/manifest/description)：简介长度和本地化。
- [Listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)：信息须准确，禁止无关或过量关键词。
