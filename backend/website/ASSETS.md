# 官网素材来源

## 产品素材

| 素材 | 来源与使用规范 |
| --- | --- |
| [`../../docs/images/`](../../docs/images/) / [`../../docs/images/en/`](../../docs/images/en/) | 与中文、英文项目 README 共用的真实产品和教程截图。界面内漫画归各自权利人，不能作为原创素材重新授权 |
| [src/assets/home/](src/assets/home/) | 首页真实网页翻译、搜索截图及用户提供的黑白／彩色多语言对照，来源与摘要见下文 |
| `journey-original.webp` / `reading-corner.webp` | 原创 AI 插画，gpt-image-2、high；提示词见 [hero.txt](assets/prompts/hero.txt)、[reading.txt](assets/prompts/reading.txt) |
| `journey-translated.webp` / `journey-en.webp` / `journey-ko.webp` | 用户提供并确认为翻译实测产物的中／英／韩对照图 |
| `public/social-cover.webp` | 阅读角插画的 1200 × 630 分享图 |
| Logo / favicon | 复用插件品牌资源，深色布局使用插件原始 `logo-horizontal-en-dark.webp` / `logo-horizontal-zh-dark.webp` 的本地副本；命名见[品牌规范](../../docs/BRAND_AND_STORE_LISTING.md) |
| [GitHubMark.astro](src/components/GitHubMark.astro) | GitHub 官方 [Octicons mark-github-16](https://github.com/primer/octicons/blob/90af1f14984832de34e94b2d530043fbcf85eb7f/icons/mark-github-16.svg)，固定版本 `90af1f14984832de34e94b2d530043fbcf85eb7f`；保留原始轮廓，仅使用 `currentColor` 和 20px 显示尺寸。上游 SVG SHA-256：`7421820090b50ac79d7c2bf7c951a433d7098a8a9c474809207bdd45f62d9d46`；[MIT 许可](public/licenses/octicons.txt)随静态产物分发 |

首页截图和对照图按屏幕尺寸生成 WebP，保持画面比例，点击可打开大图；不重画 UI 或修改截图文字。网页翻译截图是 MangaPill 同页、同位置的英文原图与繁体中文译图；搜索截图是加载完成后的 Atsumaru／MangaPill 两个结果。各语言首页共用这些真实界面，不冒充对应语言的操作实测。黑白对照原图是日文，提供简中／繁中／英文／韩文译图；彩色原图是繁中，提供简中／英文／日文／韩文译图。生成的设计稿不作为产品素材使用。漫画与站点 UI 归各自权利人，用户提供素材不意味着重新授予许可；生成插画不重新授予第三方开源许可。

### 首页素材摘要

`inline-*` 与 `search.png` 来自本机真实浏览器、插件界面；`mono-*` 与 `color-*` 来自用户提供的“对比图”目录，按语言重命名保留内容。以下摘要对应构建前文件：

| 文件 | SHA-256 |
| --- | --- |
| `inline-original.png` | `81e671b21b23d2093de60250ec1c19ab8665ed0e0d72454ec04fe3a898c18503` |
| `inline-translated.png` | `2ab2e975515e87e6c794f974dbf195e63f5e307d2de793bbda8ef249acf44acc` |
| `search.png` | `f79aab5a9045ad4b42fd728f020fee7ac5896ac4d749a93cb51d720ae54721a3` |
| `mono-original.png` | `575a5436b203fd2d9d8acd6d0492d2a86c7b2364e894640ac59db7151e71b2c5` |
| `mono-zh-CN.webp` | `5cd0eab0d2cacf63b68196d54278e62eacb10a6bbe3fffff4cc3cb049ce6682f` |
| `mono-zh-TW.webp` | `5b7ee470d577f15586f61e1a599701bb2a33953bd62636445cb685abf55feb5e` |
| `mono-en.webp` | `4c4b1bf040788c5cda48bb5b6d182db43e8d32f6cc81626085738f729b3e7641` |
| `mono-ko.webp` | `e1a163389cf936ae119409e3a5bd9bed9393901101b44e4dd383bf6148fec085` |
| `color-original.jpg` | `08f6c46135f6f91cf1c92ca67dcc92f1154d7c1e3125a63762630bcbc2532ae3` |
| `color-zh-CN.webp` | `b907938d582308c2841e0e53dd73816ef891ca005acc9390f5ebdbb40308b4b9` |
| `color-en.webp` | `e2b8d9aa509a75bf59eecd2df11089857434ec922be108d7dc310784775fb966` |
| `color-ja.webp` | `51c1b165a1621e053bcb37c7f45fb87a246061cc0b04dcbe3984cf2e3207f085` |
| `color-ko.webp` | `90dc8175806bbe187ff632ddca496753fe8e686975800b749aeec7d367f29e0d` |

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

## 桌面教程截图

[src/assets/guides/](src/assets/guides/) 是 Chrome 中实际运行的 NodeLane Comics 0.11.2 界面，1440 × 960，以 WebP（质量 92）保存，没有重画 UI、拼接或替换文字。每个场景分别切换简体中文、日语、韩语、英语后截图，八个场景共 32 张；简繁中文页面共用中文截图，日语、韩语页面使用对应版本，其余语言使用英文截图。远程书库中文版来自浏览器原生截图，日、韩、英版来自用户提供的 PNG 截图，仅转换为 WebP；其余场景直接使用浏览器原生 WebP 截图。页面通过 Astro 生成响应式小图，点击查看原图；只加载当前页面所需图片，不增加客户端图库框架。

本地书库、目录和阅读设置使用项目原创 [starlight-bookshop.png](../../samples/starlight-bookshop.png) 导入的单页示例；四版漫画均为英文原图，不表示翻译效果。搜索是 Atsumaru／MangaPill 的真实结果；远程书库展示用户已连接的 wol.moe / Wenku8 OPDS 总收藏榜，保留书库返回的中文标题和封面。漫画封面、站点名称与第三方 UI 归各自权利人，不作为本站原创素材重新授权。截图未展示其他个人书库内容、凭据或令牌，连接表单没有填入地址。

翻译设置与渠道表单只说明入口和配置界面，不表示官方翻译结算、翻译服务连接或账号授权已经验证。远程书库截图说明已连接目录可浏览，不证明书籍下载、阅读或进度同步全流程；英文图右下方的封面占位、日文图的悬停按钮均保留用户截图原貌。日语、韩语界面仍有部分搜索与 OPDS 文案回退到英文，截图如实保留。下面的摘要对应构建前原始 WebP：

| 文件 | SHA-256 |
| --- | --- |
| [src/assets/guides/en/channel-form.webp](src/assets/guides/en/channel-form.webp) | `7c0de405a0a665bcbeca0aa99ca8c02ea6cd09322f9bbbce756624495b916deb` |
| [src/assets/guides/en/library.webp](src/assets/guides/en/library.webp) | `ba56ff30a78f9ecfffffc1ee9c3d09892e121d6a0f44b9a5f1a7c3d413b8053c` |
| [src/assets/guides/en/reader-directory.webp](src/assets/guides/en/reader-directory.webp) | `ac2d0f2e0ea8e0e4ce4540829bce39684d4b680495eeebd66172d42cb54ae10d` |
| [src/assets/guides/en/reader-settings.webp](src/assets/guides/en/reader-settings.webp) | `ff0192f9424060585b7434cb6ac3cc8023de582e88a1181170561696d8ac11de` |
| [src/assets/guides/en/remote-library.webp](src/assets/guides/en/remote-library.webp) | `0fb2fb786e135a1cb6df939c0aeb809684af36e9e9fe4eae980a0f3d7ab482b6` |
| [src/assets/guides/en/search-results.webp](src/assets/guides/en/search-results.webp) | `dd6688acc2f55c23abe11af6036862e2449b51a6391705228f3afc5de8e7d001` |
| [src/assets/guides/en/search.webp](src/assets/guides/en/search.webp) | `4b6d3ec009a929b1f4179942283959e1cbdcb625f27fee891993f28ebfa064cd` |
| [src/assets/guides/en/translation-settings.webp](src/assets/guides/en/translation-settings.webp) | `098ae155d0bc05614b6ad51fe1b211a62c138a26e59f9613347e2f899901db4f` |
| [src/assets/guides/ja/channel-form.webp](src/assets/guides/ja/channel-form.webp) | `25d9426a184a3cb2ded669c4abf87a18124b6b60875659765dd9a9e7b2858e59` |
| [src/assets/guides/ja/library.webp](src/assets/guides/ja/library.webp) | `a917994bcc5520aa1fcb64feae5e169050f48214c737c060b693af4a0f6db917` |
| [src/assets/guides/ja/reader-directory.webp](src/assets/guides/ja/reader-directory.webp) | `1c5bad4d23bdfbcb8dd1bbe8608e1ebf21099438c726a72c2a3dfad91b370da5` |
| [src/assets/guides/ja/reader-settings.webp](src/assets/guides/ja/reader-settings.webp) | `28821fd39d676a6c8ebc6479ff07a868cb6183c8d425ffdca745b81f3d438474` |
| [src/assets/guides/ja/remote-library.webp](src/assets/guides/ja/remote-library.webp) | `c18ade76608028432312cd152469fcbef5b14e78c1088e76a2d71c2147f8d7f0` |
| [src/assets/guides/ja/search-results.webp](src/assets/guides/ja/search-results.webp) | `527adadcecc70cc8fade840d0dc98942a21d211fc4d26959ff5e6e772b490f11` |
| [src/assets/guides/ja/search.webp](src/assets/guides/ja/search.webp) | `249d87d9a88ffeca9993a30d6b32af82af4ef02f6417a9e8014ad0b4a07bbd4a` |
| [src/assets/guides/ja/translation-settings.webp](src/assets/guides/ja/translation-settings.webp) | `c7e59f72f55957f783ac49d494c6f0a48618a4de7829528a736bd6b922c19520` |
| [src/assets/guides/ko/channel-form.webp](src/assets/guides/ko/channel-form.webp) | `f3e4c05f8f616ad823cc852160e086d720e533ee40a91b349e1698923d8bebcc` |
| [src/assets/guides/ko/library.webp](src/assets/guides/ko/library.webp) | `96b8ff5e72b17a77259b304931cf95c4a6231fe5c6a1caa085cf14eb7c0399ab` |
| [src/assets/guides/ko/reader-directory.webp](src/assets/guides/ko/reader-directory.webp) | `18111504967aadffe691cd194c75467ace8c2c3db543e092653f9e5084514549` |
| [src/assets/guides/ko/reader-settings.webp](src/assets/guides/ko/reader-settings.webp) | `37f3f2bc8b8bc7377dc60968e5c3f486c3cc0e7b302af80069b11b91cf1606bc` |
| [src/assets/guides/ko/remote-library.webp](src/assets/guides/ko/remote-library.webp) | `4b0e6a76ba6f9cb374609fcf7d6e84105d6630d38150b423bf07e4b3f392618a` |
| [src/assets/guides/ko/search-results.webp](src/assets/guides/ko/search-results.webp) | `c600792ad5746d6292b50e7ea72894ef66e2f152747357079e6b6b206e781c71` |
| [src/assets/guides/ko/search.webp](src/assets/guides/ko/search.webp) | `2240bfeefbd5e99693e1196d49e036b12f95cfab8fa84a9963be7e693ad294ee` |
| [src/assets/guides/ko/translation-settings.webp](src/assets/guides/ko/translation-settings.webp) | `42192ddfe29b1acfc7a731845eb9bbe33f130a7a7ffdae3e4103395a78af0bc3` |
| [src/assets/guides/zh-CN/channel-form.webp](src/assets/guides/zh-CN/channel-form.webp) | `56f88077436b0db484046f70ae7a8c5ea08256db59aab08740d0448eb8f784c9` |
| [src/assets/guides/zh-CN/library.webp](src/assets/guides/zh-CN/library.webp) | `ab92b941754ac35e376be6bfdbb2fb789d6b655ce6de429bf94cb0307cc9cdfa` |
| [src/assets/guides/zh-CN/reader-directory.webp](src/assets/guides/zh-CN/reader-directory.webp) | `02e44682440eccb6af8c3c6f118b029d4091bd2b83ce2d71a6fc51dfb13153f0` |
| [src/assets/guides/zh-CN/reader-settings.webp](src/assets/guides/zh-CN/reader-settings.webp) | `ab1a9cba392ec3e95117173e78b2ab4d3dc6cdce88487c4e203c1e1b317a0184` |
| [src/assets/guides/zh-CN/remote-library.webp](src/assets/guides/zh-CN/remote-library.webp) | `131f42becec088f01425109f27906cc1d50406804c5bbf3d6da0a5f0c8acfba7` |
| [src/assets/guides/zh-CN/search-results.webp](src/assets/guides/zh-CN/search-results.webp) | `e21f9610c641c786adfd26bdb0a7f275230f088547783e6c9fbbd51d2f39cce4` |
| [src/assets/guides/zh-CN/search.webp](src/assets/guides/zh-CN/search.webp) | `490444776d6d9d80a87b4e07e28760b8fe8efe111ffde8a38fbea53e3389964e` |
| [src/assets/guides/zh-CN/translation-settings.webp](src/assets/guides/zh-CN/translation-settings.webp) | `30573e9c73edda9b7094f57c1bc03149df7a76c3d40721e80c12d29f4d04b51c` |

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
