# 官网素材来源

## 产品素材

| 素材 | 来源与使用规范 |
| --- | --- |
| [`../../docs/images/`](../../docs/images/) / [`../../docs/images/en/`](../../docs/images/en/) | 与中文、英文项目 README 共用的真实截图：首页选用翻译对照截图，以构建生成的响应式 WebP 预览；简中、繁中页面展示中文界面，其余页面展示英文界面。界面内漫画归各自权利人，不能作为原创素材重新授权 |
| `journey-original.webp` / `reading-corner.webp` | 原创 AI 插画，gpt-image-2、high；提示词见 [hero.txt](assets/prompts/hero.txt)、[reading.txt](assets/prompts/reading.txt) |
| `journey-translated.webp` / `journey-en.webp` / `journey-ko.webp` | 用户提供并确认为常规翻译实测产物的中／英／韩对照图 |
| `public/social-cover.webp` | 阅读角插画的 1200 × 630 分享图 |
| Logo / favicon | 复用插件品牌资源，深色布局使用插件原始 `logo-horizontal-en-dark.webp` / `logo-horizontal-zh-dark.webp` 的本地副本；命名见[品牌规范](../../docs/BRAND_AND_STORE_LISTING.md) |
| [GitHubMark.astro](src/components/GitHubMark.astro) | GitHub 官方 [Octicons mark-github-16](https://github.com/primer/octicons/blob/90af1f14984832de34e94b2d530043fbcf85eb7f/icons/mark-github-16.svg)，固定版本 `90af1f14984832de34e94b2d530043fbcf85eb7f`；保留原始轮廓，仅使用 `currentColor` 和 20px 显示尺寸。上游 SVG SHA-256：`7421820090b50ac79d7c2bf7c951a433d7098a8a9c474809207bdd45f62d9d46`；[MIT 许可](public/licenses/octicons.txt)随静态产物分发 |

首页展示一张真实翻译对照截图。预览保持完整画面，按屏幕尺寸选择 WebP；首页点击后打开完整 PNG 原图，不重画 UI 或修改截图文字。英文界面截图中的译文为中文，图注明确说明，不冒充英／西／德翻译实测。生成插画不重新授予第三方开源许可，系统字体只作栅格化使用。

保留的教程素材同样来自上述真实产品截图，不冒充视频截帧；视频链接统一维护在 `src/data/site.ts`。官网不嵌入播放器或加载远程视频缩略图，首页不再展开教程卡片。

漫画星芒、隐私盾牌和播放标识由 [ComicSymbol.astro](src/components/ComicSymbol.astro) 绘制为静态 SVG，线条与颜色复用官网令牌中的漫画图标调色板；无外部素材、字体、运行脚本或网络请求。语言菜单的国旗由 [LanguageFlag.astro](src/components/LanguageFlag.astro) 复用插件已有的 [flag-icons 7.5.0](https://github.com/lipis/flag-icons/tree/v7.5.0/flags/4x3) 原始 SVG，复制至官网自身素材目录；保留原始轮廓，以内联 data URL 显示，不产生外部或额外图片请求。[MIT 许可](public/licenses/flag-icons.txt)随官网静态产物分发，图标只作装饰，语言名称保留为文本。

| 国旗素材 | 对应语言 | 上游 SVG SHA-256 |
| --- | --- | --- |
| [src/assets/flags/sa.svg](src/assets/flags/sa.svg) | العربية | `5738c8cfca5fea63587cbcf69237996c8ce6283f8016853150686f37311b620e` |
| [src/assets/flags/cn.svg](src/assets/flags/cn.svg) | 简体中文 | `981da9bdf82d48e31691f20578cefcb26cf7d0bd95e4ebd5c0df00bdfe988c1a` |
| [src/assets/flags/tw.svg](src/assets/flags/tw.svg) | 繁體中文 | `931757f06b9ee751fd1a0cc8dd7cf862e21fdcaf894d10ed7bcc68dabcca59ad` |
| [src/assets/flags/us.svg](src/assets/flags/us.svg) | English | `e7be4240cf57987926673708f09233be1ab6bdf35acc7b86bd32a263f197a2a7` |
| [src/assets/flags/jp.svg](src/assets/flags/jp.svg) | 日本語 | `bfea80baf9989383dc4bf7ca594ed95be0df0ff125bfc88d0bfa878eb0198022` |
| [src/assets/flags/kr.svg](src/assets/flags/kr.svg) | 한국어 | `7a6cd5b51d0e2841ed8b79b1147ad8a66cf3c09f6344d4a63b5e4413ffa5d15b` |
| [src/assets/flags/fr.svg](src/assets/flags/fr.svg) | Français | `8cdacc8d79bcf210cdca2777a2c0de1f9e5862526877bd3026c9d59ecdcd4578` |
| [src/assets/flags/es.svg](src/assets/flags/es.svg) | Español | `f9cfaff858e95f830733ade9591037b5322dfb5827a53b70956a3d190bb49b9a` |
| [src/assets/flags/br.svg](src/assets/flags/br.svg) | Português (Brasil) | `b0a912826c3ffd7287435ebed66e18fe058e992309c00dc10b430dd41a29ba91` |
| [src/assets/flags/de.svg](src/assets/flags/de.svg) | Deutsch | `efd480af5a154a7651f29da23ee0d09dbc892410fb4041898ddf8face336c575` |
| [src/assets/flags/it.svg](src/assets/flags/it.svg) | Italiano | `9fa88118818d9b64838f578e2babcca3d0630aed21b5c33b34aff7ac5ce506bc` |
| [src/assets/flags/ru.svg](src/assets/flags/ru.svg) | Русский | `7100aaae51ff3b6a2bf0ca932b3bc518bdc760814725e7cca31d821a26c3dd7c` |
| [src/assets/flags/pl.svg](src/assets/flags/pl.svg) | Polski | `369bb3e14ee718df1ee15fd2fb3ad0dae713f78f622e277710fb2b30a313f2aa` |
| [src/assets/flags/ua.svg](src/assets/flags/ua.svg) | Українська | `2d869c23ebfefb2ae0a633297c11dee06fcb666ce7b3ca75eba09b7a1a3a03ac` |
| [src/assets/flags/tr.svg](src/assets/flags/tr.svg) | Türkçe | `256a1d6afbedb9f731566982331a1cd1ad14aba211b8a61d338855879505e74f` |
| [src/assets/flags/vn.svg](src/assets/flags/vn.svg) | Tiếng Việt | `2355037201315d74581ab0ad60b5587a29a087d26b0525bdeb8676e64fae5b86` |
| [src/assets/flags/id.svg](src/assets/flags/id.svg) | Bahasa Indonesia | `5cd3acc4939dd7eae6318c8d75df8c0d1733f650e2504a2635b0dbf3dfabb040` |

| 产物 | SHA-256 |
| --- | --- |
| [src/assets/journey-original.webp](src/assets/journey-original.webp) | `491d167fbb8460b59346f8b13dd2ba7dfd32d7d52145c2ebff0bfaf0336ad499` |
| [src/assets/journey-translated.webp](src/assets/journey-translated.webp) | `47c90681880b9e1f98481d5e9e92e190a680100d21d3b5a2d66c47b544801a98` |
| [src/assets/journey-en.webp](src/assets/journey-en.webp) | `7cf086e17271406df6f193d145995508b7757373d14485c716012186c601d9a1` |
| [src/assets/journey-ko.webp](src/assets/journey-ko.webp) | `5ef144b6df6f8f224137c772d1b80702f5f6659f99a6e0b97ce5e2dbf2644fa3` |
| [src/assets/reading-corner.webp](src/assets/reading-corner.webp) | `58fe02d84ca2a235fca477e1a7b90d96094618a42f78728daa792a45444a4127` |
| [public/social-cover.webp](public/social-cover.webp) | `6c6dba9712a00be1312673373e26f8a289a6d14cc6a1dc26277e72c11dc8c322` |
| [src/assets/logo-zh.webp](src/assets/logo-zh.webp) | `3bab8e6227e9a68de9d2cc2f34a1cb0d60ad1de15e937294e87d602ece0add7a` |
| [src/assets/logo-en.webp](src/assets/logo-en.webp) | `abac28ef1514504dfcfee05374a85d230987809ce906cd08d864f19d79801023` |
| [src/assets/logo-en-dark.webp](src/assets/logo-en-dark.webp) | `8839d406415ea21d39a6cf90f34b257a11cd73a978c46df7bda45afe6ffb4143` |
| [src/assets/logo-zh-dark.webp](src/assets/logo-zh-dark.webp) | `13f4247055ce0ffe62e8e71d3839b7a945b8decc97b08ea1493b51877aa165a4` |
| [public/icon-128.png](public/icon-128.png) | `a83fe892bb1599baaba3c8c11f2a19ce10cff2560956c3072cde57f20f52da53` |
| [public/favicon.ico](public/favicon.ico) | `6ec5ace09c14e6a3865397956490a92488059b8ac07fee995907670b529017c2` |

## 控件图标

勾选与箭头使用 GitHub 官方 Octicons，固定版本 `90af1f14984832de34e94b2d530043fbcf85eb7f`，保留原始路径，以 CSS mask 随文本着色。[MIT 许可](public/licenses/octicons.txt)随静态产物分发。

| 本地素材 | 原始来源 | SHA-256 |
| --- | --- | --- |
| [check.svg](public/icons/check.svg) | [check-16.svg](https://github.com/primer/octicons/blob/90af1f14984832de34e94b2d530043fbcf85eb7f/icons/check-16.svg) | `290b457841652beccbc8478a4dec5c41021cc1aa081224f968393cbedeca1e83` |
| [arrow-right.svg](public/icons/arrow-right.svg) | [arrow-right-16.svg](https://github.com/primer/octicons/blob/90af1f14984832de34e94b2d530043fbcf85eb7f/icons/arrow-right-16.svg) | `9c996093e7605103d462a873f18d2e6de9ad66b03c212a4eaf0ac720ceebe4f5` |

## 浏览器商店标识

首页和下载页使用 Google Chrome、Microsoft Edge 和 Mozilla Firefox 的原始彩色标识，本地提供资源，用于标识对应浏览器及商店入口。商标归各品牌所有，不表示合作或背书，不作为本站原创素材重新授权。

Android 和 iOS 教程入口使用 [Simple Icons 16.0.0](https://github.com/simple-icons/simple-icons/tree/16.0.0) 的 Android／Apple 标识，保留原始路径，仅分别添加绿色和浅色填充以适配官网深色背景。[CC0 1.0 许可](public/licenses/simple-icons.txt)随静态产物分发；许可不授予商标权。iOS 当前为“适配中”状态页，不使用模拟截图。

## Android Firefox 教程截图

六张原始 PNG 来自专用 Android 14 模拟器、实际 Firefox 157.0.1，尺寸均为 1080×2400（9:20）。01 是 Firefox 欢迎页，02 是实际 AMO 页面及添加按钮，03 是原图模式的真实阅读器（1/1 页）。截图保留浏览器操作区、提示与 AMO 安全提醒，未经拼接或改写。简繁中文共用 zh-CN，其余语言使用 en；图注随页面本地化。

阅读器使用 AMO 同版、Mozilla 签名的 NodeLane Comics 0.10.3 XPI，经官方 web-ext 临时加载。模拟器上的商店／文件永久安装未确认；这些图片不表示实体手机商店安装全流程通过。试读使用项目原创 `samples/starlight-bookshop.png` 制成单页 CBZ，经真实文件选择器导入；两版只切换界面语言，漫画仍是英文原图，不是翻译或授权登录证明，未进行账号登录或付费翻译。第三方浏览器／商店 UI 与商标归各自权利人，不重新授权为本站原创素材。

| 文件 | SHA-256 |
| --- | --- |
| [public/guides/firefox/en/01-firefox-open.png](public/guides/firefox/en/01-firefox-open.png) | `f98f47e4ad2d0648fa037e19d8cec11ec0593d0b58a8a802a31a0516af6bbd4e` |
| [public/guides/firefox/en/02-add-extension.png](public/guides/firefox/en/02-add-extension.png) | `71dfd5fc7cfe70eb032e567f839ad6bd86dbf12ed095815ee0080a5fab9fa611` |
| [public/guides/firefox/en/03-read-sample.png](public/guides/firefox/en/03-read-sample.png) | `a9795962763b18ff3125f754ccfcd01b03810205363307aa49a1fab89a3e5a00` |
| [public/guides/firefox/zh-CN/01-firefox-open.png](public/guides/firefox/zh-CN/01-firefox-open.png) | `f29fa8988f3682deb1fec1685154c58591b3f8c542cffedfe16314167813f64c` |
| [public/guides/firefox/zh-CN/02-add-extension.png](public/guides/firefox/zh-CN/02-add-extension.png) | `8889c35b628c21f1f6b729c282016a463e96dc516df45e8429bfb08c2029c471` |
| [public/guides/firefox/zh-CN/03-read-sample.png](public/guides/firefox/zh-CN/03-read-sample.png) | `e9f28f00d417149c8cd741c05a3cacbe7f65c205506aeadbdebd27d41eba1624` |

## 浏览器与平台标识摘要

| 文件 | 固定版本来源 | 本地 SHA-256 |
| --- | --- | --- |
| [android.svg](public/browsers/android.svg) | [Simple Icons 16.0.0 / Android](https://github.com/simple-icons/simple-icons/blob/16.0.0/icons/android.svg) | `400d686d4ce859395e374febaa56bdf561658595923be4404d7dcde7a8c73fea` |
| [apple.svg](public/browsers/apple.svg) | [Simple Icons 16.0.0 / Apple](https://github.com/simple-icons/simple-icons/blob/16.0.0/icons/apple.svg) | `5757c99cbf159b9c60af004cfa15600a35bc6618bc18449cff5c6635b66a029c` |

| 文件 | 来源 | SHA-256 |
| --- | --- | --- |
| [public/browsers/chrome.svg](public/browsers/chrome.svg) | [官方来源](https://www.google.com/chrome/static/images/chrome-logo.svg) | `2bb1a2c9b9ae4d36f62ea53811554636cf3c5b74d9845e1dbacca0ce62dc7880` |
| [public/browsers/firefox.svg](public/browsers/firefox.svg) | [官方来源](https://raw.githubusercontent.com/mozilla/protocol-assets/master/logos/firefox/browser/logo.svg) | `f8301ac5f5dd3ca962db4283c1148e9a90ffcebe690ec83cedad88107d449f79` |
| [public/browsers/edge.png](public/browsers/edge.png) | [官方来源](https://edgecdn-embza6g8cacagcbn.z01.azurefd.net/welcome/static/favicon.png) | `4d755ac02a070a1b4bb1b6f1c88ab493440109a8ac1e314aaced92f94cdc98e9` |
