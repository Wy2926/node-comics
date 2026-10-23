# 少年ジャンプ＋

支持 [少年ジャンプ＋](https://shonenjumpplus.com/) 的日语漫画名称搜索、完整分话目录、作品封面、公开正文读取、12 小时更新与网页浮动导入。独立来源身份为 `shonenjumpplus`；正文还原与当前标签页已加载 canvas 识别复用 [GigaViewer 引擎](../../shared/gigaviewer/README.md)。

## 支持范围

- 作品入口：`https://shonenjumpplus.com/series/<ID>/first_episode`；章节入口：`https://shonenjumpplus.com/episode/<ID>`。裸章节从元数据核实所属作品，目录链接用 `#nodelane-shonenjumpplus=<作品ID>` 保留绑定。
- 目录严格核对分页数量、重复章节与作品归属，保留源站锁定条目；只读取分话连载，不含单行本／杂志。不自动购买、租借、消耗点数或阅读券。
- 名称搜索：`/search?q=<名称>`，只获取候选与专用封面，不读取候选目录。源站混合结果中的单行本／杂志不在分话搜索范围内。
- 仅接受本站 `https://cdn-ak-img.shonenjumpplus.com/public/page/...` 正文及 `public/series-thumbnail/...` 作品封面，拒绝其他站点资源。按源站顺序保留重复图片页槽；不执行源站脚本。
- 协议流程、搜索翻页开销、上游精确版本／SHA-256／许可和未支持变体以共享引擎文档及 [upstream.json](../../shared/gigaviewer/upstream.json) 为准。

## 网站标签依据

标为日漫、生肉、部分收费、部分阅读需登录。依据[官方帮助](https://shonenjumpplus.com/article/help)：免费章节可不登录阅读，租借或购买需要账号。源站日语原创连载与正文支持生肉分类；不保证每部作品所有章节免费，不把登录或付费限制当作解析失败绕过。

## 验证

仓库根目录运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/shonenjumpplus src/sources/shared/gigaviewer
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-http.mjs shonenjumpplus
npm --prefix apps/extension run build
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-browser.mjs shonenjumpplus
```

浏览器使用隔离 MV3 profile，环境与范围见[共享验证入口](../../shared/gigaviewer/README.md#验证)。真实站点检查包含搜索、封面、网页导入、正文像素还原、翻页、重开恢复及重复导入；HTTP 失败保留目录与位置使用受控故障注入。产物写入忽略目录，不调用翻译模型、不证明付费账号和所有作品可读。原位接入使用共享引擎的生命周期测试；本站原位译图效果仍需独立验证。
