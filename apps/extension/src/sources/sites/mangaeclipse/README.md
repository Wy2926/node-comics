# Manga Eclipse

- 支持 `https://mangaeclipse.com/manga/<slug>/` 作品与 `/manga/<slug>/<chapter>/` 章节。章节 slug 原样作为身份，保留 `chapter-01`、小数和带标题的 `1-trap-part-one`；`style=list`／`style=paged` 不改变身份。未确认的域名、镜像和路径不导入。
- 复用 [Madara 共享引擎](../../shared/madara/README.md) 的静态完整目录和 `catalog-select` 阅读协议。目录使用单一未分组 `ul.main.version-chap`，包含折叠行；作品标题排除 `manga-title-badges` 标记。章节 canonical 指向精确作品，全部选中项的章节值、完整跳转地址和文字必须一致，并与正文当前章节标识匹配；章节标题取已验证的选中项，不依赖不存在的 `h1` 或文档标题。
- 目录与正文使用普通 HTTP，正文固定请求列表样式；不为读取目录打开源站网页或加载其广告、推荐图和脚本。需要源站验证时由用户在网站完成后重试，不自动改用其他通道。图片使用共享严格地址校验与公共 Referer 读取，不预取全章图片。
- 支持完整目录导入、12 小时目录同步与作品／章节浮动入口及「寻找其他语言」；原位翻译声明 `inlineRecognition: 'generic'`，不维护额外 DOM 识图实现。
- 名称搜索复用 Madara 只读 AJAX 搜索与分页，每页显式请求 12 项、一次 POST，不依赖 GET 页面的首批数量或总数。成功空响应或空的末尾 `no-posts` 标记确认结束，非空短页缺少标记则报错；共用严格作品／封面校验，不预取候选目录或打开源站标签页。
- 主要内容语言为英语，已确认存在国漫英译内容，不标生肉。收费类型为 `free`：依据[首页](https://mangaeclipse.com/)公开目录、[章节阅读入口](https://mangaeclipse.com/manga/world-apocalypse-online/chapter-112/)及正文直接开放、未见章节购买或会员解锁入口的行为判断，非源站正式全站免费声明；账号与评论功能不算阅读收费。

协议来源为 [Manga Eclipse](https://mangaeclipse.com/) 的公开原始 HTTP 响应及 [Keiyoushi 固定版本参考文件](../../shared/madara/upstream.json)。第三方归属和许可见共享引擎说明；图标为本项目绘制，不复制源站商标。

## 验证入口

在插件目录执行 `npm test -- src/sources/shared/madara src/sources/sites/mangaeclipse --maxWorkers=2`。自造结构夹具覆盖精确来源身份、版本式静态目录、无 h1 的作品级 canonical／章节选择协议、标题标记、重复图片、错误归属、完整性、取消与失败保留。

仓库根执行：

```powershell
node apps/extension/src/sources/sites/mangaeclipse/tests/verify-http.mjs
# 显式回放已采集的公开原始 HTTP 响应，不发网络请求：
node apps/extension/src/sources/sites/mangaeclipse/tests/verify-http.mjs --saved artifacts/madara-candidates/mangaeclipse
```

脚本使用打包后的实际适配器检查两部作品及各自首末章，输出写入忽略的 `artifacts/mangaeclipse/http/`。普通命令行 HTTP 可能受源站验证限制；实时请求失败不自动切换通道。`--saved` 核对原始响应摘要，只证明捕获样本的解析，不代表当前实时状态。两种模式均不代替实际浏览器扩展的导入、取图／解码、重开位置和权限验收，也不证明模型效果。

构建后的扩展使用[共享真实浏览器入口](../../shared/madara/README.md#验证入口)，站点参数为 `mangaeclipse`。命令行客户端与浏览器扩展 HTTP 应分别验证，不能仅凭某个客户端返回 403 就给本站增加网页会话通道。

名称搜索使用同一共享入口中的 `verify-search-browser.mjs`，逐次点击加载更多验证真实搜索、末尾标记、空结果、封面解码和无目录预取；使用固定分页的 AJAX 结果，不拿 GET 页面的数量当断言。
