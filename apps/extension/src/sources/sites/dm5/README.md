# 动漫屋 DM5

支持 `www.dm5.com` / `dm5.com` 的 `/manhua-<slug>/`、`/m<id>/` 及 `-p<page>` 阅读地址。提供 HTTP 导入、完整目录、12 小时更新、封面和原位翻译。

## 实现约定

- 漫画身份为 `dm5:<slug>`，章节为 `dm5:chapter:<id>`。裸章节从返回目录链接解析作品；本地 `#nodelane-dm5=<slug>` 只用于绑定，读取时重验归属。
- 目录读取详情 HTML 内联数据与完整隐藏目录，核对分类数量、唯一章节和顺序。更新只请求一次详情页，不读取章节或图片。
- `chapterfun.ashx` 按实际批次数量推进；空正文／空数组整章最多额外重试两次、间隔 250 ms。错误归属、HTTP 错误、协议变化和取消不重试，不发布部分清单。
- `protocol.ts` 仅解析字面量与字符串表，不执行 JavaScript。章节接口与 CDN 使用具体章节 Referer；图片目录编号不作为作品归属，地址中的 `cid` 用于章节头。
- 封面取 `.banner_detail_form .cover img` 并使用首页 Referer；原位翻译识别 `#cp_img` / `#showimage` 中的 `img#cp_image`。请求与权限使用公共管线，导入不打开采集标签页。
- 搜索复用公开页面 `/search?title=<关键词>&page=<页码>`，依据源站搜索按钮和 [search.js](https://css99tel.cdndm5.com/v202609180933/dm5/js/search.js)。关键词沿用源站的 `encodeURIComponent`，空格使用 `%20`、字面加号使用 `%2B`，翻页时同样编码。读取专门主结果和 `.mh-list`，校验查询回显、作品地址及分页；游标只保留页码。该引擎会对无匹配词返回近似作品，因此结果始终是候选，不能认定同一漫画。不发送语言筛选；兼容源站默认分页链接中的 `language=1`。结果未提供语言时不声明语言。
- 查找种子只取详情页的 `DM5_COMIC_MNAME` 与 `DM5_COMIC_URL`；章节页仅有包含话名的标题时留给用户填写，不截取章节标题。

协议参考 [chapternew_v22.js](https://css99tel.cdndm5.com/v202609180933/dm5/js/chapternew_v22.js)，SHA-256 `b9ed3f03484196585ae6b04f99c0ffdc939c1207e6e59c7306b440822036e9a4`。`tests/images.txt` 为合成访问参数样本；公共规则见[适配规范](../../../../../../docs/SITE_ADAPTERS.md)。

## 验证

构建并配置[浏览器环境](../../../../../../scripts/README.md#来源与阅读验收)，从仓库根目录运行：

```powershell
node apps/extension/src/sources/sites/dm5/tests/verify-browser.mjs
node scripts/verify_chapter_imports.mjs
node apps/extension/src/sources/sites/dm5/tests/verify-search-http.mjs
```

前两个浏览器入口访问真实公开源站。可设 `DM5_CATALOG_URL`；`DM5_EMPTY_FIRST_RESPONSE=1` 仅模拟首批空响应，随后继续真实读取。原位回归设置 `INLINE_SITE_ONLY=dm5` 后运行 `verify_inline_translation.mjs`，使用模拟译图。浏览器脚本使用隔离配置，安装权限、撤权恢复与受限内容另验。

`search.test.ts` 使用合成 HTML 覆盖归属、分页、编码、取消与作品种子；搜索 HTTP 探针验证实时前两页和源站近似搜索行为，报告写入忽略的 `artifacts/dm5/search-http/`。它不验证浏览器安装权限与撤权恢复、搜索 UI、导入或名称模型。
