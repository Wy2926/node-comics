# ComiciViewer 共享引擎

由以下站点显式调用，共用编号目录、搜索响应、公开章节元数据、正文接口与 canvas 容器协议，不自动认领未知网站：

- [Comic PASH](../../sites/comicpash/README.md)、[HERO'S Web](../../sites/heros/README.md)、[Comic RIDE](../../sites/comicride/README.md)、[COMIC リュウ](../../sites/comicryu/README.md)
- [Young Animal](../../sites/younganimal/README.md)、[Champion Cross](../../sites/championcross/README.md)、[ヤンチャンWeb](../../sites/youngchampion/README.md)、[マンガBANGコミックス](../../sites/mangabang/README.md)
- [花とゆめ＋](../../sites/hanayume/README.md)、[竹コミ！](../../sites/takecomic/README.md)、[キミコミ](../../sites/kimicomi/README.md)、[アサコミ](../../sites/asacomi/README.md)

与 [Madara](../madara/README.md) 遵循同一共享边界：`config.ts` 只描述当前消费方需要的协议；站点 `definition.ts`／`protocol.ts` 声明域名、URL 身份、图片归属、搜索页大小及安装入口；网络请求仅走调用方 `context.request`，不直接使用 `fetch` 或浏览器 API。Comici 的解析函数和网络编排保持在 `network.ts`，搜索独立在 `search.ts`；不像 Madara 的普通图片，Comici 的 canvas 与打乱图块需要专门的页面／图片模块。

- `network.ts`：读取编号目录页并核对连续范围、数量、唯一性与 canonical，多页目录重读首页检查变化。作品首页可能折叠，不能把其首尾条目当完整目录。目录有 P 个范围时需要 P 次请求，多页额外复查一次首页；顺序读取，不逐章补查，取消时停止发布。裸章节通过 `/api/episodes/<id>` 校验章节／作品身份；正文先检查 `access.hasAccess`，再用 `contentId` 和 viewer ID 请求 `contentsInfo`。先取第 0 页确定总数，必要时再取完整范围，核对总数、连续页序、尺寸及图块配方。站点校验 `/book/<viewer-id>/` 图片归属。
- `search.ts`：只返回名称匹配的 `searchResult.series`，不抓候选目录，排除作者匹配和章节结果。每页数量取自站点配置；跨页排序可能变化，由现有搜索会话按来源与作品 ID 去重，不创建额外搜索缓存。
- `page.ts`：只读取 `#comici-viewer #xCVPages` 中带正文 canvas 的已渲染页槽；不把广告、空页、结束页当正文，不用窗口快照宣称整章完整。延续画布重绘、尺寸、导航、取消与销毁失效检查，不在扫描阶段编码像素。
- `images.ts`：独立实现 4×4 按列排列的图块置换；保持持久化 `comici-v1` 标记及源站透明余边行为。按需解码，不预取全章图片。

## 协议来源与范围

参考本地 Keiyoushi `extensions-source` 的 ComiciViewer 实现及各站公开响应。固定提交、文件 SHA-256、用途、未移植部分及 Apache-2.0 许可记录在 [upstream.json](upstream.json)，许可随插件分发。既有图块算法还依据 HERO'S Web 与 Comic PASH 的 `/js/viewer/viewer.js`，参考脚本 SHA-256：`ba9199d3996e4e8feca4d36bfd82e9d185aa7b2310f7b4f3273290bda68fc06a`。不执行、复制或随包分发源站脚本，也不加载 Android／Kotlin 扩展。

仅支持上述显式站点的 viewer 正文，不承诺上游全站点兼容。未移植 JSON 目录、仅图片的章节内容、排行榜和账户协议；不请求用户信息／JWT，不自动登录、购买、消耗券或领取限免。受限／缺少 viewer 的章节明确失败，不能以存在 viewer ID 推翻源站访问判定。签名图片地址只随运行时来源清单使用，不写入仓库或默认报告。

## 验证

各站 `tests/` 保留独立入口。`tests/adapter-contract.ts` 为站点提供共享协议回归，覆盖身份与资源隔离、完整目录／变更拒绝、JSON 章节归属／访问状态、正文页序、搜索分页、取消与 canvas 按需读取；PASH／HERO'S 回归另外覆盖图块像素、重绘及导航失效。

在仓库根目录执行各站 `tests/verify-http.mjs`，例如：

```powershell
node apps/extension/src/sources/sites/comicpash/tests/verify-http.mjs
node apps/extension/src/sources/sites/championcross/tests/verify-http.mjs
```

`tests/verify-http.mjs` 为公共只读 HTTP 验证器；各站包装器声明域名及两个查询，检查搜索／分页／空结果、完整目录、裸章节归属、正文清单、首图字节及作品封面。报告记录请求数量、响应字节和耗时，产物位于忽略的 `artifacts/<site>/http/`；不记录签名图片地址。

按[公共脚本环境](../../../../../../scripts/README.md)配置 Chromium 与 Playwright、构建插件后，可复用既有的注册表驱动浏览器验收器；该文件虽位于 Madara 测试目录，但只操作产品 UI 与公共来源入口，不解析 Madara 协议：

```powershell
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs comicpash https://comicpash.jp/series/e4be941c462f2 --max-pages=40
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs comicride https://comicride.jp/series/01353b98875b2 --max-pages=40
```

浏览器验收检查真实扩展链接导入、完整目录、按需图片还原／封面、关闭重开后的阅读位置，以及重复导入不产生重复漫画／章节；不替换源站响应。`scripts/verify_comicpash.mjs` 的隔离夹具另外检查像素精确还原、网络失败与重试。HTTP、夹具、真实 MV3 浏览器及真实模型效果是不同验收层次；上述入口均不调用模型，不代替登录内容、原位译图恢复、浏览器撤权或 Firefox 验收。
