# Young Animal / ヤングアニマル

- 作品：`https://younganimal.com/series/<id>`，包括数字分页与 `new / old` 排序链接。
- 章节：`https://younganimal.com/episodes/<id>`。裸章节通过公开章节 API 核对所属作品；目录链接用 `#nodelane-younganimal=<series>` 绑定身份，读取时再次校验。
- 支持名称搜索、完整编号目录、作品封面、公开免费正文、12 小时目录更新与作品／章节浮动导入。原位翻译只识别已渲染的正文 canvas；不把当前窗口当完整章节。
- 只接受本站 `https://viewer.younganimal.com/book/<viewer-id>/` 正文。收费与免费章节并存；受限正文明确失败，不自动登录、购买、扣币、消耗券或领取限免。

显式复用 [ComiciViewer 共享引擎](../../shared/comici/README.md)。协议依据为源站公开响应与本地 Keiyoushi 固定版本的 `src/ja/younganimal/`，精确提交、文件摘要和许可见[上游记录](../../shared/comici/upstream.json)。不运行上游 Kotlin／APK 或下载的源站脚本；图标为本项目自制识别图。

## 验证

仓库根目录执行真实公开 HTTP 验证（搜索／分页／空结果、完整目录、裸章节归属、正文清单、首图字节和封面；不调用模型）：

```powershell
node apps/extension/src/sources/sites/younganimal/tests/verify-http.mjs
```

插件目录执行隔离协议单测：

```powershell
npx vitest run src/sources/sites/younganimal/tests
```

HTTP 字节验证不等于已安装扩展的导入、图像还原、阅读位置恢复或真实模型效果；浏览器验收入口与边界见共享引擎说明。
