# 官网首轮营销设计稿

日期：2026-09-24。设计对象：现有 Astro 官网，优先英文访问路径。新版首页已在现有工程中实现，保留五语路由并通过本地验收。部署流程见 [WEBSITE_DEPLOYMENT.md](WEBSITE_DEPLOYMENT.md)，线上状态以当次部署验收为准。下表保留最初设计依据，实际实现将截图画廊提前到翻译样例之前。

## 目标与视觉

让海外新用户在首屏看懂“浏览器里的漫画阅读器 + 可选翻译”，随后看真实操作，再决定安装。沿用现有蓝白主题、粗边框、少量硬阴影和漫画网点，不引入第二套品牌或模板。

新版首屏采用用户提供的真实 Popup，下方为三步说明、可切换和放大的截图画廊、原创日文与翻译结果对照、来源入口和翻译方式。装饰插画不承担产品界面或质量证据。

## 实现位置

- 首页布局：`backend/website/src/components/HomePage.astro`；入口：`LocalizedPage.astro`。
- 截图切换与原图弹窗：`ScreenshotGallery.tsx`；键盘 Escape 关闭并恢复按钮焦点。
- 翻译对照：`Compare.tsx`；保留加载、失败与重试状态，日文页面默认原图。
- 文案：`backend/website/src/i18n/home/` 下 `en.ts`、`zh-CN.ts`、`zh-TW.ts`、`ja.ts`、`ko.ts` 五个独立字典；`types.ts` 仅定义结构，`index.ts` 仅做语言映射。页面与组件不包含各语言文案或账户字典依赖。
- 样式：`backend/website/src/styles/home.css`，沿用共享设计令牌。
- 图片：`backend/website/src/assets/product/` 保留六张用户原截图，Astro 构建输出 WebP。营销海报未嵌套进网页。
- 本地预览：在 `backend/website` 执行 `npm run build`、`npm run preview`，访问 `http://127.0.0.1:4321/en/`。

## 页面顺序与具体文案

| 位置 | 英文文案与动作 | 视觉素材 |
| --- | --- | --- |
| 首屏左侧 | H1: **Read the story in your language.** 描述: **A comic reader with optional translation for supported websites and your own comic files.** 主 CTA: **Get the extension** → `/en/download/`；次 CTA: **See the reader** → 下方演示。 | 右侧使用完整 Popup 的干净裁切；不要把带宣传标题的整张海报再套入网页造成标题重复。 |
| 首屏下方信任说明 | **Local originals: no account needed. Translation: online, with plan allowances.** | 一行事实说明，不放虚构下载量、评分或媒体 Logo。 |
| 第一个演示 | **Start from your toolbar.** 三步：Choose a language → Translate the current tab → Open your comics。 | `06-browser-popup` 中真实弹窗裁切。 |
| 同图对照 | **Check the translation. Keep the original.** 保留可操作的日文/英文切换，说明这是一个原创样本的已记录结果，效果因图片而异。 | 既有 `journey-original.webp` / `journey-en.webp`；不能将新海报上的韩文原图标成英文翻译效果。 |
| 阅读器展示 | **Read your way.** 连续/单页、方向、背景；点击可放大截图，保留键盘操作和关闭入口。 | `02-reading-controls`；不要轮播自动切换。 |
| 来源入口 | **Bring a comic you can access.** Local files / Supported websites 两个平行入口，格式边界和站点边界就近说明。 | 书架与网站两张图；不把全部第三方站点 Logo 作为合作背书。 |
| 翻译方式 | Classic / AI redraw 两段简短说明；说明 redraw 可能改变画面，用户可以查看原图。 | 展示实际功能，未取得 redraw 实测对应页时不制作伪造的结果对比。 |
| 计划与隐私 | 链接现有 Pricing 与 Privacy；说清在线处理、额度、默认保留，不藏在安装后。 | 不复制可能过期的价格数字到图片。 |
| 收尾 | **Ready for your next page?** 主 CTA 保持 **Get the extension**，指向同一个可靠安装入口。 | 不增加弹窗留邮箱、倒计时或强制订阅。 |

## 图像使用

- 网页优先使用 `web-1600x1000/` 中的 WebP；海报适合媒体图库和分享，首页正文优先使用素材中已有的纯 UI 裁切，避免一图内多层宣传标题。
- 声明图片宽高并预留比例，首屏图优先加载，其他图延迟加载；放大保持原始比例。
- 截图替代文本描述展示的功能，例如 “NodeLane Comics toolbar popup with target language and Translate current tab action”。
- 只验收桌面浏览器范围；本任务不扩大为窄屏适配项目。
- 当前用户截图包含第三方漫画内容；作为真实界面素材与原创质量对照分别标注来源，不把第三方图记为项目原创。

## 本次已修正文案

五语首页与入门指南中的“当前图片与后两张”已按当前实现调整为：用户选择翻译后处理当前图片与后三张。历史更新日志保留当时的表述。商店介绍删除散图导入和章节资料管理等旧功能描述。

## 实施前仍需解决

初次素材检查时公开安装包为 0.1.1。2026-09-24 部署前重新核对，生产已发布 0.2.0，公开 ZIP 下载、大小、SHA-256 和 manifest 版本均与生产目录一致；本地版本目录已同步，防止官网部署退回旧包。商店入口仍以此前不可安装的观察为准，未将主按钮改成商店安装承诺。主 CTA 继续落到说明实际安装方式的下载页；未将截图作为所有站点均实测通过的证据。
