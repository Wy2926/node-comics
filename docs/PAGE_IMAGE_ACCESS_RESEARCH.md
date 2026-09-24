# 通用跨域取图与已加载图片读取调研

2026-09-24。目标：用公共取图能力解决不同网站的图片跨域失败。直接复用页面图片是候选方式，用户不要求零网络请求。用户确认后已实施公共取图方案；下方直接读页面、缓存、debugger 与 pageCapture 实验保留为方案比较记录。

## 实施与验收

原位翻译和阅读器已共用 `runtime/image-fetch.ts`，新增通用页面 Referer、图片域名检查、最多 5 次手动重定向和逐跳权限检查。站点特殊请求头在同来源范围内覆盖默认值，跨来源重定向重新生成通用头。有效 Blob／Data／Canvas 仍走既有页面读取；保留原始 HTTP 字节与已有图片校验、内容去重和失败缓存重试策略。

原位翻译从图片属性／meta 读取显式引用策略，缺省按 `strict-origin-when-cross-origin` 处理；仅 HTTP 响应头设置的页面策略没有回溯获取。缺少图片权限时页面显示“等待图片授权”，详细提示重新右键翻译完成授权；阅读器的授权按钮使用实际缺少的目标域名，包含重定向目标。

为读取 `fetch` 手动重定向隐藏的 Location，增加普通 `webRequest` API 权限，只在取图期间观察自身精确请求的响应头；沿用已有 DNR 会话规则设置 Referer，没有采用 debugger 或 pageCapture。浏览器原生权限弹窗与 Firefox 运行行为未在本轮验收。

已完成类型／模块检查、构建和 765 项测试（另 1 项按既有配置跳过）。Edge 153 隔离浏览器验证覆盖无 CORS 的通用站点、Referer 403、跨来源重定向、未授权目标零请求、循环跳转、Cookie 本地使用、同 URL 并发、取消清理及阅读器失败重试／缓存恢复。真实 Comix 指定第 60 章的 HTTP 图片和还原 Canvas 取图、模拟译图显示与原图恢复通过；没有调用实际翻译供应商。

当次本地证据：`artifacts/inline-validation/e4d236d2-a05b-4270-b3fa-ba892a15f463/`、`artifacts/image-transport/08785ae3-ada7-421f-af71-2d56d6f35d63/`、`artifacts/source-image-cache/run-EoBppK/`、`artifacts/inline-validation/7eb8b9d9-25a0-4c15-8898-a2691f12587a/`。公共浏览器回归入口见[脚本说明](../scripts/README.md)。

## 推荐主线：公共图片获取层

采用“通用／站点识别 → 统一资源引用 → 公共获取 → 校验与翻译”。普通 HTTP(S) 图片主要由获得图片域名权限的扩展后台读取；页面独有的 Blob / Data / Canvas 由页面读取。普通图片不需要为了 CORS 新增 debugger 或 pageCapture 权限，额外接口仅作为特殊场景候选。

调研时的代码已有后台取图与精确 URL 请求头规则，但原位 HTTP 入口仅采用适配器声明的请求头，缺少基于当前页面的通用来源策略，也没有显式检查图片域名权限。此次公共层改造补齐了这两项。

| 失败类型 | 公共层处理 | 不能混淆的情况 |
| --- | --- | --- |
| 网页请求被 CORS 拦截 | HTTP(S) 请求统一在授权的扩展后台执行 | MAIN 世界注入、`no-cors` 和 Canvas 不会自动解决 |
| 图片 CDN 未授权 | 检查实际图片域名，缺失时保留引用并提供用户点击授权入口 | `activeTab` 只给主框架来源的临时权限，不能当作所有 CDN 授权 |
| 来源校验返回 403 | 从已校验的当前页面和引用策略构造 Referer；通过公共精确规则设置 | HTTP 403 是源站拒绝，网站权限本身不会解除它 |
| 页面生成 Blob / Canvas | 按文档与元素版本读取页面资源 | 不能在后台直接取其他上下文的 Blob，也不能导出受污染 Canvas |
| 登录、签名过期、验证码、特殊解码 | 明确报告对应原因，保留站点扩展点与页面处理路径 | 不能承诺一套请求头覆盖所有源站规则 |

