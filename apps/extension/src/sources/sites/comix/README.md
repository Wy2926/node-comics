# Comix

支持 `https://comix.to/title/<hid>-<slug>` 及其章节地址，提供网页上下文完整目录与章节清单、HTTP 图片读取、封面、站内导入和原位翻译。保留手动导入、再次导入补充目录和整本离线缓存；不做定时目录同步。

作品页可作为跨语言查找起点：`describeWork` 从 `initial-data` 核对当前 HID 与作品URL后取标题；章节名不代替作品名。

名称搜索由 `search.ts` 调用 `GET /api/v1/manga`，使用 `keyword`、相关性排序与每页 12 条的分页，复用本站 `api.ts` 的签名与响应解码。核对分页元数据、HID、作品 URL 和重复条目，仅返回轻量候选、封面及最新话说明；不读取候选目录。`originalLanguage` 是原作语言，不用作章节内容语言。请求只访问 `comix.to`，取消或协议异常时不发布结果。

## 实现约定

- `definition.ts` 定义 URL、HID 身份与权限；`network.ts` 显式选择 `pageTransport: ['catalog', 'pages']`，通过同一个 `context.request()` 在源站网页上下文请求 `/api/v1/manga/<hid>`、完整分页目录及 `/api/v1/chapters/<id>` 图片清单。HTML 只用于定位公开协议资源，不从页面当前加载的图片或目录窗口推断完整清单。核对分页、总数、上传 ID 与归属；章节按话号去重，保留 0 和小数话，优先保留已有上传，首次选择官方上传后取最小 ID。
- `protocol.ts` 独立实现请求签名和响应解码：按排序后的原始查询值执行两次带预计算前缀状态的 SHA-256，返回版本号与截短的 Base64URL 摘要；响应使用前两字节定位公开 XOR 表，再解析 UTF-8 JSON。请求签名与响应编码不是互逆算法。
- `protocol-loader.ts` 首次按需读取来源 HTML（搜索使用 `/browse`），定位同源 `main` / `apicore` 资源；只允许已知静态资源路径，HTML 上限 512 KiB、单个脚本上限 1 MiB。`protocol-source.ts` 将脚本当作文本，按已核验布局解析版本、字符串表和三种公开常量分片；核对完整且不重叠的 1088 字节材料，不执行远程程序。版本号和材料允许轮换，算式和解析布局仍由随包代码实现；不自动兼容未知算法或混淆布局。
- 每个运行上下文只缓存一份解析材料并合并并发加载，不保存源站脚本。冷启动通常增加 HTML、主模块、协议模块共 3 个请求；后续目录分页、章节和缓存任务复用材料，不逐章重新读取脚本。只有接口明确返回 `key_retired` 才作废材料并刷新重试一次；未知结构、解码失败、二次退役均明确提示协议变化并暂停同来源缓存任务，保留已有缓存。`captcha_required` 单独提示来源验证，不刷新签名或自动解题；Cloudflare、权限和限流仍由公共传输层处理。
- `image.ts` 接入图片解码，`images.ts` 还原 `X-Scramble-Algo: 3` 网格，保留边缘像素。Hash `03632`、`02900` 分别修正种子 XOR 58414、117532；未知协议明确失败。
- `page.ts` 识别 `.rpage-main` 内 `data-page` 正文槽及已加载图片／画布；导入入口挂在 `.mpage__actions`、`.rpage-floatctl`。导航、重绘和容器替换清理旧引用。
- 封面读取 `poster.large` / `poster.medium`，由 `image.coverTransport: 'page'` 显式在该图片 URL 自身的网页上下文获取原始字节；书架与搜索封面共用此规则。复用同 URL 图片标签页，否则临时打开后台图片页，优先读取本次导航缓存，不加载作品或章节；完成后回收，成功封面沿用缩略图缓存。首次未缓存读取增加一次后台图片页生命周期。
- 导入后的正文取图仍使用 `no-referrer`，重定向时保持不发送 Referer。原位 HTTP 图片仍遵循元素／页面的引用策略，本站不强制覆盖。
- 目录与章节清单读取复用同作品已打开的详情／章节标签页；没有则由公共层临时打开后台详情页，避免为获取清单加载整章图片，完成、失败或取消后回收自建标签页。需要登录／验证时停止请求，用户打开来源处理后重试；不自动切回扩展 HTTP，不复制 Cookie，不以 DOM 窗口代替完整清单。正文图片字节仍由公共图片管线读取。
- 离线缓存复用公共整本队列：完整目录确认后逐章取清单、逐页补缺；暂停后可恢复，不重复读取已保留原图，不改变阅读位置。协议材料缓存与原图持久缓存互相独立；已缓存页面离线阅读不依赖新的源站签名。

接口解析布局参考源站 [apicore-tnli0z-MbTyRM7l.js](https://comix.to/assets/build/35595e3de3c99889c1aa70/dist/apicore-tnli0z-MbTyRM7l.js)，版本 `91r`，SHA-256 `6d205fb6953ea3a629ab87bc36dd238a78b8f180d613c9b7325c91d02ce031e1`。仅用于固定测试向量的旧版 `qo4` 材料来自 `apicore-tnjnd0-DKF2GJzr.js`，SHA-256 `e6baa686c07629c4ad8660d64552ff549eb7e85b972564d8bc31267c65cc6588`，不作为运行时回退。图片协议参考 `secure-tlrpwb-M_-Wx-pz.js`，SHA-256 `5d271fc9c344c4386cab17c1589964fa447f3384191ea7fde92648e8edbdfa24`。源站未声明这些脚本的开源许可；仅作为协议参考，保留必要公开常量并独立实现，不分发或执行下载的脚本。公共边界见[适配规范](../../../../../../docs/SITE_ADAPTERS.md)。

搜索请求与字段依据[源站](https://comix.to/)的 `TopNav`、`env` 前端模块和公开 API 响应；只独立实现协议，不执行下载的脚本。

## 验证

在插件目录运行 `npm test -- src/sources/sites/comix/tests tests/source-page-network.test.ts tests/book-downloads.test.ts`，覆盖固定签名向量、SHA-256 分块边界、Unicode／长响应解码、协议轮换与限次重试、取消／并发加载、完整目录与搜索解析，以及缓存暂停、恢复和保留原图。固定响应与脚本布局夹具使用合成数据，不包含源站签名地址或用户内容。

先构建插件并配置[浏览器环境](../../../../../../scripts/README.md#来源与阅读验收)，从仓库根目录运行本站 `tests/verify-*.mjs`：

| 脚本 | 范围 |
| --- | --- |
| `verify-browser.mjs` / `verify-entry.mjs` | 隔离入口与导入、失败重试和位置恢复；`RUN_LIVE_COMIX=1` 增加真实网页会话目录检查，真实图片按接口标记选择直接读取或还原，遇到源站验证需人工处理 |
| `verify-boundaries.mjs` | 合成目录、错误恢复、请求头隔离与清理 |
| `verify-chapter.mjs` / `verify-reader.mjs` | 真实章节逐图还原、构建版物化、显示和位置恢复 |
| `verify-search-http.mjs` | 真实名称搜索、空结果和下一页；不涉及目录导入、浏览器权限或模型 |

原位翻译运行 `node scripts/verify_inline_translation.mjs`，可设 `INLINE_SITE_ONLY=comix`、`RUN_LIVE_COMIX=1`、`COMIX_INLINE_URL`。译图仍为模拟响应；浏览器安装权限、撤权恢复和真实模型单独验收。
