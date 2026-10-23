# コミックガルド

支持 [コミックガルド](https://comic-gardo.com/) 的日语生肉名称搜索、完整分话目录、作品封面、公开正文读取、12 小时更新与网页浮动导入。来源身份为 `comicgardo`；正文还原与当前标签页已加载 canvas 识别复用 [GigaViewer 引擎](../../shared/gigaviewer/README.md)。

## 支持范围

- 作品入口：`https://comic-gardo.com/series/<ID>/first_episode`；章节入口：`https://comic-gardo.com/episode/<ID>`。裸章节从元数据核实作品归属，目录链接以 `#nodelane-comicgardo=<作品ID>` 保留绑定。
- 目录校验分页数量、唯一章节和作品归属，保留源站不可读条目。不自动购买、租借或消耗阅读券／点数；不包含单行本、杂志及全站枚举。
- 名称搜索：`/search?q=<名称>`，只读取候选与专用封面，不读取候选目录。GigaViewer 新版 SSR 搜索；核对 `data-media-name=gardo`、查询回显及搜索组件，不读取或执行 Next.js hydration 脚本。混合结果中的本站单行本／杂志商品不作为分话作品返回。
- 仅接受本站 `https://cdn-img.comic-gardo.com/public/page/...` 正文及 `public/series-thumbnail/...` 封面，拒绝其他站点资源；保留重复图片的独立页槽与源站顺序，不执行源站脚本。
- 搜索翻页开销、协议边界及上游版本／SHA-256／许可见共享引擎文档及 [upstream.json](../../shared/gigaviewer/upstream.json)。图标为项目自制标识，不打包源站品牌图片。

## 网站标签依据

标为日漫、生肉、部分收费、部分阅读需登录。依据[官方帮助](https://plus.over-lap.co.jp/Page/gardo_help/)及公开日语原创连载：免费话无需登录，付费话需账号及点数；这些标签不表示所有作品或章节免费可读。未验证登录购买态，不绕过访问限制。

## 验证

公开样本：[とんでもスキルで異世界放浪メシ　スイの大冒険](https://comic-gardo.com/episode/3269754496561202479)。从仓库根运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/comicgardo src/sources/shared/gigaviewer
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-http.mjs comicgardo
npm --prefix apps/extension run build
node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-browser.mjs comicgardo
```

隔离 MV3 检查网站列表、搜索、封面、浮动导入、首图独立像素还原、翻页、重开恢复、重复导入及无源站标签页的 HTTP 同步；受控 HTTP 503 检查旧目录与进度保留。环境和忽略产物位置见[共享验证入口](../../shared/gigaviewer/README.md#验证)。不调用翻译模型、不证明所有作品或付费账号可读；原位接入复用共享生命周期测试，本站原位译图效果仍需独立验证。
