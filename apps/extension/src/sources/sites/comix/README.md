# Comix

支持 `https://comix.to/title/<hid>-<slug>` 及其章节地址，提供网页上下文完整目录与章节清单、HTTP 图片读取、12 小时更新、封面、站内导入和原位翻译。

作品页可作为跨语言查找起点：`describeWork` 从 `initial-data` 核对当前 HID 与作品URL后取标题；章节名不代替作品名。

名称搜索由 `search.ts` 调用 `GET /api/v1/manga`，使用 `keyword`、相关性排序与每页 12 条的分页，复用本站 `api.ts` 的签名与响应解码。核对分页元数据、HID、作品 URL 和重复条目，仅返回轻量候选、封面及最新话说明；不读取候选目录。`originalLanguage` 是原作语言，不用作章节内容语言。请求只访问 `comix.to`，取消或协议异常时不发布结果。

## 实现约定

- `definition.ts` 定义 URL、HID 身份与权限；`network.ts` 显式选择 `pageTransport: ['catalog', 'pages']`，通过同一个 `context.request()` 在源站网页上下文请求 `/api/v1/manga/<hid>`、完整分页目录及 `/api/v1/chapters/<id>` 图片清单。不请求详情页 HTML，也不解析页面已有的作品数据。核对分页、总数、上传 ID 与归属；章节按话号去重，保留 0 和小数话，优先保留已有上传，首次选择官方上传后取最小 ID。
- 阅读追踪保留已核对作品与 URL 归属的原生 `number` 标签，字符串小数不取整；不从标题、列表顺序推断话号，不将空值、布尔值或指数形式强制转换成章节。本站尚未提供已核验的 tracker 外链提取，作品关联仍需确认。
- `protocol.ts` 独立实现请求签名和响应解码；`image.ts` 接入图片解码，`images.ts` 还原 `X-Scramble-Algo: 3` 网格，保留边缘像素。Hash `03632`、`02900` 分别修正种子 XOR 58414、117532；未知协议明确失败。
- `page.ts` 识别 `.rpage-main` 内 `data-page` 正文槽及已加载图片／画布；导入入口挂在 `.mpage__actions`、`.rpage-floatctl`。导航、重绘和容器替换清理旧引用。
- 封面读取 `poster.large` / `poster.medium`，由 `image.coverTransport: 'page'` 显式在该图片 URL 自身的网页上下文获取原始字节；书架与搜索封面共用此规则。复用同 URL 图片标签页，否则临时打开后台图片页，优先读取本次导航缓存，不加载作品或章节；完成后回收，成功封面沿用缩略图缓存。首次未缓存读取增加一次后台图片页生命周期。
- 导入后的正文取图仍使用 `no-referrer`，重定向时保持不发送 Referer。原位 HTTP 图片仍遵循元素／页面的引用策略，本站不强制覆盖。
- 目录与章节清单读取复用同作品已打开的详情／章节标签页；没有则由公共层临时打开后台详情页，避免为获取清单加载整章图片，完成、失败或取消后回收自建标签页。需要登录／验证时停止请求，用户打开来源处理后重试；不自动切回扩展 HTTP，不复制 Cookie，不以 DOM 窗口代替完整清单。正文图片字节仍由公共图片管线读取。

协议参考源站 `secure-tlrpwb-M_-Wx-pz.js`，SHA-256 `5d271fc9c344c4386cab17c1589964fa447f3384191ea7fde92648e8edbdfa24`；不分发或执行该脚本。公共边界见[适配规范](../../../../../../docs/SITE_ADAPTERS.md)。

搜索请求与字段依据[源站](https://comix.to/)的 `TopNav`、`env` 前端模块和公开 API 响应；只独立实现协议，不执行下载的脚本。

## 验证

先构建插件并配置[浏览器环境](../../../../../../scripts/README.md#来源与阅读验收)，从仓库根目录运行本站 `tests/verify-*.mjs`：

| 脚本 | 范围 |
| --- | --- |
| `verify-browser.mjs` / `verify-entry.mjs` | 隔离入口与导入；`RUN_LIVE_COMIX=1` 增加真实网页会话目录检查，遇到源站验证需人工处理 |
| `verify-boundaries.mjs` | 合成目录、错误恢复、请求头隔离与清理 |
| `verify-chapter.mjs` / `verify-reader.mjs` | 真实章节逐图还原、构建版物化、显示和位置恢复 |
| `verify-search-http.mjs` | 真实名称搜索、空结果和下一页；不涉及目录导入、浏览器权限或模型 |

原位翻译运行 `node scripts/verify_inline_translation.mjs`，可设 `INLINE_SITE_ONLY=comix`、`RUN_LIVE_COMIX=1`、`COMIX_INLINE_URL`。译图仍为模拟响应；浏览器安装权限、撤权恢复和真实模型单独验收。
