# COMIC OGYAAA!!

支持 [COMIC OGYAAA!!](https://comic-ogyaaa.com/) 的日语生肉名称搜索、完整分话目录、封面、公开正文、12 小时目录同步与网页浮动导入。来源 ID 为 `comicogyaaa`；目录、搜索、图片还原和原位页面识别均复用 [GigaViewer 共享引擎](../../shared/gigaviewer/README.md)，本站仅声明身份与资源范围。

## 站点协议

- 作品：`https://comic-ogyaaa.com/series/<ID>/first_episode`；章节：`https://comic-ogyaaa.com/episode/<ID>`。裸章节核实作品归属，目录中的章节使用 `#nodelane-comicogyaaa=<作品ID>` 绑定。
- 搜索：`/search?q=<名称>`，校验旧版 `common:search_result` HTML；不请求候选目录，不执行站点脚本。
- 正文与封面仅接受 `https://cdn-img.comic-ogyaaa.com` 的 `public/page`、`public/series-thumbnail`；允许共享引擎已校验的缩图包装，不扩大 CDN 范围。
- 协议依据为本站公开搜索、目录 API 与 `episode-json`，不引入第三方代码或依赖。公共协议参考的版本、摘要、许可见 [upstream.json](../../shared/gigaviewer/upstream.json)；随包字母图标由本项目绘制。

## 收费与可读范围

标为日漫、生肉、部分收费（`freemium`），公开章无需登录。按用户确认修正站点收费类型；[源站免费开放公告](https://comic-ogyaaa.com/article/entry/0522)说明部分历史话只在指定期间开放。历史免费运营说明及个别免费作品的抽样均不足以证明全站免费。

匿名目录与正文交叉检查：开放章按 `purchase_info.can_read` 判断，实际取图还需当前章节返回 `pageStructure`；限时开放与常驻公开章共用读取逻辑。结束公开的条目保留在目录中，不把 `unavailable` 自动等同于可购买。仅验证公开阅读，未验证付费或租借后的账号状态，不购买、领券或自动解锁。

## 验证

在仓库根运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/comicogyaaa src/sources/shared/gigaviewer
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-http.mjs comicogyaaa
npm --prefix apps/extension run build
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-browser.mjs comicogyaaa
```

固定[公开样本](https://comic-ogyaaa.com/episode/2551460910063242542)；检查范围、隔离浏览器配置与输出见[共享验证入口](../../shared/gigaviewer/README.md#验证)。HTTP 同时统计样本目录的收费能力；验证不使用真实账号、翻译模型，也不证明全站作品均可读或均免费。
