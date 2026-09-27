# WEBTOON 国际站

独立适配 `https://www.webtoons.com/`，与 `comic.naver.com` 的 NAVER 适配器分开。

- 英语、繁体中文、泰语、印尼语、西班牙语、法语、德语的 Originals 与 Canvas：名称搜索、搜索分页、作品与章节链接导入、完整公开分页目录、作品封面、HTTP 正文图片和 12 小时目录同步。
- URL：`/<语言>/<分类>/<作品>/list?title_no=…` 与 `/<语言>/<分类>/<作品>/<话名>/viewer?title_no=…&episode_no=…`。语言路径为 `en / zh-hant / th / id / es / fr / de`，Canvas 分类为 `canvas`。
- 七个语言入口可独立选择搜索；每个入口依次搜索 Originals 和 Canvas。结果保留源站作品名、作者与封面。作品身份包含语言、Originals／Canvas 和 `title_no`，章节身份使用 `episode_no`。源站没有可靠跨语言话数对应关系，因此不同语言作品不合并、不猜测同话关联。
- 作品页及阅读页嵌入导入／管理入口；原位翻译仅识别阅读正文中实际加载的图片，排除占位图、广告与推荐图，支持懒加载和恢复原图。完整正文获取使用 HTTP，无需打开源站标签页。

协议依据源站公开 HTML：`og:url` 校验归属，`#_listUl` 和 `.paginate` 枚举目录，`#_imageList img._images[data-url]` 为有界完整正文，搜索使用 `/<语言>/search/originals`、`search/canvas`。正文与封面来自 `webtoon-phinf.pstatic.net`、`swebtoon-phinf.pstatic.net`，Referer 由公共取图链路处理。不会执行源站脚本或读取、上传源站令牌。

只支持网页实际提供的内容。登录、年龄、地区、付费、Daily Pass／Fast Pass 和 App 专属内容仍受源站限制；缺少完整正文时明确失败。公开目录不包含仅在 App 中列出的章节，不将其宣称为已获取。分页重复、跳页、错误归属或读取中更新均拒绝替换已有目录。

## 验证

在 `apps/extension` 执行 `npm run check`、`npm test`、`npm run build`。站点单测：

```powershell
npx vitest run src/sources/sites/webtoons/tests/network.test.ts
```

以下从仓库根目录运行；浏览器环境变量见[脚本入口](../../../../../../scripts/README.md)。产物写入忽略的 `artifacts/`。

```powershell
node apps/extension/src/sources/sites/webtoons/tests/verify-http.mjs
node apps/extension/src/sources/sites/webtoons/tests/verify-browser.mjs
$env:RUN_LIVE_WEBTOONS = '1'
node apps/extension/src/sources/sites/webtoons/tests/verify-browser.mjs
Remove-Item Env:RUN_LIVE_WEBTOONS
$env:INLINE_SITE_ONLY = 'webtoons'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY
```

`verify-http` 需要 curl，访问七语言真实搜索、Originals／Canvas 完整目录、首话与封面；不使用账号。`verify-browser` 默认使用隔离 HTML／图片夹具验证搜索、导入、阅读、位置恢复、重复导入、更新与失败保留，live 模式默认搜索 Not So Silent，可用 `WEBTOONS_TITLE` 指定其他作品的准确名称（如 Trapped Together）。原位测试使用合成图片和模拟翻译服务，覆盖译图恢复、懒加载及图片失效，不代表真实模型效果。浏览器使用隔离 MV3 profile，不修改用户数据。
