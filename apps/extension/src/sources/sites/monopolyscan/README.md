# Monopoly Scan

- 仅认领 `https://monopolymanhua.com`；作品 `/manga/<slug>/`，章节 `/manga/<slug>/<chapter>/`。保留 `capitulo-1` 等不透明章节标识及下划线后缀，单一 `?style=list`／`?style=paged` 不改变身份；不认领镜像主机。
- 通过 [Madara 共享引擎](../../shared/madara/README.md)读取作品详情、只读 AJAX 完整目录和列表正文，校验 canonical、作品数字 ID、全部章节归属及正文页槽。本站只配置来源身份和已验证协议，不独立解析 HTML 或执行源站脚本。
- 章节的 AJAX 导航占位标记逐份核对同一作品、章节和列表样式；图片保留连续 `image-N` 页槽及重复 URL。目录、正文与封面走普通 HTTP，图片权限、Referer 和读取预算沿用公共管线。
- 名称搜索复用共享只读 AJAX 协议：每页 12 项、每页一次 POST，无初始化 GET 或目录预取；严格校验末页标记、空结果和来源归属。
- 提供浮动导入／管理入口、12 小时目录更新和 `inlineRecognition: 'generic'` 原位识图，无额外页面适配器。主要内容为西班牙语翻译国漫，默认从左向右阅读；全站收费规则未确认，定价为 `unknown`。

协议参考为 Keiyoushi 固定版本的 [MonopolyScan](https://github.com/keiyoushi/extensions-source/blob/780153a29642a57364e894bc0850c4e76619c7de/src/es/monopolyscan/src/eu/kanade/tachiyomi/extension/es/monopolyscan/MonopolyScan.kt) 及源站公开响应；来源、摘要和许可由共享引擎的[上游声明](../../shared/madara/upstream.json)维护，不运行 Kotlin。本地图标为自制识别图。

## 验证

在插件目录执行 `npm test -- src/sources/shared/madara src/sources/sites/monopolyscan --maxWorkers=2`。本站自造夹具覆盖精确 URL、身份隔离、能力、请求数量、取消、目录归属及三份正文导航标记，不提交源站漫画 HTML 或图片。

真实服务需检查详情 → AJAX 目录 → 两章原始正文响应及图片解码，再使用[共享真实浏览器入口](../../shared/madara/README.md#验证入口)检查导入、阅读和重开位置，站点参数为 `monopolyscan`。名称搜索使用共享 `verify-search-browser.mjs` 验证分页终点、无结果、封面解码和无目录预取。普通 HTTP、自造夹具、真实浏览器与模型效果分别验收；证据仅保存于忽略的 `artifacts/`。
