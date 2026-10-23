# Aster Scans

支持 `https://asterscans.com/manga/<slug>/` 作品和 `/<slug>-chapter-<number>/` 章节；不认领其他域名、搜索／分类页或普通文章。提供英语名称分页搜索、HTTP 完整静态目录、公开正文、专门封面和 12 小时目录同步；网页提供浮动导入及作品名交接，原位翻译复用通用已加载大图识别。

裸章节通过源站作品链接确定归属，目录条目带本机片段 `#nodelane-asterscans=<作品 slug>`；片段不发送给源站，也不参与章节身份。目录保留源站实际条目和原始顺序，不根据名称补造缺话。

## 协议与支持边界

显式使用 [MangaThemesia 共享引擎](../../shared/mangathemesia/README.md)的旧版公开阅读协议；重复 canonical、初始化脚本中的静态 JSON 及 HTML 图片一致性规则以引擎为准。只解析数据，不运行源站脚本、写阅读历史、发送浏览量 POST 或获取账户令牌；受限正文或未知结构明确失败，不自动切换通道。图片／封面地址来自源站公开数据，普通 HTTP(S) 请求仍经过公共权限、取消与预算检查。

协议参考为 [Keiyoushi AsterScans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/asterscans)与源站公开响应。精确提交、文件 SHA-256、用途及随包 Apache-2.0 许可见[上游记录](../../shared/mangathemesia/upstream.json)。不移植、运行或打包 Kotlin／APK；图标为本项目绘制的识别图。

收费类型为 `free`，依据[首页](https://asterscans.com/)的自愿捐赠说明、[《I Think I Poked the Sleeping Lion》目录](https://asterscans.com/manga/i-think-i-poked-the-sleeping-lion/)及[公开章节](https://asterscans.com/i-think-i-poked-the-sleeping-lion-chapter-1/)的无需账户或购买的阅读行为；未发现付费解锁提示。捐赠不等于漫画收费，这是对公开内容的判断，不保证源站永久或全部作品免费。

上述作品信息明确标注 Manhwa 并保留韩文原名，结合纵向阅读正文归为韩漫、条漫；站内内容为英语译作，不标生肉。收藏与评论的账户功能不作为阅读登录要求；未核实的访问限制不添加标签。

## 验证

在仓库根目录执行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test -- src/sources/shared/mangathemesia src/sources/sites/asterscans
npm --prefix apps/extension run build
node apps/extension/src/sources/shared/mangathemesia/tests/verify-http.mjs asterscans
```

真实 HTTP 入口按固定公开样本检查名称／分页／空结果、目录、裸章节归属、16 页正文及封面／首尾图片的有限字节；不保留漫画文件。隔离测试覆盖伪造主机、片段归属、重复页、静态数据一致性、取消及失败保留。

构建后按[共享浏览器入口](../../shared/madara/README.md#验证入口)设置 `PLAYWRIGHT_MODULE`、`TEST_CHROMIUM`，执行：

```powershell
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs asterscans https://asterscans.com/manga/i-think-i-poked-the-sleeping-lion/ "https://asterscans.com/i-think-i-poked-the-sleeping-lion-chapter-2/#nodelane-asterscans=i-think-i-poked-the-sleeping-lion"
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs asterscans e nodelanevalidationzzqv --html-search --page-size=10 --max-pages=2
```

浏览器入口使用隔离 MV3 和真实公开 HTTP，检查导入、两话取图、重复刷新、阅读／重开位置；搜索入口不导入候选。截图与统计在忽略的产物目录。原位译图、浏览器原生撤权及真实翻译模型效果是另外的验收范围，不能由 HTTP／阅读通过推断。
