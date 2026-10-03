# Manga One（マンガワン）

支持 `https://manga-one.com/manga/<作品 ID>/chapter/<章节 ID>` 的已加载正文原位翻译。精确认领主机和章节路径，只选择阅读器占位容器内带 `_page` CSS 模块类的同源 Blob 图片；正文容器外的推荐、封面、广告、未加载图片和其他页面不参与。翻页、懒加载、元素复用与 SPA 导航沿用公共观察和失效机制；不依赖会被网页翻译修改的 `alt` 文本。

源站阅读器将当前访问允许的图片解码成 `blob:https://manga-one.com/...` 后展示，并在 `onload` 中撤销 Blob URL，因此地址不能再次下载，但 `<img>` 仍保留已解码像素。本适配不复制下载／解码协议、不获取密钥，也不请求付费、未提供或尚未加载的页面。取图复用公共 Blob 读取及分块传输，译图显示不改变原图 `src`、站点事件或布局，关闭后恢复原图。

同源 Blob 的读取集中在 `shared/blob-image.ts`：优先保留可读取的原字节；读取失败且元素仍绑定同一图片时，从原图按自然尺寸导出 PNG，读取前后校验元素、URL、尺寸、导航与取消状态。仅在实际取图时创建画布，完成后释放，不轮询／缓存完整像素；HTTP 图片及跨域污染不走此回退。本站仅增加正文范围及逻辑页身份；未知同类网站也复用该处理。Blob 不作为持久原图地址，且当前窗口不能证明整章完整，因此不提供漫画导入、目录、搜索、整章离线保存或自动同步。

协议核对入口：[公开章节](https://manga-one.com/manga/659/chapter/359725)。选择器采用已观察到的阅读器结构与 CSS 模块名称后缀，不依赖构建哈希。若源站不再提供此结构或 Blob，则不退回推荐图或 HTTP 密文。

## 验证

在 `apps/extension` 执行：

```powershell
npm run check
npx vitest run src/sources/sites/mangaone/tests/page.test.ts src/sources/shared/blob-image.test.ts src/sources/generic/tests/page.test.ts
npm run build
```

原位浏览器回归复用[公共验收脚本](../../../../../../scripts/README.md#来源与阅读验收)，从仓库根目录运行：

```powershell
$env:INLINE_SITE_ONLY = 'mangaone'
node scripts/verify_inline_translation.mjs
$env:RUN_LIVE_MANGAONE = '1'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY, Env:RUN_LIVE_MANGAONE
```

隔离夹具覆盖已撤销／无 MIME 的同源 Blob、重复图片独立元素、懒加载、元素换图、失败隔离、正文过滤、恢复和 SPA 失效。真实开关额外读取公开章节，核对原图像素、首屏、翻页及恢复位置；不登录、不购买、不调用真实翻译模型。结果和截图写入忽略的 `artifacts/inline-validation/`，不能用模拟译图证明模型质量。
