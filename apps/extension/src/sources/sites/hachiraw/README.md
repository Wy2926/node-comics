# Hachiraw

支持 `https://hachiraw.net/manga/<slug>` 作品详情及 `/manga/<slug>/chapter-<编号>` 章节链接。编号以数字开头，允许连字符分隔的字母数字后缀（如 `92-fix`）；完整编号作为独立发布身份，不把修正版合并到原章。提供名称搜索、完整静态目录、正文原图、专用作品封面、12 小时目录同步和作品／章节浮动导入入口。标签页识别通过 `inlineRecognition: 'generic'` 复用通用已加载大图规则，不提供专用页面扫描器。

## 协议与边界

协议来自 [Hachiraw](https://hachiraw.net/) 的公开 HTML，不复制或执行源站脚本。

- 目录读取作品信息内 `.col-12` 中的全部 `.ChapterLink`，包含 CSS 隐藏章节；“显示更多”只改变可见性，不需要额外请求。按源站上一章／下一章顺序反转为从旧到新，保留实际章节标题、连字符编号和独立发布条目；重复或跨作品链接拒绝。
- 作品封面取自 `.bottom-5` 专用图片，核对 `/mangacover/<slug>.jpg` 归属。源站的 canonical／og:url 可能指向首页，不用于证明作品身份。
- 正文核对 `#ChapterModal` 当前章与 `.DesktopNav` 所属作品、标题和总页数，读取 `#TopPage.ImageGallery` 内的 `data-original`。只排除已确认的站内插图 `https://hachiraw.net/01.png`，其余图片必须与声明页数一致；保持重复 URL 和源站页序，不按文件名补页或排序。
- 名称搜索使用 `/list-manga?search=<名称>`，每页最多 20 个候选，按源站 `/list-manga/<页码>?search=...` 链接翻页；校验结果总数、当前页和下一页。搜索不读取作品目录，不能用最多 10 条的自动补全接口替代完整搜索。
- 目录与正文通过 `pageTransport` 在真实来源网页会话中各请求一次；搜索保留普通 HTTP 通道。图片采用公共读取器、权限与默认 Referer，不做 HTTP 失败后的跨通道兜底。验证响应明确失败，由用户在同一浏览器完成验证后手动重试；不破解验证或读取、上传 Cookie。

## 验证

仓库根目录执行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test -- --run src/sources/sites/hachiraw/tests
npm --prefix apps/extension run build
```

单测使用自建 HTML 夹具，覆盖 URL 与作品归属、隐藏目录、分页搜索、页数核对、宣传图过滤、重复图址、取消及失败保留；不是实时源站验收。

真实响应检查：在 `apps/extension` 运行 `npx vite --host 127.0.0.1 --port 5181 --strictPort`，打开 `http://127.0.0.1:5181/src/sources/sites/hachiraw/tests/probe.html`。输入公开响应的原始 HTML、对应来源 URL 和操作，搜索翻页填写 `page:<页码>`；夹具只解析和运行公共契约校验，不执行 HTML、不请求图片或翻译服务。浏览器自动翻译后的 DOM 不能代替原始响应。

浏览器阅读还需加载构建产物验证导入、图片解码、重开位置和通用标签页识图；CF 验证、权限撤销／恢复与真实模型效果单独验收。通用隔离夹具及环境见[脚本入口](../../../../../../scripts/README.md)。
