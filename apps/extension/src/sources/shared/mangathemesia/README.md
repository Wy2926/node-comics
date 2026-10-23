# MangaThemesia

供 [Lagoon Scans](../../sites/lagoonscans/README.md)、[UnderTranslations](../../sites/undertranslations/README.md)、[Arena Scans](../../sites/arenascans/README.md)、[Akaza Scans](../../sites/akazascans/README.md)、[Aster Scans](../../sites/asterscans/README.md) 和 [King of Shojo](../../sites/kingofshojo/README.md) 显式调用的共享协议引擎。站点拥有主机、URL 形态、身份、图片策略、语言与安装元数据；引擎不自动认领未知网站，不依赖浏览器全局，不直接请求网络或执行下载的脚本。HTTP 解析不依赖 DOM，网页作品元数据只读取调用方传入的文档。

## 支持范围

- 名称搜索使用真实网页 `?s=` 与 `/page/<n>/`，核对查询标题、候选归属、当前页和同源下一页；只返回当前候选页，不抓作品目录。空结果需站点声明的明确标记，验证页、截断响应和未知空结构不能视作搜索结束。
- 作品目录读取完整静态 `#chapterlist`，校验作品 canonical、专门封面、全部章节行及无远程分页。主题与 WordPress 重复输出相同 canonical 可接受，缺失、空值或不一致仍失败；HTTP 与当前网页作品名读取使用相同判定。顺序按源站从新到旧列表反转为原生连读顺序，不从章节名称或数字推断归属、类型或语言。重复章节、未识别分页、受保护条目和结构变化明确失败。
- 裸章节通过其 canonical 与唯一 `.allc` 作品链接确定身份；站点在目录输出的章节 URL 中加入自身作品绑定片段，读取正文时再次核对，不按章节 slug 猜作品。原始章节 URL 的身份与绑定后相同，片段不发送给源站。
- “寻找其他语言”通过轻量 `describeWork` 读取当前文档：作品页使用已核对 canonical 的 `.postbody h1.entry-title`；章节页使用 `.chapterbody .allc a` 的作品名及链接，核对当前章节 canonical 与可选作品绑定。缺失、重复或归属不符时留空手填，不使用章节标题、OpenGraph 标题或 `document.title`；不请求目录、正文或图片。
- 正文仅支持实站确认的 `ts_reader.run(JSON)`：默认要求完整模式、单一选定图片源、明确非小说、无保护及解锁令牌。只 `JSON.parse` 字面数据，不执行脚本，不从任意 `images` 文本猜清单。`#readerarea` 中的 `noscript` 镜像不重复计页；活跃 DOM 混合正文不作为回退通道。保留 JSON 页序和重复图片 URL 的独立页槽，不丢弃坏页后重编号。
- Akaza Scans／Aster Scans 显式声明 `reader: 'legacy-ready'`，只接受已核验的 `jQuery(document).ready(function ($) {...})` 内单个直接 JSON 调用。字符串、注释和模板中的示例不能提供清单；条件／嵌套／动态调用、重复调用及未知脚本变体失败。旧版必须没有新版访问字段，保持完整模式和单一图片源；默认源标签与唯一源名称可能不同，因此额外要求公开 `#readerarea img[src]` 与 JSON 的数量、顺序、全部 URL 一致。只计一次页，不以 HTML 替代无效 JSON，不执行 hooks、历史记录、`loadChList` 或浏览量 POST。新版站点不因这个显式变体放宽校验。
- King of Shojo 显式声明 `reader: 'minimal'`，沿用直接 JSON 调用与新版访问字段，但要求 `contentmode: 'minimal'`；同样复用 HTML／JSON 完全一致校验。源标签必须等于选定默认源，不接受旧版缺失访问字段。三种模式互不自动回退。
- 搜索、归属解析、目录、正文每次操作各一次只读 GET；通过调用方 `context.request` 保持权限、取消、30 秒／8 MiB 预算。目录最多 10000 章、正文最多 1500 页、搜索单页最多 100 项；无引擎常驻缓存、站点全集扫描、逐章预取或上游浏览量 POST。
- 图片／封面沿用公共权限、Referer、读取预算与缓存。网页导入、12 小时同步和 `inlineRecognition: 'generic'` 由具体站点声明；站点 `page.ts` 只导出作品元数据，原位图像识别仍使用通用会话，不新增图片解码层。

未支持 MangaThemesiaAlt 随机 URL 映射、付费解锁、小说、多服务器切换、单页模式、DOM-only、Base64 或混淆脚本等变体。源站需要验证或登录时由用户在源站处理，不自动切换通道或绕过限制。

## 上游参考

协议参考 [Keiyoushi extensions-source](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/lib-multisrc/mangathemesia)，固定提交、文件 SHA-256、用途和 Apache-2.0 许可见 [upstream.json](upstream.json)；许可随插件分发。这里是 Node Comics 契约下的 TypeScript 实现，不运行或打包 Android／Kotlin 扩展，也不代表支持上游全部站点。

## 验证入口

在插件目录执行：

```powershell
npm test -- src/sources/shared/mangathemesia src/sources/sites/lagoonscans src/sources/sites/undertranslations src/sources/sites/arenascans src/sources/sites/akazascans src/sources/sites/asterscans src/sources/sites/kingofshojo --maxWorkers=2
npm run check
npm run build
```

在仓库根目录执行：

```powershell
node apps/extension/src/sources/shared/mangathemesia/tests/verify-performance.mjs
node apps/extension/src/sources/shared/mangathemesia/tests/verify-http.mjs
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs lagoonscans return nodelanevalidationzzqv --html-search --page-size=10 --max-pages=3
```

站点单元测试只保留自身身份和协议接线；取消、失败保留和通用非法输入集中在共享测试，不在每站重复整套用例。测试使用自造 HTML／JSON，覆盖身份隔离、归属、页序、完整性、取消、未支持协议及请求数。性能入口测量 1000 章、普通／旧版／minimal 各 100 页与 20 搜索项的解析时间及单次请求数；不同正文结构分别记录，不宣称相对旧实现提速。HTTP 入口可按站点 ID 单独执行，或串行检查六个公开站点的名称搜索、分页、空结果、目录、裸章节归属、正文及有限图片响应；不下载整章、不保留源站 HTML／漫画图片。

真实 MV3 浏览器导入、图片解码、失败恢复与重开位置复用现有 [阅读验收入口](../madara/README.md#验证入口)的 `tests/verify-live-browser.mjs <siteId> <作品或章节URL> [第二章节URL]`，其站点参数由统一注册表解析。搜索界面使用同目录的 `verify-search-browser.mjs`。这些入口使用隔离 profile 和真实公开 HTTP，需先构建插件并配置现有 Playwright／Chromium 路径；不调用翻译模型。样本、统计及截图写入忽略的 `artifacts/`。普通 HTTP、自造夹具、真实浏览器与模型效果分别验收。
