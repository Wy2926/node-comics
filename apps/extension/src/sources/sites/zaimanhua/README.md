# 再漫画

## 支持范围

- 原创站 `www.zaimanhua.com/info/<slug>.html`、首页宣传位的 `/details/<title>/<slug>.html`；日漫站 `manhua.zaimanhua.com/details/<id>`。
- 两站 `/view/<slug>/<comicId>/<chapterId>` 章节链接，HTTP(S) 同一身份；查询与页码片段不参与作品／章节身份。
- 名称搜索、专用封面、网页完整分组目录、正文图片、网页浮动导入入口、12 小时目录更新。原创与日漫是独立入口；搜索沿源站首页规则可返回两站作品，不按展示语言过滤。
- 标签页原位翻译复用 `inlineRecognition: 'generic'`，支持已加载大图及源站翻页／滚动模式，不扫描完整章节、不新增 `page.ts` 或解码逻辑。
- 不支持 App 专属、已下架或收费正文，不自动购买、解锁或提交阅读记录。收费类型明确标为待确认，不声明登录限制。其他子域、移动版及日漫旧式 `/info/` 别名不认领为可导入页面。

## 只读协议与边界

协议来自两站网页自身的 `/api/v1/comic1|comic2/comic/detail`、`chapter/detail` 以及日漫站 `/app/v1/search/index`。只读取公开 JSON，不执行远程脚本、不提取或复制源站 Token。安装范围仅用于网页入口，网络权限沿用公共规则。

目录核对作品 ID／slug、完整 `chapterList`、最新章节归属、组与章节唯一性；各组按 `chapter_order` 升序独立连读。`is_fee` 章节保留目录但不自动读取。正文先用一次目录请求核对作品、章节归属和收费状态，再取章节 JSON；每章固定两次元数据请求，没有全章图片预载、后台全量扫描或私有缓存。图片字节沿公共有限窗口按需加载。

正文的 `page_url` 是源站阅读器完整数组；`picnum` 在真实公开样本中可为零，不作为总数。重复图片地址保留独立页槽。目录与章节请求沿源站携带当前时间戳，避免复用旧元数据。签名 URL 只作为取图定位，不记录到日志或夹具；未证实的去签名路径不作为内容版本。接口失败、空正文或目录不完整时明确失败，不换通道、不覆盖旧目录。旧章节可能在源站自身缺图，不能通过猜测 CDN 路径替换原图。`direction` 未证实为书籍翻页方向，默认左至右，可由阅读器设置调整。

图标是本项目自制的文字标识，无第三方代码、字体或解码依赖。

## 验证

在 `apps/extension`：

```powershell
npx vitest run src/sources/sites/zaimanhua/tests/network.test.ts
$env:RUN_LIVE_ZAIMANHUA='1'
npx vitest run src/sources/sites/zaimanhua/tests/live.test.ts
Remove-Item Env:RUN_LIVE_ZAIMANHUA
npm run check
npm test
npm run build
# 隔离桌面 UI 验收（仅绑定本机，不加载已安装插件的数据）
npx vite --config src/sources/sites/zaimanhua/tests/ui.config.ts
```

单元测试使用自制 JSON，覆盖认领、资源归属、分组／页序／重复地址、收费拒绝、分页搜索、取消、重复更新、失败保留和一万章解析开销。联网测试仅 GET 公开搜索、两部作品首尾章节元数据、各章首尾图片及封面，输出数量、字节和耗时，不输出签名地址，不调用翻译模型。

UI 验收页为 `http://127.0.0.1:5203/#sites`，真实运行导入、书架仓储与阅读器，源站数据经仅 GET 的本机中继读取；Chrome storage／消息／权限 API 使用隔离桩，不读取用户插件数据，不调用账户或翻译服务。已检查原创章节导入（44 章、正文 17 页）、日漫作品导入（62 章、4 组、首章 55 页）、真实图片显示、切页和重开恢复至第 3 页。

单元测试覆盖失败保留目录／位置；本机 UI 还验证了源站缺图样本的 HTTP 404 提示与失败后继续翻页。已安装 MV3 的权限授予／撤销、网页浮动入口及原位译图恢复仍需独立验收，不能以本机 UI 或 HTTP 测试代表。真实翻译供应商与模型质量不在此次验证范围内。
