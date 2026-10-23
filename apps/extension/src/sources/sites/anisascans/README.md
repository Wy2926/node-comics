# Anisa Scans

支持 [anisascans.in](https://anisascans.in/) 的 `/manga/<作品>/` 与 `/manga/<作品>/<章节>/`，提供英语名称搜索、完整 AJAX 目录、公开正文与封面、12 小时同步、网页浮动导入和轻量作品名交接。原位识图沿用通用规则。

## 协议与分类

复用 [Madara](../../shared/madara/README.md)：`catalog: 'ajax'`、`reader: 'ajax-breadcrumb'`、`search: 'ajax'`，搜索每页 12 项。目录一次详情 GET 加一次作品章节 POST；正文一次 `?style=list` GET，沿用章节 canonical、作品／章节导航与连续图片槽校验。本站没有章节 h1，显式从“首页／所属作品／当前章节”面包屑读取章节名，核对所属作品和当前项；不从文档标题猜测，也不让其他站点自动回退。网页作品名复用当前 DOM 面包屑，不请求目录。默认从右向左。

[首页](https://anisascans.in/)声明免费阅读 Manga、Manhwa、Manhua，并有 Webtoons 分类；公开目录及正文样本可匿名读取，按此标为 `free`、日漫／韩漫／国漫／条漫。英语译作为主，不标生肉；这是当前公开阅读范围，不承诺全站永久可用或解除未来付费限制。

协议参考 [Keiyoushi Anisa Scans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/anisascans)和真实响应，固定提交、文件摘要及 Apache-2.0 许可见[上游记录](../../shared/madara/upstream.json)。不执行源站脚本、浏览量或解锁请求，不打包 Kotlin／APK；图标为项目绘制。

## 验证入口

构建后按[共享浏览器入口](../../shared/madara/README.md#验证入口)配置 Playwright／Chromium，在仓库根执行：

```powershell
npm --prefix apps/extension test -- src/sources/shared/madara src/sources/sites/anisascans
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs anisascans https://anisascans.in/manga/i-opened-a-magic-tool-repair-shop/ https://anisascans.in/manga/i-opened-a-magic-tool-repair-shop/chapter-2/
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs anisascans repair nodelanevalidationzzqv --max-pages=2
```

站点夹具只覆盖身份与接线；结构变体、取消和完整性集中在共享测试。真实 MV3 验证两章与封面解码、小窗口、重开位置、目录刷新幂等、错误提示和有效链接恢复；搜索检查单页终点及空结果，不冒称此样本覆盖真实多页加载。统计和截图写入忽略的产物目录；不调用模型，不代表原位译图或浏览器撤权验收。
