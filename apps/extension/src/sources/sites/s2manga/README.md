# S2Manga / S2READ

支持 [s2read.com](https://s2read.com/) 的 `/manga/<作品>/` 与 `/manga/<作品>/<章节>/`。提供英语名称搜索、静态完整目录、公开正文／封面、12 小时同步、网页浮动导入和轻量作品名交接；原位识图沿用通用规则。源站首页确认从 S2Manga 改名到 S2READ，只认领已核验的新域名，不自动接受旧域名或镜像。

## 协议与分类

直接复用 [Madara](../../shared/madara/README.md) 的静态目录、`reader: 'ajax-select'` 和每页 12 项的 `search: 'ajax'`。目录一次 GET，正文一次 `?style=list` GET，搜索每页一次只读 POST；核对章节 canonical、预填充导航选择项、当前章节和连续图片槽。保持源站顺序，不根据章节数字重新排序。默认从左向右。

[首页](https://s2read.com/)声明免费阅读，公开目录与正文可匿名访问；[分类页](https://s2read.com/manga-genre/doujinshi/)列出日漫、韩漫、国漫、条漫和同人作品，据此标为 `free` 及对应内容标签。英语译作为主、不标生肉；源站提示内容为预览，不承诺作品无缺章。没有因注册、收藏或源站购买原版的提醒声明阅读需登录或付费。

协议参考 [Keiyoushi S2Manga](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/s2manga)与真实原始响应；固定提交、文件摘要和 Apache-2.0 许可见[上游记录](../../shared/madara/upstream.json)。不打包 Kotlin／APK，不执行源站脚本；图标为项目绘制。

## 验证入口

构建后按[共享浏览器入口](../../shared/madara/README.md#验证入口)配置 Playwright／Chromium，在仓库根执行：

```powershell
npm --prefix apps/extension test -- src/sources/shared/madara src/sources/sites/s2manga
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs s2manga https://s2read.com/manga/soul-land-iv-8211-the-ultimate-combat/ https://s2read.com/manga/soul-land-iv-8211-the-ultimate-combat/chapter-2/
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs s2manga "soul land" nodelanevalidationzzqv --max-pages=3
```

自造夹具覆盖站点身份与静态目录接线，共享测试覆盖通用边界。真实 MV3 检查完整目录、两章取图／封面解码、单页有限图片窗口、小窗口、重开位置、目录更新幂等及失败恢复；搜索检查分页直到末页、空结果和不写书架。产物写入忽略的目录，不调用模型，也不代替原位译图或撤权验证。
