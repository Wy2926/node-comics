# 动漫屋 DM5

支持 `www.dm5.com` / `dm5.com` 的 `/manhua-<slug>/`、`/m<id>/` 及 `-p<page>` 阅读地址。提供 HTTP 导入、完整目录、12 小时更新、封面和原位翻译。

## 实现约定

- 漫画身份为 `dm5:<slug>`，章节为 `dm5:chapter:<id>`。裸章节从返回目录链接解析作品；本地 `#nodelane-dm5=<slug>` 只用于绑定，读取时重验归属。
- 目录读取详情 HTML 内联数据与完整隐藏目录，核对分类数量、唯一章节和顺序。更新只请求一次详情页，不读取章节或图片。
- `chapterfun.ashx` 按实际批次数量推进；空正文／空数组整章最多额外重试两次、间隔 250 ms。错误归属、HTTP 错误、协议变化和取消不重试，不发布部分清单。
- `protocol.ts` 仅解析字面量与字符串表，不执行 JavaScript。章节接口与 CDN 使用具体章节 Referer；图片目录编号不作为作品归属，地址中的 `cid` 用于章节头。
- 封面取 `.banner_detail_form .cover img` 并使用首页 Referer；原位翻译识别 `#cp_img` / `#showimage` 中的 `img#cp_image`。请求与权限使用公共管线，导入不打开采集标签页。

协议参考 [chapternew_v22.js](https://css99tel.cdndm5.com/v202609180933/dm5/js/chapternew_v22.js)，SHA-256 `b9ed3f03484196585ae6b04f99c0ffdc939c1207e6e59c7306b440822036e9a4`。`tests/images.txt` 为合成访问参数样本；公共规则见[适配规范](../../../../../../docs/SITE_ADAPTERS.md)。

## 验证

构建并配置[浏览器环境](../../../../../../scripts/README.md#来源与阅读验收)，从仓库根目录运行：

```powershell
node apps/extension/src/sources/sites/dm5/tests/verify-browser.mjs
node scripts/verify_chapter_imports.mjs
```

两者访问真实公开源站。可设 `DM5_CATALOG_URL`；`DM5_EMPTY_FIRST_RESPONSE=1` 仅模拟首批空响应，随后继续真实读取。原位回归设置 `INLINE_SITE_ONLY=dm5` 后运行 `verify_inline_translation.mjs`，使用模拟译图。浏览器脚本预授权，原生权限与受限内容另验。
