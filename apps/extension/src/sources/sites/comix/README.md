# Comix

专门封面读取 `poster.large`，缺失时使用 `poster.medium`；`static.comix.to` 按操作申请可选权限，封面无需章节切片还原。

仅认领 HTTPS `comix.to/title/<hid>-<slug>` 详情页与 `/<upload-id>-chapter-<number>` 阅读页。作品身份为 HID；章节身份为话号，保留 0 和小数话。xkcd 专属适配已删除，不提供旧来源迁移。

## 边界与实现

- `definition.ts`：域名、路径、稳定身份、12 小时更新策略和可选授权来源。
- `network.ts`：详情页 `initial-data`、签名 API、完整分页、章节归属校验及每话一条的选择规则。
- `protocol.ts`：内置的请求签名／响应解码。协议依据 2026-09-23 的源站公开响应独立实现，不引入源站混淆代码、第三方解密包或远程执行。
- `images.ts`：内置 `X-Scramble-Algo: 3` 的网格还原（xorshift32 洗牌），保留网格外边缘像素。按 `X-Scramble-Hash` 修正种子（`03632` XOR 58414、`02900` XOR 117532，其他值不修正）。未知算法或缺失必要响应头明确失败，不能返回乱图。
- `image.ts`：独立声明图片请求头和解码函数；不与目录／页面发现绑定。HTTP 原图的原位翻译同样通过公共取图层使用本站 Referer，避免直接请求 CDN 时返回 403；已还原画布读取页面像素。
- `page.ts`：提供网页原位翻译与站内导入／管理入口。原位翻译只认领 `.rpage-main` 内带 `data-page` 的正文槽，覆盖纵向长条和横向分页，按来源页号识别已加载的 `img.rpage-page__img` 与已还原的 `canvas.rpage-page__img`；等待加载完成，排除失败槽、广告和推荐图。画布通过页面像素读取，加载／重绘、元素替换、尺寸或页号变化及导航会使旧读取失效。已适配正文不再套用未知网站的大图尺寸启发式，因此较短切片也可翻译；通用层仍检查加载、可见性与服务端图片限制。
- 导入入口在详情页挂载于 `.mpage__actions`，章节页挂载于 `.rpage-floatctl` 悬浮工具栏，观察异步挂载和容器替换，导航后清理。目录和完整图片清单仍使用 HTTP，DOM 已加载窗口不作为整章完整性证据。
- `installation.json`、`icon.svg` 和 `tests/verify-browser.mjs` 均留在本站目录；公共注册表通过统一通配约定收集模块，其他目录禁止直接引用本站实现。
- 公共层只有能力接口、自动装配、HTTP／权限／清单登记和图片处理调用。站点不直接调用 `chrome.*`，不依赖 UI、书库、存储或翻译模块；公共模块没有 Comix 分支。

目录全量读完并核对总数、页码、重复上传 ID、归属后才发布。首次选择官方上传优先，同级取最小上传 ID；后续优先保留仍在完整目录中的已选上传。上传消失时重新选择同话，不把另一上传当作新增一话；已物化图片仍受现有内容身份检查约束，来源替换时须明确重新载入，不能静默混图。当前接入英文目录，非英文记录或不支持的章节地址会使读取明确失败。

扩展“漫画网站”提供链接导入入口。首次操作按定义申请主站与 `*.wowpic1.store` 可选权限；主站授权后，公共运行时按 `optionalContentMatches` 注册内容脚本，在详情页和章节页显示“NodeLane Comics · 导入/管理漫画”，撤销授权后取消注册，不增加安装必需权限。不同图片域名仍需已有授权流程。目录、首次读章、重试和自动同步不创建来源采集标签页，失败不回退到开页。CDN Referer 由通用会话规则设置，只在读取期间匹配扩展自身发起到已登记精确图片 URL 的请求；共享 URL 的请求串行隔离，完成或取消后清理。Cookie 和用户令牌不上传；目录／章节元数据请求省略凭据，公共取图可使用浏览器已授权的源站会话。

## 网页原位翻译回归

构建插件后，在仓库根目录运行 `node scripts/verify_inline_translation.mjs`；设置 `PLAYWRIGHT_MODULE` 指向已安装 Playwright，`CHROMIUM_PATH` 指向支持解压扩展的 Chromium。脚本自动发现本站的 `tests/verify-inline.mjs`，覆盖关闭标签页自动翻译后的手动菜单启动、普通图片与短切片、还原画布、加载／失败槽过滤、懒加载、同元素画布重绘、页号短暂重绑后恢复、恢复原图和切章清理。菜单权限接口模拟同步用户手势，原生权限弹窗需单独验收。

`RUN_LIVE_COMIX=1` 额外在真实章节检查普通图片及第 10 页还原画布；`COMIX_INLINE_URL` 可指定章节，`INLINE_SITE_ONLY=comix` 只运行本站回归。翻译响应仍来自本机隔离 API，不调用实际翻译供应商。截图与脱敏结果输出到 `artifacts/inline-validation/<run>/`。

2026-09-24：真实 `nr83-the-sword-bearing-flower/11372843-chapter-60` 验证通过，公共跨域取图改造后在 Edge 153 复验通过，覆盖默认纵向阅读布局、HTTP 原图获取、滚动至第 10 页读取还原画布、显示模拟译图与恢复原图。源站 HTTP 对照确认无 Referer 返回 403、本站 Referer 返回 200。分页／长条切换、短切片、加载与失败过滤、同元素重绘及章节导航在隔离夹具验证；未验证真实供应商翻译效果和原生权限弹窗。

## 站内导入入口验收

