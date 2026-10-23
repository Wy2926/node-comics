# NekoScans / Neko Manga

支持 [nekoproject.org](https://nekoproject.org/) 的 `/manga/<作品>/` 和 `/<发布名>-capitulo-<编号>/`（含小数、连字符分段与字母后缀）。提供西语名称搜索、完整静态目录、公开正文／封面、裸章节归属、12 小时同步、网页浮动导入及轻量作品名交接。

## 协议与分类

直接复用 [MangaThemesia](../../shared/mangathemesia/README.md) 标准模式：`?s=` 与 `/page/<n>/` 名称分页、明确的“No encontrado”空结果、完整 `#chapterlist`、章节 canonical 与 `.allc` 作品绑定，以及单源 `ts_reader.run(JSON)` 图片清单。正文需明确未保护、非小说、无解锁令牌和完整 advanced 模式。四种操作各一次 GET，不执行源站脚本或浏览量 POST。裸章节不按发布名猜作品，绑定片段仅在本机使用、不发送给源站。默认从右向左；原位识图复用通用会话。

[日漫样本](https://nekoproject.org/manga/kemono-joushi-ni-jitsu-wa-mitomerarete-ita-hanashi/)、[国漫](https://nekoproject.org/manga/cosmetic-game-temporada-2/)和[韩漫](https://nekoproject.org/manga/los-tres-estan-viviendo-una-vida-de-casados/)明确标注内容类型，含彩色条漫；西语译作为主、不标生肉。结合公开目录、早期与后续章节匿名阅读及页尾 PayPal 支持入口，标为 `free`；支持捐赠不等于付费阅读。本站也含小说和空目录，本适配只支持有完整漫画图片清单的作品，不把空目录或小说当作可读漫画。

源站部分旧图片地址已失效：上述日漫第 1 章首尾图片在核验时返回 404。目录和页槽仍完整保留，不能删掉坏页后重编号；阅读器显示逐页错误，可翻到其他可用页。下列正常阅读样本使用第 32／31 章，不能据此宣称旧章节全部图片可用。

协议参考 [Keiyoushi NekoScans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/es/nekoscans)，固定版本、摘要和 Apache-2.0 许可见[上游记录](../../shared/mangathemesia/upstream.json)。不打包 Kotlin／APK；图标为项目绘制。

## 验证入口

构建后按[共享浏览器入口](../../shared/madara/README.md#验证入口)配置 Playwright／Chromium，在仓库根执行：

```powershell
npm --prefix apps/extension test -- src/sources/shared/mangathemesia src/sources/sites/nekoscans
node apps/extension/src/sources/shared/mangathemesia/tests/verify-http.mjs nekoscans
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs nekoscans "https://nekoproject.org/kemono-joushi-ni-jitsu-wa-mitomerarete-ita-hanashi-capitulo-32/#nodelane-nekoscans=kemono-joushi-ni-jitsu-wa-mitomerarete-ita-hanashi" "https://nekoproject.org/kemono-joushi-ni-jitsu-wa-mitomerarete-ita-hanashi-capitulo-31/#nodelane-nekoscans=kemono-joushi-ni-jitsu-wa-mitomerarete-ita-hanashi"
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs nekoscans amor nodelanevalidationzzqv --html-search --page-size=10 --max-pages=3
```

站点夹具检查身份、章节绑定与网络接线；共享测试检查完整性、取消和错误边界。HTTP 入口核对实际裸章节归属、目录、正文与有限图片头；真实隔离 MV3 检查搜索分页、空结果、两章／封面解码、单页有限图片窗口、小窗口、重开位置、更新幂等及失败恢复。统计与截图写入忽略的产物目录；不调用模型，不代表原位译图和撤权验证。
