# WeLoMa

- 支持 `https://weloma.net/m/<作品短码>` 和 `/c/<章节短码>`；短码区分大小写。章节从源站面包屑解析所属作品，目录条目用 `#nodelane-weloma=<作品短码>` 绑定身份，片段不发送给服务器；读取正文时重新核对作品和章节。
- 名称搜索、分页、专门封面、完整静态章节目录、正文与 12 小时目录同步均走普通 HTTP；作品／章节页使用公共浮动导入入口。不支持未核验的旧式长链接或镜像域名。
- 目录按源站最新在前列表反转，不按章节标题猜顺序，保留小数话。搜索分页采用源站不透明 `/l/` 路由并保留 `name` 查询词，不为候选抓完整目录。
- 正文只读取完整 `#chapter-images` 中的 `img.chapter-img`，将 `data-img` 从 Base64 解码为普通图片 URL；保留重复 URL 的不同页槽，排除广告脚本与推荐图。标题读取 UTF-8 `data-enc`。无 canonical 的页面通过源站登录返回 URL 字面量核对响应身份，只解析文本，不执行脚本或登录操作。
- 标签页识图声明 `inlineRecognition: 'generic'`，沿用通用已加载大图、懒加载观察和导航失效处理；`page.ts` 仅为“寻找其他语言”读取当前作品标题或经过作品／章节归属校验的面包屑，不扫描目录或额外请求网络。目录、搜索与原位识图相互独立；HTTP 失败不切换到页面读取。图片和封面沿用公共 HTTP／Referer，不增加专用取图规则。
- 网站以免费日语原文漫画为主；搜索／目录没有明确单部语言字段，不推断条目语言。图标为本地字母 W 简图，无第三方库或源站脚本依赖。协议依据源站公开 HTML 和 `app/manga/themes/dark/assets/js/seo-decoder-v2.js` 的属性格式，不执行或打包该脚本。

## 验证

在 `apps/extension` 执行 `npm test -- src/sources/sites/weloma/tests`，覆盖来源／归属、作品名称、完整性、编码、顺序、分页、取消及失败保留。公共检查为 `npm run check`、`npm test`、`npm run build`。

仓库根目录执行：

```powershell
node apps/extension/src/sources/sites/weloma/tests/verify-http.mjs
node apps/extension/src/sources/sites/weloma/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY = 'weloma'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY
```

浏览器命令沿用[脚本环境](../../../../../../scripts/README.md)的 `PLAYWRIGHT_MODULE`、`TEST_CHROMIUM`／`CHROMIUM_PATH`，先构建扩展；`verify-browser.mjs` 可通过 `TEST_EXTENSION_DIR` 指定产物、`WELOMA_READER_URL` 指定不超过 100 页的公开章节。HTTP 检查真实目录首尾话、搜索两页／空结果及封面／原图字节；浏览器检查隔离 MV3 的真实搜索、章节浮动导入、全章逐页解码、重开恢复、重复导入／更新及模拟目录失败保留。原位验证使用自制图片与模拟翻译，不代表真实模型效果。截图和结果写入忽略的 `artifacts/`，不改用户书库或账号。