构建插件后，在仓库根目录运行 `node apps/extension/src/sources/sites/comix/tests/verify-entry.mjs`（浏览器环境变量同下文）。隔离样本覆盖授权后自动登记、SPA 首次导入、容器替换不重复挂载、离开漫画清理、当前章节导入、失败提示与恢复、重开阅读位置；截图和结果在忽略目录 `artifacts/comix-entry/`。设置 `RUN_LIVE_COMIX=1` 额外检查真实详情页与章节页的入口布局，不执行真实导入或模型请求；原生授权弹窗仍需单独验收。

2026-09-24：上述隔离导入流程与真实页面入口布局已验证。真实章节页出现覆盖整个视口的源站链接层，阻挡点击；报告单独记录此限制，不修改或移除源站遮罩，也不将布局可见当作真实点击导入通过。

## 图片响应变体回归

`nr83-the-sword-bearing-flower/6887743-chapter-2` 的 117 张图片包含 11 张切片图：第 10、30、40、60、70、80、100 张为 `02900`；第 20、50、90 张为 `03632`；第 110 张为 `72103`。前两类只需在洗牌前修正种子，不改变图片字节或切片算法。此前的拒绝分支导致 10 张图片报“还原协议已变化”。修复后的三类绘制顺序与源站解码器观测一致。

真实 Chromium 扩展逐张获取并解码 117/117 张图片通过；第 10、20、110 张与源站绘制顺序生成的参考图逐像素一致。测试预授予此章节实际使用的 `*.wowpic2.store`，未测试原生授权弹窗。运行仓库根目录下的 `node apps/extension/src/sources/sites/comix/tests/verify-chapter.mjs` 可重做真实网络回归，浏览器路径设置同下文；产物在忽略目录 `artifacts/comix-chapter-6887743/`。

## 完整阅读器回归

仅检查来源图片解码不足以覆盖阅读流程。构建版的通用页面摘要此前保留了不存在的 `hash.worker.ts` 地址，解码后超过 1 MiB 的图片才触发该分支。改为打包器的 `?worker` 入口后，摘要 Worker 作为扩展本地资源发布；该修复属于通用页面标准化模块，没有站点分支。

`node apps/extension/src/sources/sites/comix/tests/verify-reader.mjs` 使用隔离 Chromium 和真实来源，在构建产物的阅读器界面逐页跳转，覆盖获取、还原、MIME／尺寸检查、摘要、落库和显示，并重新打开第 10 页检查持久缓存读取。117/117 页显示通过，117 条物化记录完整保存，大图实际使用打包后的 Worker；另用 2 MiB 确定字节与 Node SHA-256 比对 Worker 摘要。产物在忽略目录 `artifacts/comix-reader-6887743/`。

## 协议来源

公开入口：[样例作品](https://comix.to/title/rrzm-the-regressed-genius-players-mythical-rank-weapon-creation)。调研版本：`/assets/build/35595e3de3c99889c1aa70/dist/secure-tlrpwb-M_-Wx-pz.js`，SHA-256 `5d271fc9c344c4386cab17c1589964fa447f3384191ea7fde92648e8edbdfa24`。仅记录协议来源和内置字节表，未分发该脚本；未新增开源库、模型或字体依赖。签名字节表不包含账户凭据，站点更改协议需更新插件。

## 2026-09-23 验证

- 实际 HTTP：4 页共 367 条上传，去重为 99 话（0–97，另有 0.5），74 话选择官方上传。第 0 话 192 张，其中 19 张标记切片还原；第 97 话 84 张。只验证这部样例及选定章节，不代表全站每部漫画均已验收。
- 隔离 Chromium MV3：真实链接导入、第一话图片显示、760×1282 的真实切片图还原及目录刷新通过。来源标签页新增数为 0，受管标签页记录为空，浏览器错误为 0。已查看入口、阅读器和还原图截图。
- 人工图块在浏览器逐像素比较通过，包含不能被网格整除的下边缘；站点洗牌结果和本地实现的固定向量一致。
- 单元测试覆盖分页遗漏／重复／总数漂移／跨作品、官方优先、小数话、固定已选上传、同话上传消失、更新幂等、阅读位置与缓存保留、无标签页路径、未知图片协议和 xkcd 移除。
- 测试浏览器使用隔离资料并预授予域名权限；未验证原生授权弹窗。未调用翻译模型。源站第 0 话包含上传者插入的提示页，适配保留来源清单，不据此猜测并删除图片。

扩展目录执行 `npm run check`、`npm test`、`npm run build`。仓库根目录执行：

```powershell
# 按本机安装情况设置 PLAYWRIGHT_MODULE 和 TEST_CHROMIUM。
node apps/extension/src/sources/sites/comix/tests/verify-browser.mjs
$env:RUN_LIVE_COMIX = '1'
node apps/extension/src/sources/sites/comix/tests/verify-browser.mjs
Remove-Item Env:RUN_LIVE_COMIX
```

浏览器验收产物在忽略目录 `artifacts/comix-validation/`。普通验证仅检查站点入口与人工图块；开启 live 才访问真实来源，不将样本验证当作实际站点或真实翻译验收。

## 来源边界回归

`node apps/extension/src/sources/sites/comix/tests/verify-boundaries.mjs` 用隔离 Chromium、站点样本及真实本地 HTTP 服务检查公共目录 UI、错误恢复、导入阅读、缓存重开，以及跨扩展页面请求头隔离、取消清理与关闭页面后的规则恢复。它不代表真实源站或原生权限弹窗验收。公共约束见[网站适配规范](../../../../../../docs/SITE_ADAPTERS.md)，当次结果输出到忽略的 `artifacts/source-boundaries/`。
