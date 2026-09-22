# 网站图片适配

本文记录当前实现。公共执行层、通用适配、独立站点目录和目录／身份解耦已落地，详见[适配架构](SOURCE_ADAPTER_ARCHITECTURE.md)。

## 接口和边界

- `sources/index.ts` 向后台、书库和 UI 提供身份、目录校验、权限和消息服务，不加载 DOM 页面工厂；`sources/page.ts` 向内容脚本提供导航与页面会话。
- `registry/definitions.ts` 聚合纯 `SourceDefinition`；`registry/pages.ts` 聚合相同 ID 的 `CreateSourcePage`。先校验 URL，再要求恰好一个站点匹配；未知网站使用 `generic`，冲突报错。已认领站点等待、失败或不支持时不隐式退回通用规则。
- 站点的主机、路径、图片／目录选择器、标签映射和专属观察属性只在 `sites/<id>/` 中。页面会话返回 `ready`、`not-ready`、`unsupported` 或 `error`，清单完整性独立表达。
- `DiscoveredPage` 区分 HTTP 原图和页面逻辑资源。公共运行时生成临时页面句柄，绑定导航、页槽、元素和来源版本；站点不能自行生成授权。消息快照保留运行时的页槽和句柄，持久副本不保存临时页面引用。
- 缩略图总量不超过 2 MB，原图单张不超过 40 MB；画布最多 6000 万像素，编码／读取 30 秒超时。取图前后核对元素、版本和导航，SPA 离开再返回也使旧授权失效。
- `<img>` 使用通用图片展示，canvas 使用不修改原像素、不接收指针事件的覆盖层；恢复原图时移除。站点改变图源、回收 canvas 或重新渲染同一画布时撤销旧显示。
- 目录能力当前只有 MangaCopy：定义提供可靠的目录归属，公共层检查重复 ID、分组引用、顺序和每个条目的归属。站点仅提供标准分类建议；作品绑定、排除项与用户确认留在书库中。

已有 MangaCopy、Comic PASH、xkcd、Gunnerkrigg 与通用图片规则接入。原有安装权限与自动注入范围保持不变；新增站点默认依靠用户操作和可选授权。旧根目录站点文件与注册表已删除，没有转发、数据迁移或旧逻辑回退。

## Comic PASH

适配入口：`https://comicpash.jp/episodes/<id>`（包括 www 主机）。示例：<https://comicpash.jp/episodes/60cfe4785e2af>。

该站 Comici 阅读器加载图片后绘制到 canvas；普通 `<img>` 多为封面和广告，网络图片也可能尚未完成阅读器的切片还原。适配器读取 `#comici-viewer #xCVPages` 下包含 `.-cv-page-canvas` 的漫画页，仅接纳 `mode-rendered` 中的画布。广告页、推荐书籍、点赞页和结束页不计入漫画总数。

- 网页翻译：读取当前已渲染画布，翻页后自动发现新画布，沿用当前页及后续可用页的有限翻译窗口。
- 图片导入：通过插件“发现网页图片”选择当前已加载页面；翻页后刷新发现。导入完成前保持来源页打开，画布被回收或页面改变时需重新发现。
- 当前已渲染窗口始终按部分清单交付；所有当前页槽可见也不推断整章完整。
- 清晰度以源站当前渲染为准；不声称得到 CDN 原始分辨率，不自动翻完全部页面，不绕过付费／登录限制。

## 验证

先在 `apps/extension` 执行 `npm run check`、`npm test`、`npm run build`。在仓库根目录执行：

```powershell
# Playwright 不在默认模块目录时设置 PLAYWRIGHT_MODULE；浏览器位置可用 CHROMIUM_PATH 指定。
node scripts/verify_comicpash.mjs
node scripts/verify_inline_translation.mjs

# 真实来源页面；翻译服务仍为本地模拟，不调用真实供应商。
$env:RUN_LIVE_COMICPASH = '1'
node scripts/verify_comicpash.mjs
node scripts/verify_inline_translation.mjs
Remove-Item Env:RUN_LIVE_COMICPASH
```

两个脚本使用临时扩展副本、隔离浏览器资料和预授权来源。`verify_comicpash.mjs` 覆盖识别、排除广告、页序／完整性、取图权限、画布更新与实际导入阅读器；`verify_inline_translation.mjs` 覆盖普通图片回归和 RTL 画布的取图、显示、点击、原图恢复、替换节点及截图像素对比。`RUN_LIVE_COMICPASH=1` 额外验证真实网页；不等同真实模型翻译效果验收，未验证原生浏览器授权弹窗。

此前真实站点验证（不是本轮架构重构的验证结果）：2026-09-22 实测样例包含 32 个漫画页槽，初始读取 3 页；首张导入图片为 844 × 1200。来源结构、视口与懒加载会影响实际发现数量及尺寸，以当次页面为准。脱敏检查结果和截图输出到忽略目录 `artifacts/comicpash-validation` 与 `artifacts/inline-validation`。

本轮架构重构及审查修复验证：类型／模块边界检查、单元测试和 Chrome MV3 构建通过。共 39 个测试文件、374 项单元测试；网页导入 13 个场景、原位翻译 23 个场景、Comic PASH 8 个场景及采集顺序／暂停恢复／仅重试缺图检查通过。新增覆盖 DOM 重建后选择／顺序保留、发现与原位翻译跨脚本共享会话、挂载容器替换、无关样式变化过滤、解析诊断跨消息传递、缩略图缓存和预算。已查看按钮恢复及原位译图截图。缓存恢复检查在实际扩展中模拟 `pagehide/pageshow` 事件，未证明浏览器实际进入 BFCache；真实网站可用性、原生权限弹窗及真实模型效果另行验证。

本机复现隔离浏览器检查时，`PLAYWRIGHT_MODULE` 指向已安装的 Playwright；`TEST_CHROMIUM`（网页导入／采集顺序）及 `CHROMIUM_PATH`（画布／原位翻译）可指定现有 Chromium。验证使用 Chromium 141，不读取个人浏览器资料。当前证据在 `artifacts/web-import/results.json`、`artifacts/acquisition-order/results.json`、`artifacts/comicpash-validation/fixture-4X660w/results.json`、`artifacts/inline-validation/d01d35a1-0f81-40f9-b997-247c15095047/results.json`；这些运行产物位于忽略目录，不随源码提交。