后台授权与网页 CORS 的区别见[Chrome 跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)；临时主站权限边界见[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)。本机无 CORS 样本已经证明后台可读原字节。另一组来源校验样本中，页面正常加载、后台裸请求 403、公共 Referer 会话规则下 200，移除规则后回到 403；无需站点名称或专用适配代码。请求头修改使用产品已有的 [declarativeNetRequestWithHostAccess](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) 能力。

公共层职责：

1. 接收经过页面／文档身份检查的图片引用，而非网页提供的任意 URL 和任意请求头。
2. 在用户操作入口取得必要权限，下载前显式检查图片地址授权；重定向继续校验新目标，不把原请求的敏感头无条件传给新域名。
3. 根据已校验的来源页、图片元素／文档引用策略生成通用 Referer；保留确有不同要求的站点覆盖。不要普遍伪造 Origin 或把 Cookie 转交远程代理。
4. 请求头规则只匹配扩展发起的当前精确图片 URL，同 URL 并发串行，完成／取消／服务恢复时清理；沿用现有有界读取、超时和失败重试能力。
5. 返回可操作的权限缺失、HTTP 拒绝、页面资源过期、画布不可读和网络失败等原因；图片可解码且大小合规后才上传。

Comix 已有真实 HTTP 对照为缺少 Referer 时 403、本站 Referer 时 200，见[站点验证记录](../apps/extension/src/sources/sites/comix/README.md)。来源 Referer 已纳入通用请求能力，站点专用代码继续处理选图、排序、还原等差异。合成 Cookie、跨来源重定向和显式 Referrer-Policy 已验证；未覆盖真实网站账户会话、分区 Cookie 与 Firefox 的运行行为。

## 结论

可以，但需要区分授权种类和要读取的数据。普通网站授权下，部分图片可直接读像素或本地字节；跨域且未经 CORS 加载的 `img` 仍无法导出像素。增加专门的 `debugger` 或 `pageCapture` 权限后，Chromium 系浏览器还提供读取已加载资源原始文件的路径，隔离实测成功，不能笼统说“插件一定要重新下载”。

| 方式 | 能得到什么 | 是否再次访问图片服务器 | 主要条件 |
| --- | --- | --- | --- |
| 读取页面同源 `img`、以 CORS 加载的 `img` 或干净的 Canvas | 当前解码像素，再编码为 PNG 等 | 不需要 | 元素已加载且画布允许导出 |
| 页面上下文读取有效 `blob:` / `data:` | 对应原始字节 | 不需要 | Blob 仍有效且当前上下文可访问 |
| 页面上下文读取 HTTP 缓存 | 缓存中的原始响应 | 命中时不需要 | 同源或 CORS 允许，缓存条目可用 |
| 有网站权限的扩展后台 `fetch` | 原始响应字节 | 可能需要 | 权限覆盖图片地址；不能假定命中网页缓存 |
| `debugger` + `Page.getResourceContent` | 指定已加载资源的原始内容 | 本次样本无新请求 | 新增调试权限；资源仍可由浏览器取出 |
| `pageCapture.saveAsMHTML` 后解析图片部分 | 页面归档包含的原始图片 | 本次样本无新请求 | 新增页面捕获权限；先打包整页，再按资源地址提取 |

本次可行不代表保证取到所有网站、所有历史加载资源。已卸载资源、跨站 iframe、大图内存回收、特殊图片格式及长时间运行尚未覆盖。

## 普通网站授权的实际边界

