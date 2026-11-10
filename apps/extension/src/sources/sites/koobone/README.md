# KOOBONE 标签页翻译

入口：[KOOBONE 桌面阅读器](https://koobone.com/web.htm)。适配器 ID 为 `koobone`，由公共注册表自动收集。

## 支持范围

- 登录并在源站打开已有漫画后，使用插件的「翻译当前页面」或标签页自动翻译规则。支持单页、双页及连续滚动模式；保留源站翻页、缩放、原图属性和阅读位置。
- 只认领 `https://koobone.com/web.htm`，读取其同源 `iframe_page → /wpage.htm`、`iframe_line → /wline.htm` 正文。书架封面、顶层预加载图片、隐藏阅读模式、跨域框架和未加载图片不参与翻译。
- 读取源站已经解包的同源 Blob；失效 Blob URL 沿用公共原图导出。只翻译阅读框架内可见图片，不为预翻主动翻页、解包或请求完整 EPUB。
- 图片换源、模式切换、框架替换／导航、取消和会话销毁后拒绝旧读取。源站重载 iframe 若触发浏览器的标签页加载状态，沿用公共导航授权保护，需要重新选择「翻译当前页面」；普通翻页和滚动自动更新。
- 本适配器仅提供标签页翻译，不声明漫画链接导入、目录同步、名称搜索或完整页清单，因此不进入可导入网站目录。`kxo.moe` 下载及推送流程不在此能力范围。

## 协议与性能

依据源站 [桌面阅读页](https://koobone.com/web.htm)、[翻页框架](https://koobone.com/wpage.htm) 和 [滚动框架](https://koobone.com/wline.htm) 的 DOM 独立实现，未移植第三方适配器或执行下载的站点脚本。源站需要登录且书库中已有可读文档；适配器不读取 Cookie、账号数据或下载地址。

只观察两个已验证框架的图片变化、滚动和尺寸变化，框架替换后清理旧观察器；没有额外网络请求、轮询或原图像素缓存。正文发现只枚举 DOM 与地址，取图／编码在实际翻译时执行。公共显示层换算同源框架坐标并按框架视口裁剪，维持既有执行并发和可见窗口；通用网页识别仍不扫描任意 iframe。

## 验证

在 `apps/extension` 执行：

```sh
npx vitest run src/sources/sites/koobone tests/inline-frame-geometry.test.ts src/sources/shared/blob-image.test.ts
npm run check
npm run build
```

从仓库根目录执行隔离 MV3 回归，浏览器与 Playwright 路径配置见[脚本入口](../../../../../../scripts/README.md#来源与阅读验收)：

```sh
INLINE_SITE_ONLY=koobone node scripts/verify_inline_translation.mjs
```

该回归使用自制图片与模拟翻译 API，覆盖 Blob 撤销后的取图、同元素翻页、双页、滚动、隐藏模式、远处图片排除、尺寸与位置保持、框架重载和重新启动，截图写入忽略的 `artifacts/`。真实站点另在登录后的桌面阅读器检查正文识别、Blob 读取和原位恢复；模拟译图显示不代表真实模型效果，隔离 Chromium 也不替代 Firefox／Safari 扩展验收。
