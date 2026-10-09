# HERO'S Web

支持 [HERO'S Web](https://heros-web.com/) 的名称搜索、专属封面、完整公开目录、作品／章节导入、HTTP 正文与图片还原、12 小时目录同步和网页浮动入口；当前标签页的正文 canvas 可用于原位翻译。

## URL 与协议

- 作品：`https://heros-web.com/series/<id>`，包括数字分页与 `new`／`old` 排序地址。
- 章节：`https://heros-web.com/episodes/<id>` 及源站章节目录的数字分页／排序地址。裸章节校验 canonical 和 `#comici-viewer` 元数据后解析所属作品；生成的目录链接以 `#nodelane-heros=<series>` 绑定作品，并在读取时核验。
- 目录：从 `/series/<id>/1` 开始按编号顺序读取。作品首页只显示首尾部分章节；完整性由所有连续分页范围、实际数量和重复／归属检查证明，多页目录重读首页核对变化。
- 搜索：`/api/search?q=<名称>&page=<页>&size=24`，页大小与当前源站搜索一致。仅采用 `searchResult.series`，不返回作者命中或章节命中。源站的跨页排序可能变化；已有搜索会话按稳定作品身份去重，不承诺结果是不可变快照。
- 正文：`/api/book/contentsInfo?user-id=&comici-viewer-id=<viewer>&page-from=0&page-to=<最后页>`；先取第 0 页确定总数，再获取完整清单。只接受 `https://comicsviewer.heros-web.com/book/<viewer>/...` 图片。专属作品封面取自 `img.series-h-img`，缺失时使用作品 `og:image`。
- 取图：源站 CDN 要求来源 Referer，沿用公共管线的 `strict-origin-when-cross-origin` 行为，不添加站点专用请求头规则。图片清单中的签名地址不进入测试夹具或报告。

本网站与 Comic PASH 使用相同 Comici 阅读协议和图片算法，复用 [共享实现](../../shared/comici/README.md)，不导入其他站点模块。当前网页正文限定为 Comici 加载的 canvas，排除广告／结束页；DOM 窗口保持部分状态，完整导入始终走独立 HTTP 通道。

目录包含源站付费及等待解锁章节，仅读取当前公开返回的正文，不购买、不解锁、不以错误响应绕过访问限制。源站确有金币章节，因此网站目录标注“部分收费”，不声明全站免费。

公开样本：[仮面ライダークウガ](https://heros-web.com/series/e5c7cc354cc05)、[其首话](https://heros-web.com/episodes/ecca9c98b6dbe)、[ULTRAMAN](https://heros-web.com/series/33279f813eee3)。协议与图块算法依据源站公开 HTML、接口和 [viewer.js](https://heros-web.com/js/viewer/viewer.js)，摘要及复用边界见共享实现说明。图标为本地字母标识，不包含远程依赖。

## 验证

在仓库根目录执行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/heros/tests/verify-http.mjs
```

单测覆盖注册元数据、来源隔离、目录缺失／重复／变更、章节归属、取消、正文完整性、图片配方与主机、搜索分页，以及原位页槽、重绘／重绑／导航失效；共享图片还原由 Comic PASH 解码回归覆盖。

`verify-http.mjs` 默认读取两个公开样本的真实搜索、完整目录、章节归属、清单、首图和封面，另验空搜索及翻页；`HEROS_SEARCH_QUERIES` 可指定逗号分隔的公开查询。产物写入忽略的 `artifacts/heros/http/`，不记录签名图片地址。此脚本不调用模型、登录、购买或账户 API，也不证明 MV3 导入交互、插件阅读位置恢复、原位译图恢复及真实模型效果；这些需按[公共验收规范](../../../../../../docs/SITE_ADAPTERS.md#验收与交付)在加载构建产物的桌面浏览器单独检查。
