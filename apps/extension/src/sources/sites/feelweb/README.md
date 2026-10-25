# FEEL web

支持 [FEEL web](https://feelweb.jp/) 的日语生肉名称搜索、完整分话目录、封面、公开正文、12 小时目录同步与网页浮动导入。来源 ID 为 `feelweb`；目录、搜索、图片还原和原位页面识别均复用 [GigaViewer 共享引擎](../../shared/gigaviewer/README.md)，本站仅声明身份与资源范围。

## 站点协议

- 作品：`https://feelweb.jp/series/<ID>/first_episode`；章节：`https://feelweb.jp/episode/<ID>`。裸章节核实作品归属，目录中的章节使用 `#nodelane-feelweb=<作品ID>` 绑定。
- 搜索：`/search?q=<名称>`，校验旧版 `common:search_result` HTML；不请求候选目录，不执行站点脚本。
- 正文与封面仅接受 `https://cdn-img.feelweb.jp` 的 `public/page`、`public/series-thumbnail`；允许共享引擎已校验的缩图包装，不扩大 CDN 范围。
- 协议依据为本站公开搜索、目录 API 与 `episode-json`，不引入第三方代码或依赖。公共协议参考的版本、摘要、许可见 [upstream.json](../../shared/gigaviewer/upstream.json)；随包字母图标由本项目绘制。

## 收费与可读范围

标为日漫、生肉、免费（`free`），无需登录读取公开章。[祥伝社的服务说明](https://news.shodensha.co.jp/article/481881388.html)明确本站为免费 Web 漫画站，原「マンガJam」iOS 服务已结束并将连载转入本站。结合[当前连载入口](https://feelweb.jp/)及匿名章节读取核实，不把出版社外链销售的单行本当成本站付费解锁。

匿名目录与正文抽样交叉检查：开放章标记为 `is_free=true`，结束公开的条目为 `unavailable=true`，未发现购买、点数／券租借或订阅解锁入口。此分类限本站公开阅读服务，不保证全历史章节持续开放或本站永久免费；纸书／外部电子书销售不等同于本站正文收费。不可读条目保留在目录中并拒绝取图，不购买、领券或自动解锁。

## 验证

在仓库根运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/feelweb src/sources/shared/gigaviewer
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-http.mjs feelweb
npm --prefix apps/extension run build
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-browser.mjs feelweb
```

固定[公开样本](https://feelweb.jp/episode/4856001361355260751)；[限时公开样本](https://feelweb.jp/episode/2551460909600883752)采用 `public/page/filtered/2/`，可用共享脚本的样本替换参数验证；样本到期后须选择源站当前开放的章节，不固化倒计时或可读状态。检查范围、隔离浏览器配置与输出见[共享验证入口](../../shared/gigaviewer/README.md#验证)。HTTP 同时统计目录收费能力，发现与免费分类冲突即失败；验证不使用真实账号、翻译模型，也不证明全站作品均可读。
