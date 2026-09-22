# 网站图片适配

本文记录当前实现。通用适配、各站点独立目录及目录能力解耦的目标设计见[适配架构设计](SOURCE_ADAPTER_ARCHITECTURE.md)；该重构尚未实施。

## 接口和边界

图片适配统一从 `apps/extension/src/sources/adapters.ts` 的 `sourceAdapters` 注册表选择，未命中时使用通用 `<img>` 规则。`model.ts` 定义 `SourceAdapter`：

| 能力 | 责任 |
| --- | --- |
| `id`、`name`、`matches` | 站点标识、展示名称和严格的主机／路径匹配 |
| `discover` | 页面清单、原始页序、方向、总页数与完整性；不能把已加载部分声明成整章 |
| `read`（可选） | 异步补全清单，例如 MangaCopy 的页面内数据 |
| `images`（可选） | 网页内实际渲染目标、来源版本和本地字节读取函数；默认读取普通图片 |
| `direction`（可选） | 网页双页显示时确定当前页；从右向左的跨页先读右页 |

已有 MangaCopy、xkcd、Gunnerkrigg、Comic PASH 与通用图片规则接入。新增同类图片网站只需增加适配模块并注册；图片选择、权限、消息、导入和翻译调度复用现有流程。站点原始数据和 DOM 视为不可信输入，不执行页面脚本，不将内容中的地址当作任意代理授权。

`SourceItem.kind = page` 表示来源页内的渲染图像，地址是不可联网的临时 `page-image:` 引用。内容脚本登记元素和来源版本；后台按已保存清单、标签页、导航版本和页面地址授权，取图前后核实登记项与当前元素。缩略图总量不超过 2 MB，原图只在明确导入／当前翻译窗口取图时编码，每张不超过 40 MB。失败返回原因，原图字节最终沿用本地 Blob 缓存。临时引用不会写入副本的远程原图地址。

网页内显示按元素类型选择普通图片替换或画布译图覆盖层。画布覆盖层不改原始像素，也不接收指针事件，恢复原图时移除。站点重新创建画布、改变来源版本或翻页时重新核对目标。

**目录能力仍有边界：** 全作品目录导入、镜像跳转等目前由 MangaCopy 实现，`background.ts`、`sources/client.ts` 与目录映射仍包含对应契约。图片注册表不代表任何新站点已具备目录采集能力；接入第二个目录站点时应提取目录发现、校验和来源身份接口。此次没有新增 Comic PASH 全作品目录或自动采集整章。

## Comic PASH

适配入口：`https://comicpash.jp/episodes/<id>`（包括 www 主机）。示例：<https://comicpash.jp/episodes/60cfe4785e2af>。

该站 Comici 阅读器加载图片后绘制到 canvas；普通 `<img>` 多为封面和广告，网络图片也可能尚未完成阅读器的切片还原。适配器读取 `#comici-viewer #xCVPages` 下包含 `.-cv-page-canvas` 的漫画页，仅接纳 `mode-rendered` 中的画布。广告页、推荐书籍、点赞页和结束页不计入漫画总数。

- 网页翻译：读取当前已渲染画布，翻页后自动发现新画布，沿用当前页及后续可用页的有限翻译窗口。
- 图片导入：通过插件“发现网页图片”选择当前已加载页面；翻页后刷新发现。导入完成前保持来源页打开，画布被回收或页面改变时需重新发现。
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

2026-09-22 实测样例包含 32 个漫画页槽，初始读取 3 页；首张导入图片为 844 × 1200。来源结构、视口与懒加载会影响实际发现数量及尺寸，以当次页面为准。脱敏检查结果和截图输出到忽略目录 `artifacts/comicpash-validation` 与 `artifacts/inline-validation`。
