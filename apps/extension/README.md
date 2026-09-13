# Node Comics · 漫游插件

React / TypeScript / WXT Manifest V3 阅读器。当前是本地预览，尚未在扩展商店发布。

## 运行

要求 Node.js 22.23+、npm 10+。后端默认 `http://127.0.0.1:18088`。

```powershell
cd apps/extension
npm ci
npm run dev           # http://127.0.0.1:5173，共享同一套阅读器 UI
npm run check
npm test
npm run build         # .output/chrome-mv3
npm run build:web     # dist-web
```

Chrome / Edge 的扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，打开 `.output/chrome-mv3`。点击工具栏插件后，主动授权当前网页，再发现图片。可直接在扩展独立阅读页导入本地图片或无 DRM MOBI。

`.npmrc` 使用 `legacy-peer-deps` 避免 npm 10 对 Vitest 可选浏览器 peer 递归解析时的 `edgesOut` 异常。实际使用 WXT 0.21.4、React 19、Vite 7 和 Vitest 5；测试与生产构建分别验证。开发工具的 `web-ext → addons-linter → image-size 2.0.2` 有尚无 npm 修复版的高危 ICNS/JXL/HEIF 解析公告，未进入最终扩展包；`npm audit --omit=dev` 单独检查运行依赖。不使用不兼容的旧 web-ext 版本掩盖审计结果。

## 本地数据和任务

- 图片 Blob 与书架在 IndexedDB；对象 URL 只用于当前挂载窗口，卸载即释放。连续模式最多挂载当前页附近 5 张图片，并按 3200 万像素预算收缩窗口。并排对照保持各自图片比例。
- 阅读位置保存为页面 ID 与页内相对位置。原图阅读不请求业务 API，不上传文件。开始翻译时只上传选定页，确认报价后才创建 AI 图片翻译任务。
- MOBI 按记录切片读取，不执行书内 HTML；使用现有图像尺寸避免全卷解码。无 DRM MOBI6/PalmDOC 支持范围、KF8/HUFF/DRM 等限制由导入器显式报错。GIF 仅取首帧转 PNG，其他图片保持原始字节。
- 身份、资产和任务由服务 origin 与用户 ID 双重隔离。更换服务地址需显式保存，新 origin 会退出登录。供应商 Key 永远不在前端。
- 提交前持久化报价与幂等键；收到结果并保存任务 ID 后才清除待核实记录。刷新后显示原确认入口并沿用同一个 key；上游结果未知不自动重发。主动生成新版本使用专门的 rerun 接口。
- 自动翻译默认关闭。每次明确开启时确认本次最大页数和额度；关闭开关或离开阅读器后阻止新任务提交。服务器已经接收的任务独立继续执行。
- xkcd / Gunnerkrigg 适配器仅标识当前一期或单页，通用适配器只发现当前 DOM 中已加载的大图，不声称完整章节。图片获取失败保留原因，用户可返回来源或本地导入。
- 授权码 + PKCE 支持在后端提供正式 OIDC 配置时启用；开发登录仅在后端 `dev_auth` 开启时显示。实际身份服务与商店安装仍需部署环境验收。

本地示例为原创《星光书店》原图，没有预制或伪造译图。图片格式校验不等同于翻译质量验收，实际 AI 翻译须保留原图与最终输出对照。

最终构建、27 个测试、权限检查、依赖审计与 ZIP 校验和见 [前端验证记录](../../docs/evidence/frontend-validation.md)。