Chrome 的网站权限允许扩展后台或扩展页面发起授权范围内的跨域请求。注入网页的 content script 仍以网页来源发起请求，不因此获得读取任意跨域响应的权限。Firefox MV3 文档也明确排除 content script 请求。[Chrome 跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[Firefox host_permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions)。

对页面 `img` 调用 `drawImage` 之后能否导出，取决于图片加载时是否满足画布的来源规则。跨域图片仅有服务器 `Access-Control-Allow-Origin` 响应头，而元素加载时没有启用 `crossorigin`，仍可能污染画布。切换 MAIN / ISOLATED 执行世界，或使用 ImageBitmap / OffscreenCanvas，均不改变这条限制；本次实验全部得到 `SecurityError`。[Canvas 跨域规则](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image)。

Canvas 导出是对像素重新编码，不是读取原 JPEG / WebP / PNG 文件。本次自制 PNG 为 1,528 字节，导出 PNG 为 186 字节，SHA-256 不同。它适合取得漫画当前画面，但不能保留原文件元数据、编码和动画，不能假定与重新下载的原文件共享内容哈希。按图片自然尺寸读取可避免受网页 CSS 缩放影响，仍需考虑大图内存和字节上限。

## 浏览器缓存不能直接等同于页面已有图片

`force-cache` 先查缓存，未命中仍访问网络；`only-if-cached` 不访问网络，但要求 `mode: same-origin`，没有条目就失败。`no-store` 不复用 HTTP 缓存。[Request.cache](https://developer.mozilla.org/en-US/docs/Web/API/Request/cache)。

Chrome 对 HTTP 缓存做分区。[官方缓存分区说明](https://developer.chrome.com/blog/http-cache-partitioning)解释了网络隔离键，但该文不能单独证明所有版本的扩展缓存行为。以下是本次两个浏览器的实际结果：

| 操作 | 结果 | 新增图片 GET |
| --- | --- | ---: |
| content script 对已加载同源 / CORS 图片 `force-cache` | 原字节成功 | 0 |
| content script 对无 CORS 图片 `force-cache` | CORS 失败 | 0 |
| content script 对无 CORS 图片 `no-cors` | opaque 响应，读到 0 字节 | 0 |
| content script 对同源图片 `only-if-cached` | 原字节成功 | 0 |
| 后台对网页已加载图片首次 `force-cache` | 原字节成功；同源、CORS、无 CORS 三类均重新请求 | 每张 1 |
| 后台重复上述 `force-cache` | 原字节成功 | 0 |
| 后台对自身已有缓存图片 `no-store` | 原字节成功 | 1 |
| content script 对 `Cache-Control: no-store` 图片 `force-cache` | 原字节成功 | 1 |

另外在 Edge 153 中，后台对仅在网页中加载过的图片执行 `only-if-cached`：失败、0 请求；后台自身获取并缓存之后，再执行相同模式：成功、0 请求。因此不能直接把产品后台的 `no-store` 改成 `force-cache`，就声称已经复用了页面图片；也不能把网页上下文的同源限制直接套到具有 host 权限的扩展后台。

## 更高权限下读取原始文件

### 单个资源：debugger

`chrome.debugger` 可附加到目标标签页，调用 CDP 的 Page 域。本次在图片加载完成之后才附加，再调用 `Page.getResourceTree` 和 `Page.getResourceContent`。跨域、没有 CORS 的普通图片及 `no-store` 图片都返回原 PNG 字节，哈希相同，图片服务器没有新 GET。[debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)、[CDP Page 协议](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getResourceContent)、[协议原始定义](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json)。

这是读取浏览器保留的资源，不是通过 Canvas 绕过来源限制。Page 的上述资源方法在当前协议定义中标为 experimental；资源仍需存在，并需处理附加失败、用户取消和导航。安装授权包含调试后端及读取、修改网站数据的权限提示。[Chrome 权限说明](https://developer.chrome.com/docs/extensions/reference/permissions-list)。本次 headless 实验没有验收用户可见的调试提示或与 DevTools 同时使用的交互。

### 整页资源：pageCapture

`chrome.pageCapture.saveAsMHTML({tabId})` 返回包含页面及资源的 MHTML Blob。可本地解析 MIME 部分，按图片 `Content-Location` 取得文件。本次在没有 debugger 权限的临时 MV3 扩展后台直接调用成功；跨域无 CORS 图片及 `no-store` 图片均原字节一致、0 新 GET。[pageCapture API](https://developer.chrome.com/docs/extensions/reference/api/pageCapture)。

这是一条不用调试会话的可行路径，但产品需要新增 `pageCapture` 权限，并承担整页序列化、MIME 解析与内存开销。它不提供按一张图片读取的参数，不能替代站点 Canvas 解码；未加载的懒加载图片也不应视为已经取得。若后续采用，只应在本机从归档中提取已识别图片，不能把整页 HTML 与其他资源上传给翻译后端。当前仅证明小型合成页面可行，尚未验证 Comix 整章的耗时、峰值内存和资源覆盖率。

### 其他接口

- Chrome `webRequest` 提供请求及响应元信息，普通监听器没有通用的响应体读取接口，不能凭借 host 权限从已完成请求拿出文件。[webRequest API](https://developer.chrome.com/docs/extensions/reference/api/webRequest)。
- DevTools 扩展可用 `devtools.inspectedWindow` 的资源 `getContent`，但需要 DevTools 页面上下文，不适合作为普通右键翻译的默认入口。[DevTools 资源接口](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)。
- Firefox 的 `webRequest.filterResponseData` 可在请求期间复制响应流；MV3 还需 `webRequestFilterResponse` 等权限。这不是任意读取此前已完成图片的方法，本次未安装 Firefox，未做运行验证。[Firefox 响应流接口](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData)。
- 标签页截图能取得当前可视画面，但不能当作完整原尺寸图片文件。[captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)。

## 已采用方案与保留候选

当前[权限配置](../apps/extension/wxt.config.ts)包含网站授权、脚本注入、DNR 和用于逐跳验证的 `webRequest`，没有 `debugger` / `pageCapture`。[普通图片下载](../apps/extension/src/sources/runtime/image-fetch.ts)保留 `no-store`，用于防止失败 HTTP 响应留在缓存影响重试；[Comix 页面适配](../apps/extension/src/sources/sites/comix/page.ts)中的 Canvas 从页面直接导出，普通 HTTP `img` 走公共后台取图。

当前目标优先采用前述公共后台取图方案；有效 Blob / Data 原字节和已解码 Canvas 仍由页面提供。允许读取的已加载 `img` 可以作为复用优化，不应成为普通 HTTP 图片成功与否的前置条件。通用识别和适配站识别均使用这一公共获取能力，不应将发现图片与拿到字节合并为一个判断。

需要广泛覆盖无 CORS 的普通 `img` 且避免二次下载时，可进一步评估 `pageCapture` 按页面批次提取与 `debugger` 按资源读取。前者的主要代价是整页开销，后者是调试权限和会话管理。先验证 Comix 长章节、动态切页及大图，再决定是否增加权限，当前不把任何一种作为已确认方案。

页面像素输入与原始文件输入必须有清晰身份：同一画面重新编码后哈希可能不同，会影响原图去重与译图复用。沿用图片源地址、元素版本和导航校验，避免识别之后页面换图却上传旧内容。

## 可重复的实验证据

脚本：[probe_page_image_access.mjs](../scripts/probe_page_image_access.mjs)。Node.js 24、Playwright、Windows 下隔离 headless profile；两个本机 HTTP 来源、自制 PNG、真实 MV3 扩展。没有使用会禁用 HTTP 缓存的 Playwright route 拦截；以服务器收到的 GET 和 SHA-256 判断是否重新下载及是否原始文件。授权由 `permissions.contains` 核实，并由真实 `chrome.scripting.executeScript` 分别在 MAIN / ISOLATED 世界执行。

| 环境 / 范围 | 本地结果目录 |
| --- | --- |
| Chromium 141.0.7390.37，普通权限与缓存 | `artifacts/page-image-access/7611ed30-deed-4b1c-8bad-bcf206d30920/` |
| Edge 153.0.4234.48，普通权限与缓存，含后台缓存未命中 | `artifacts/page-image-access/6fc598ea-be50-45da-a02c-8321b412e501/` |
| Edge 153，额外 debugger 权限 | `artifacts/page-image-access/6dc829ef-9a8e-42b3-8ae6-8640fbcd7b58/` |
| Edge 153，额外 pageCapture 权限，无 debugger | `artifacts/page-image-access/7d2dea1b-f775-4365-aa03-c6de5c5894df/` |
| Edge 153，通用来源 Referer 规则：403 → 200 → 清理后 403 | `artifacts/page-image-access/7ec822e5-b8fe-471f-a5af-4919e438c38d/` |

各目录保留 `results.json` 与 `fixture.png`，页面捕获实验另有仅含合成内容的 MHTML。这些本地运行产物不进入仓库。脚本入口与环境变量见[脚本说明](../scripts/README.md#页面图片读取研究)。本次研究没有访问真实漫画或翻译服务；Comix 的既有页面交互验证不能替代这里尚未做的整页资源捕获验证。
