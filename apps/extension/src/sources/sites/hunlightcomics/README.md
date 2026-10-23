# Hunlight Comics

支持 [hunlightcomics.com](https://hunlightcomics.com/) 的 `/m/<作品>/` 及 `/m/<作品>/<章节>/`。提供英语名称搜索、完整 AJAX 目录、公开正文／封面、12 小时目录同步和网页浮动导入；当前作品名来自核验归属的面包屑，原位识图复用通用规则。

## 协议与分类

直接复用 [Madara 共享引擎](../../shared/madara/README.md)：`catalog: 'ajax'`、`reader: 'ajax-select'`、`search: 'ajax'`、每页 12 项。目录只请求详情和作品自己的只读章节列表；正文只请求一次 `?style=list`，核对章节 canonical、作品／章节导航标识与连续图片页槽。身份忽略已支持的 `style=list|paged`，其他查询、片段、跨作品或跨域归属拒绝。默认从右向左，用户可调整。

实站路径为 `/m/`，并非主题默认 `/manga/`；不添加未经验证的域名或路径别名。

[首页](https://hunlightcomics.com/)与[样本目录](https://hunlightcomics.com/m/maol-daily-life-of-a-corporate-slave-ol-and-another-worlds-demon-king-who-exchanged-bodies/)的章节无需购买即可读取，未发现会员专享正文或提前看入口，归为 `free`。作品信息与公开正文显示日漫英语译作，标注日漫、不标生肉；这不是全站逐作或未来收费保证。

协议参考 [Keiyoushi Hunlight Comics](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/hunlightcomics)与真实原始响应。固定版本、SHA-256 和 Apache-2.0 许可见[上游记录](../../shared/madara/upstream.json)。不打包 Kotlin／APK；图标为本项目绘制。

## 验证入口

在仓库根构建插件后，按[共享浏览器入口](../../shared/madara/README.md#验证入口)配置 Playwright／Chromium：

```powershell
npm --prefix apps/extension test -- src/sources/shared/madara src/sources/sites/hunlightcomics
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs hunlightcomics https://hunlightcomics.com/m/maol-daily-life-of-a-corporate-slave-ol-and-another-worlds-demon-king-who-exchanged-bodies/ https://hunlightcomics.com/m/maol-daily-life-of-a-corporate-slave-ol-and-another-worlds-demon-king-who-exchanged-bodies/chapter-2/
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs hunlightcomics the nodelanevalidationzzqv --max-pages=3
```

自造夹具检查站点身份、协议接线和请求数量，共享引擎覆盖完整性、取消与失败边界。真实隔离 MV3 检查两章取图解码、封面、小窗口、阅读／重开位置及刷新幂等；搜索检查三页加载、终点和空结果，不导入候选。截图与统计在忽略的产物目录。不调用模型，不以这些验证替代原位译图、原生撤权或真实翻译效果。
