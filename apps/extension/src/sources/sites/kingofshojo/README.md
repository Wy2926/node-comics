# King of Shojo

支持 [kingofshojo.com](https://kingofshojo.com/) 的 `/manga/<slug>/` 作品及根路径 `/<slug>-chapter-<number>/` 章节。提供名称分页搜索、完整静态目录、公开正文／封面、12 小时目录同步、浮动导入和当前作品名；原位识图沿用通用规则。

裸章节通过源站 `.allc` 作品链接解析归属；目录输出的本机片段 `#nodelane-kingofshojo=<作品 slug>` 不发送给源站、不改变章节身份。条目顺序以完整源站目录为准，不补造缺失话数。

## 协议与分类

显式调用 [MangaThemesia](../../shared/mangathemesia/README.md)，配置 `reader: 'minimal'`。只接受直接静态 JSON 调用、现代公开访问字段、完整模式及 `contentmode: minimal`；HTML 与 JSON 的全部图片数量／顺序／URL 必须一致。缺失或受保护的清单不回退，不执行源站脚本及浏览量 POST。

[首页](https://kingofshojo.com/)声明免费阅读；已核对作品目录与公开章节，收费归为 `free`，并非对未来收费的承诺。日漫标签依据[《The Angel Next Door Spoils Me Rotten》](https://kingofshojo.com/manga/the-angel-next-door-spoils-me-rotten/)的日文原名和 Manga 类型，韩漫／条漫依据[《The Evil Grand Duchess Has a Secret Life》](https://kingofshojo.com/manga/the-evil-grand-duchess-has-a-secret-life/)，国漫依据[《You Are My Desire》](https://kingofshojo.com/manga/you-are-my-desire/)；英语译作，不标生肉。默认从左向右，用户可在阅读器调整方向。

参考 [Keiyoushi KingofShojo](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/kingofshojo)及真实原始响应。固定版本、摘要和 Apache-2.0 许可见[上游记录](../../shared/mangathemesia/upstream.json)；不打包 Kotlin／APK。图标为本项目绘制。

## 验证入口

在仓库根构建后，按[共享浏览器入口](../../shared/madara/README.md#验证入口)配置 Playwright／Chromium：

```powershell
npm --prefix apps/extension test -- src/sources/shared/mangathemesia src/sources/sites/kingofshojo
node apps/extension/src/sources/shared/mangathemesia/tests/verify-http.mjs kingofshojo
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs kingofshojo https://kingofshojo.com/manga/the-evil-grand-duchess-has-a-secret-life/ "https://kingofshojo.com/the-evil-grand-duchess-has-a-secret-life-chapter-1/#nodelane-kingofshojo=the-evil-grand-duchess-has-a-secret-life" --max-pages=60
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs kingofshojo "grand duchess" nodelanevalidationzzqv --html-search --page-size=10 --max-pages=2
```

HTTP 验证按固定样本读取正文和有限图片字节；真实 MV3 验证两章实际图片、封面、小窗口、重开位置、重复导入以及名称分页／空结果。夹具覆盖协议拒绝与归属，浏览器验证不调用模型；原位译图、原生撤权与真实翻译效果未由这些入口验证。统计和截图保存在忽略的产物目录。
