# 动漫屋 DM5

专门封面取自 `.banner_detail_form .cover img`，复用 `*.cdndm5.com` 权限；`image.coverHeaders` 使用首页 Referer，正文仍用具体章节 Referer。

支持 HTTPS `www.dm5.com`／`dm5.com` 的 `/manhua-<slug>/` 漫画详情和 `/m<chapter-id>/` 阅读页（包含 `-p<page>` 分页地址）。详情页导入完整漫画；直接从未绑定的阅读页导入时，来源资源是当前章节。仅支持源站公开可读内容；登录、购买、下架和验证页面明确报错，不打开采集标签页兜底。

标签页原位翻译识别 `#cp_img`／`#showimage` 内已加载的 `img#cp_image`，支持正文短切片、懒加载和同一元素换图；排除加载提示、广告、推荐和覆盖图。目录与其他页面不退回通用大图扫描。2026-09-24 已核对真实 `m426475` 正文结构，隔离 MV3 的识别、译图显示、加载失败恢复、原图恢复和位置保持通过；输出来自模拟翻译服务，未调用真实模型。

定向浏览器回归：配置公共 `PLAYWRIGHT_MODULE`／`CHROMIUM_PATH` 后，在仓库根目录设置 `INLINE_SITE_ONLY=dm5`，运行 `node scripts/verify_inline_translation.mjs`；也可不设置筛选运行全部站点。

## 入口与权限

- 扩展“漫画网站”列出动漫屋，支持粘贴详情页链接导入。
- 首次通过插件弹窗“开始阅读”或链接导入申请 DM5 与 `*.cdndm5.com` 可选权限。安装时不增加必需站点权限。
- 授权后公共 `optional-content` 机制注入详情页 `.banner_detail_form .info .bottom`，显示 **NodeLane Comics · 导入/管理漫画**。后续访问自动显示；首次授权前网页没有按钮。
- 目录、章节、补充图片清单、重复导入和更新均使用 HTTP，不新增来源标签页。按钮仅打开插件自己的阅读器。

## 目录、身份与更新

`network.catalog` 读取详情 HTML 的内联数据和完整隐藏目录，核对 `DM5_COMIC_URL`、漫画 ID、每个分类声明的数量、对应列表、重复章节和排序。`DM5_COMIC_SORT` 决定是否反转分类内的显示顺序；保留源站分类和原始标签，每个分类独立连续阅读，不串接分类。

漫画身份是 `dm5:<slug>`，章节身份是 `dm5:chapter:<id>`。DM5 章节路径不包含漫画身份，目录生成的章节链接使用本地 `#nodelane-dm5=<slug>` 片段保存目录绑定，片段不会发送给源站。读取章节时重新核对 HTML 的返回目录链接、章节 ID 和图片路径中的漫画／章节 ID，拒绝伪造绑定；普通章节 URL 与分页 URL 的章节身份相同。

通过 `catalogSync.intervalMinutes = 720` 接入公共后台更新接口，12 小时检查一次，插件启动后补查到期记录。完整读取成功才发布目录；网络失败、下架、数量不符或重复记录保留旧目录，更新提示、幂等、缓存、阅读位置和失败重试沿用公共漫画应用层。适配器不另存已选章节或同步状态。

## 图片协议与公共请求能力

章节 HTML 提供总页数、当前章节和临时访问参数；`chapterfun.ashx` 按请求页返回最多两张图片。以最多四个请求并发收集完整清单，保留页序和重复图片地址的独立页槽。任一请求失败后停止分配新请求，等待已发请求收尾，不发布部分清单。

`protocol.ts` 只解码字符串表、读取字面量并按已观察的地址拼接规则构建图片清单，**不执行返回的 JavaScript**。限制响应大小、编码基数、字典和列表数量，校验 CDN 主机与图片归属。图片仍由公共页面服务获取、解码、标准化和缓存。

章节接口和 CDN 都要求具体章节 Referer；只传首页 Referer 时 CDN 会返回 404。公共网络契约允许同源且属于当前适配器的 Referer；公共图片契约允许根据已授权图片 URL 计算请求头。两者复用 `withImageHeaders` 的精确 URL 规则、Web Lock 和完成／失败／取消清理，不修改全局请求头，不发送 Cookie 或账户令牌。

协议依据 2026-09-23 的源站公开响应独立实现。参考脚本：`https://css99tel.cdndm5.com/v202609180933/dm5/js/chapternew_v22.js`，SHA-256 `b9ed3f03484196585ae6b04f99c0ffdc939c1207e6e59c7306b440822036e9a4`。未分发该脚本，未引入第三方解析／解包依赖。`tests/images.txt` 保留最小协议样本，访问参数已替换为合成值；不要写入真实签名、源站 Cookie 或图片字节。

## 验证

扩展目录执行 `npm run check`、`npm test`、`npm run build`。真实浏览器验收从仓库根目录运行：

```powershell
# 按本机环境指定 Playwright 模块和支持加载解压扩展的 Chromium。
$env:PLAYWRIGHT_MODULE = '<playwright 模块路径>'
$env:TEST_CHROMIUM = '<Chromium 可执行文件路径>'
node apps/extension/src/sources/sites/dm5/tests/verify-browser.mjs
```

2026-09-23，隔离 Chromium MV3、真实 DM5：

- [最喜欢学姐的徒町们](https://www.dm5.com/manhua-zuixihuanxuejiedetudingmen/)：网页嵌入按钮导入，30/30 页在构建版阅读器逐页显示并物化；关掉阅读器后从书架继续，恢复第 10 页。已查看按钮、阅读和重开截图。
- 关闭源站标签页后，通过链接重复导入复用同一本漫画和第 10 页位置，没有新增书架记录。
- 调用公共后台消息触发已到期目录检查，实际服务工作线程完成更新。
- [妖神记](https://www.dm5.com/manhua-yaoshenji/)：完整目录 975 条，连载 958、番外 17；第 1 话 15 页清单成功，末页实际取图并解码为 800×1131，覆盖最后一次只返回一张图片的情况。
- 全程没有额外来源标签页，受管来源标签记录为空，结束后临时请求头规则为 0，插件页面错误为 0。报告和截图在忽略目录 `artifacts/dm5-validation/`。

单元回归覆盖伪造主机／归属、数量遗漏、重复章节、倒序目录、字面量解码、未知协议、重复图片槽、取消、无标签页读取、更新幂等、失败保留旧目录和阅读位置。公共层另测 Referer 归属及动态图片请求头只在授权后解析。

上述浏览器使用预授权隔离 profile，未验收原生权限弹窗、Firefox 实机、登录／付费章节或翻译模型效果；样本通过不代表全站全部内容均已验证。
