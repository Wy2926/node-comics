# Akaza Scans

支持 `https://akazascans.org/manga/<slug>/` 作品和 `/<slug>-chapter-<number>/` 章节；不认领其他域名、搜索／分类页或普通文章。提供英语名称分页搜索、HTTP 完整静态目录、公开正文、专门封面和 12 小时目录同步；网页提供浮动导入及作品名交接，原位翻译复用通用已加载大图识别。

裸章节通过源站作品链接确定归属，目录条目带本机片段 `#nodelane-akazascans=<作品 slug>`；片段不发送给源站，也不参与章节身份。目录保留源站全部实际条目和原始顺序，不根据名称补造话数。站内部分作品只提供后期章节，不代表此前各话存在于本站。

## 协议与支持边界

显式使用 [MangaThemesia 共享引擎](../../shared/mangathemesia/README.md)的旧版公开阅读协议；重复 canonical、初始化脚本中的静态 JSON 及 HTML 图片一致性规则以引擎为准。只解析数据，不运行源站脚本、写阅读历史、发送浏览量 POST 或获取账户令牌；受限正文或未知结构明确失败，不自动切换通道。图片／封面地址来自源站公开数据，普通 HTTP(S) 请求仍经过公共权限、取消与预算检查。

协议参考为 [Keiyoushi AkazaScans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/akazascans)与源站公开响应。精确提交、文件 SHA-256、用途及随包 Apache-2.0 许可见[上游记录](../../shared/mangathemesia/upstream.json)。不移植、运行或打包 Kotlin／APK；图标为本项目绘制的识别图。

收费类型是 `freemium`，不是全站免费：[《Emperor’s Domination》目录](https://akazascans.org/manga/emperors-domination/)有金币价格，[第 122 话](https://akazascans.org/emperors-domination-chapter-122/)明确要求购买并显示后续免费时间；另有无需购买的公开正文。适配器不购买、不充值、不消耗金币、不承诺解锁付费章节。含可用 URL 的目录项仍保留，正文受限时读取失败；不会隐藏条目后冒充完整免费目录。

内容标签依据作品信息与正文：[《Emperor’s Domination》](https://akazascans.org/manga/emperors-domination/)标注 Manhua，[《I’ll Retire After Saving the World》](https://akazascans.org/manga/ill-retire-after-saving-the-world/)保留韩文原名，结合韩漫作品与纵向正文归为韩漫、国漫、条漫。站内通用 `Manga` 类型不直接解释为日漫；内容为英语译作，不标生肉。这些是已核验内容的分类，不能推断全站每部作品或未来收费规则。

## 验证

在仓库根目录执行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test -- src/sources/shared/mangathemesia src/sources/sites/akazascans
npm --prefix apps/extension run build
node apps/extension/src/sources/shared/mangathemesia/tests/verify-http.mjs akazascans
```

真实 HTTP 入口按固定公开样本检查名称／分页／空结果、目录、裸章节归属、14 页正文及封面／首尾图片的有限字节；不保留漫画文件。隔离测试覆盖伪造主机、片段归属、重复页、静态数据一致性、取消及失败保留。

构建后按[共享浏览器入口](../../shared/madara/README.md#验证入口)设置 `PLAYWRIGHT_MODULE`、`TEST_CHROMIUM`，执行：

```powershell
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs akazascans https://akazascans.org/manga/the-investment-method-of-a-wall-street-genius-on-borrowed-time/ "https://akazascans.org/the-investment-method-of-a-wall-street-genius-on-borrowed-time-chapter-2/#nodelane-akazascans=the-investment-method-of-a-wall-street-genius-on-borrowed-time"
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs akazascans a nodelanevalidationzzqv --html-search --page-size=10 --max-pages=2
```

浏览器入口使用隔离 MV3 和真实公开 HTTP，检查导入、两话取图、重复刷新、阅读／重开位置；搜索入口不导入候选。截图与统计在忽略的产物目录。原位译图、浏览器原生撤权及真实翻译模型效果是另外的验收范围，不能由 HTTP／阅读通过推断。
