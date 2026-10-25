# マグコミ

支持 [マグコミ](https://magcomi.com/) 的日语漫画名称搜索、完整分话目录、作品封面、公开正文读取、12 小时更新与网页浮动导入。来源身份为 `magcomi`；图片还原和当前标签页已加载正文识别复用 [GigaViewer 引擎](../../shared/gigaviewer/README.md)。

## 支持范围

- 作品：`https://magcomi.com/series/<ID>/first_episode`；章节：`https://magcomi.com/episode/<ID>`。裸章节从正文元数据核实作品归属，目录中的章节使用 `#nodelane-magcomi=<作品ID>` 保留绑定。
- 分话目录严格核对分页数量、重复章节及作品归属，保留不可读条目；不导入单行本／杂志，不自动购买、租借、消耗点数或阅读券。
- 名称搜索为 `/search?q=<名称>`，只读取候选与专用封面，不请求候选目录。采用源站 `magcomi` 媒体身份的 SSR 搜索 HTML，仅解析可见结果，不执行 hydration 脚本；源站混合结果中的单行本／杂志不进入分话搜索结果。
- 图片只接受 `https://cdn-img.magcomi.com/public/page/...` 正文与 `public/series-thumbnail/...` 专用封面；保留源站页槽与重复图片顺序，未知协议明确失败。
- 接入依据为本站公开搜索、目录 API 和 `episode-json`；复用项目已有 TypeScript 实现，不移植新的第三方代码。共享协议来源、精确版本、摘要和许可见 [upstream.json](../../shared/gigaviewer/upstream.json)。随包字母图标由本项目绘制。

## 网站标签依据

标为日漫、生肉、部分收费、部分阅读需登录。[官方帮助](https://magcomi.com/article/help)说明付费高级会员可提前阅读部分最新话，另有付费点数及电子书购买。适配器仅读取当前公开正文，目录中的不可读条目保留但不解锁、不购买、不领取阅读奖励。日语原创连载与正文支持生肉分类，不保证每部作品所有章节免费。

## 验证

仓库根目录运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/magcomi src/sources/shared/gigaviewer
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-http.mjs magcomi
npm --prefix apps/extension run build
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-browser.mjs magcomi
```

固定公开样本：[章节](https://magcomi.com/episode/12207421984406812438)。浏览器使用隔离 MV3 profile，路径配置、检查范围与输出目录见[共享验证入口](../../shared/gigaviewer/README.md#验证)。检查搜索、封面、网页导入、正文像素还原、翻页、重开恢复及重复导入；HTTP 503 保留目录与位置使用故障注入。测试不调用真实账号、付费渠道或翻译模型，也不证明所有作品可读或本站原位译图效果。
