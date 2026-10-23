# GakaMangas

支持 [gakamangas.com](https://gakamangas.com/) 的 `/manga/<作品>/` 及 `/manga/<作品>/<章节>/`。提供英语名称搜索、完整 AJAX 目录、公开正文／封面、12 小时目录同步和网页浮动导入；当前作品名来自核验归属的面包屑，原位识图复用通用规则。

## 协议与分类

直接复用 [Madara 共享引擎](../../shared/madara/README.md)：`catalog: 'ajax'`、`reader: 'ajax-select'`、`search: 'ajax'`、每页 12 项。目录只请求详情和作品自己的只读章节列表；正文只请求一次 `?style=list`，核对章节 canonical、作品／章节导航标识与连续图片页槽。身份忽略已支持的 `style=list|paged`，其他查询、片段、跨作品或跨域归属拒绝。默认从右向左，用户可调整。

[作者说明](https://gakamangas.com/about-us/)明确本站是其创作的跨作品 fan manga，标为同人，主要内容为英语、不标生肉。[公开章节](https://gakamangas.com/manga/zoro-vs-kenpachi-the-ultimate-crossover/chapter-1/)可免费读取，但页尾明确提示 Patreon 提前看，关联[作者 Patreon](https://www.patreon.com/Mangagaka)有付费解锁，因此归为 `freemium`，不将其当成单纯捐赠。适配范围仅限本站公开正文，不登录、订阅或读取 Patreon 内容。

协议参考 [Keiyoushi GakaMangas](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/gakamangas)与真实原始响应。固定版本、SHA-256 和 Apache-2.0 许可见[上游记录](../../shared/madara/upstream.json)。不打包 Kotlin／APK；图标为本项目绘制。

## 验证入口

在仓库根构建插件后，按[共享浏览器入口](../../shared/madara/README.md#验证入口)配置 Playwright／Chromium：

```powershell
npm --prefix apps/extension test -- src/sources/shared/madara src/sources/sites/gakamangas
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs gakamangas https://gakamangas.com/manga/zoro-vs-kenpachi-the-ultimate-crossover/ https://gakamangas.com/manga/zoro-vs-kenpachi-the-ultimate-crossover/chapter-2/
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs gakamangas a nodelanevalidationzzqv --max-pages=2
```

自造夹具检查站点身份、协议接线和请求数量，共享引擎覆盖完整性、取消与失败边界。真实隔离 MV3 检查两章取图解码、封面、小窗口、阅读／重开位置及刷新幂等；搜索检查当前 10 项单页终点与空结果，不冒称已验证实站多页加载，不导入候选。截图与统计在忽略的产物目录。不调用模型，不以这些验证替代原位译图、原生撤权或真实翻译效果。
