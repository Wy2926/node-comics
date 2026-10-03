# Comic DAYS

支持 `https://comic-days.com/episode/<数字 ID>` 的已加载正文原位翻译。站点显式认领，正文解析、页槽绑定及 `baku` 图片还原复用 [GigaViewer 引擎](../../shared/gigaviewer/README.md)。只接受本站章节身份与 `https://cdn-img.comic-days.com/public/page/...` 图片；其他来源、未知格式或元数据错配不回退为通用大图识别。

仅处理当前会话实际提供的正文，不解锁内容、不读取未提供的付费页、不主动翻页或采集整章；不提供漫画导入、目录、搜索、封面和自动同步。`baku` 的跨域污染展示画布通过已映射的 HTTP 原图还原送译，原画布及页面事件保持不变；未混淆／`usagi` 沿用引擎的文档绑定读取。

协议核对入口：[公开章节](https://comic-days.com/episode/12207421984001216436)。网站域名和身份归属保留在本站目录，后续同引擎站点不应复制本目录或 Sunday Webry 的还原算法。

## 验证

在仓库根目录运行；浏览器环境变量见[公共脚本入口](../../../../../../scripts/README.md#来源与阅读验收)：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
$env:INLINE_SITE_ONLY = 'comicdays'
node scripts/verify_inline_translation.mjs
$env:RUN_LIVE_COMICDAYS = '1'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY, Env:RUN_LIVE_COMICDAYS
```

单测检查主机、章节／CDN 归属、能力、重复页及生命周期；隔离浏览器夹具检查污染画布、逐页读取失败、懒加载、无损还原、恢复和 SPA 失效。真实开关额外核对公开章节的原图／还原图像素、翻页后双页译图和恢复位置。所有翻译响应来自本地模拟服务，不调用真实账号或模型。截图和结果写入忽略的 `artifacts/inline-validation/`。
