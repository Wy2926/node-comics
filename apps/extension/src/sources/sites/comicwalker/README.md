# ComicWalker / カドコミ

支持 [comic-walker.com](https://comic-walker.com/) 名称搜索、作品封面、公开目录、章节导入、HTTP 原图读取、12 小时目录同步、网页浮动导入入口和原位翻译。

## URL 与数据边界

- 作品：`/detail/KC_<编号>_S`，兼容其 `/episodes` 目录入口；章节：`/detail/<作品>/episodes/KC_<编号>_E`。旧 `/viewer/<章节>` 在网站上重定向；适配器用章节编号前缀查候选作品，再严格核验其完整目录包含该章节，避免公共 HTTP 通道跟随重定向或根据标题猜测归属。
- 名称搜索使用网站 `/api/search/keywords`，每次 32 条，只读候选，不抓每个结果的目录。
- 目录读取页面 `__NEXT_DATA__` 中当前作品的 `firstEpisodes` 和 `comics`，分别核对 `total`；保持源站序号、连载与各单行本试读分组，不把不同分组串成一条连读序列。`isActive: false`、非网页服务的条目保留为不可读，不推断其可以解锁。目录更新沿用公共层，只使用调用方提供的旧快照。
- 正文先核对章节编号、公开状态与内部 UUID，再请求 `/api/contents/viewer?episodeId=...&imageSizeType=width%3A1284`。`manuscripts` 的页码、数量、尺寸、作品资源路径和 `drmMode` 必须有效；未知格式直接失败。只读取源站当前公开返回的内容，不登录、不购买、不绕过访问限制。
- 图片仅接受本站 CDN `/images/<作品编号>/.../*.webp`，按公开阅读器使用的 8 字节循环 XOR 还原原始 WebP；不重新编码或改变尺寸。源站协议字段名为 `drmHash`，该值随源站已授权的正文清单返回。持久页身份使用章节和页码，内容键使用资源路径与还原参数，临时签名更新不更换页槽；签名失效后沿用公共清单刷新与单次重试。
- 封面只用作品 `originalThumbnail`，不使用章节缩略图。随包图标为本项目绘制的文字图形，不下载或复制第三方图标代码。

协议依据是源站公开作品页、`__NEXT_DATA__` 和阅读器请求；不执行下载的站点脚本，不保存凭据或将签名地址写入测试报告。公开样本：[Dolls Nest:ORPHANS](https://comic-walker.com/detail/KC_008597_S)、[第 1 话](https://comic-walker.com/detail/KC_008597_S/episodes/KC_0085970000200011_E)。

## 标签页预翻

源站以 canvas 显示正文，横向、双页、竖向模式均保留正文 DOM 页序。桌面首张画布可在自身声明 `data-type="contents"`，其他页在父容器声明；只识别这些正文画布，广告、推荐和占位不参与。原位识别不要求整章 canvas 数量与目录页数相等，不据此声明章节完整。

当前地址与实时 canonical URL 共同绑定作品与章节；从首页进入、跨作品及同作品 SPA 切章时，原位识别都不依赖保留旧内容的 `__NEXT_DATA__`，无需刷新源站页面或额外抓目录。作品名查询仍只使用能核实归属的元数据，缺失时不猜测标题。导航、文档关闭、元素替换、重绘和实时 canonical 失效均拒绝旧读取。

复用 `shared/stable-canvases.ts` 的 32×32 稳定像素检测：前台每 500 ms 采样，至少稳定 250 ms；只取当前页起五个页槽，较多可见切片最多检查八张，不因已完成而不断向后扩张。原位执行仍受公共四／五张阅读窗口和两路原图传输限制。预翻限于网站已绘制的附近页；尚未绘制、纯色、跨域污染画布不送译，不主动翻页或滚动加载整章。通用识别继续仅处理视口内四张，不扩大未知网站的扫描范围。

## 验证

在仓库根目录执行；浏览器模块和 Chromium 路径使用[公共脚本环境](../../../../../../scripts/README.md#来源与阅读验收)。

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
$env:RUN_LIVE_COMICWALKER = '1'
npm --prefix apps/extension test -- --run src/sources/sites/comicwalker/tests/live.test.ts --silent=false
node apps/extension/src/sources/sites/comicwalker/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY = 'comicwalker'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY
Remove-Item Env:RUN_LIVE_COMICWALKER
```

单测覆盖伪造主机、作品归属、目录重复／缺失、失效签名的稳定身份、页序、XOR 字节还原、取消、首页／跨作品旧元数据、部分正文槽、有限屏外采样、空白／污染／重绘、隐藏页和旧句柄失效。真实 HTTP 检查搜索、目录、页清单和首张图片；隔离 MV3 阅读器检查导入、原图解码、翻页、关闭重开恢复、重复目录刷新和模拟 HTTP 失败保留进度。

原位浏览器脚本先用自制图片验证预翻边界、恢复原图及失效，再从真实首页点击进入公开章节，验证旧首页数据下的识别；同时检查直达章节的屏外译图、下一双页、竖向模式与 SPA 切章。翻译服务始终是本机模拟 API，不验证真实模型质量或消费官方额度；也不代表浏览器商店安装授权或撤权恢复验收。结果与截图写入忽略的 `artifacts/comicwalker/` 和 `artifacts/inline-validation/`。
