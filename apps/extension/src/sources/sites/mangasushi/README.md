# Mangasushi

- 仅认领 `https://mangasushi.org`；作品 `/manga/<slug>/`，章节 `/manga/<slug>/<chapter>/`。章节标识保留小数、连字符、下划线和原始文本，`?style=list`／`?style=paged` 不改变身份；不认领镜像或其他主机。
- 通过 [Madara 共享引擎](../../shared/madara/README.md)读取作品详情及只读 AJAX 完整目录，校验 canonical、作品数字 ID 和所有章节归属。目录反转源站倒序，保留原始章节标题，不推断缺少的章节。
- 正文使用列表样式，校验章节 canonical、标题、AJAX 导航占位标记及当前章节 ID，保留连续 `image-N` 页槽和重复图片 URL。目录、正文、封面均走普通 HTTP，不读取页面脚本数据、不依赖打开来源标签页。
- 提供浮动导入／管理入口、12 小时目录更新和 `inlineRecognition: 'generic'` 原位识图，无额外页面适配器。图片和封面沿用公共权限、Referer 和取图预算。
- 主要内容为英语翻译日漫。收费类型为 `free`：[首页](https://mangasushi.org/)及[最新章节样本](https://mangasushi.org/manga/lonely-attack-on-the-different-world/chapter-335/)直接公开阅读，[捐赠说明](https://mangasushi.org/donations/)将付款用于托管与翻译支持，未将捐赠列为章节阅读前提。依据这些公开内容判断免费阅读，PayPal、Ko-fi 或 Patreon 的自愿捐赠不等同付费阅读。
- 站内名称搜索复用 Madara 的只读 AJAX 搜索与分页：每页 12 项、一次 POST，显式名称和页码；末尾标记或成功空响应确认结束，满页带标记时也直接结束，短页缺少标记则报错，不预取候选目录。搜索不依赖源站标签页，权限、取消、游标绑定与封面读取沿用公共运行时。

协议依据为源站公开 HTML 及 Keiyoushi 固定版本的 [Mangasushi](https://github.com/keiyoushi/extensions-source/blob/780153a29642a57364e894bc0850c4e76619c7de/src/en/mangasushi/src/eu/kanade/tachiyomi/extension/en/mangasushi/Mangasushi.kt)。共享引擎维护协议与[上游来源声明](../../shared/madara/upstream.json)，不运行上游 Kotlin 或源站脚本。本地图标为自制识别图。

## 验证

在插件目录执行 `npm test -- src/sources/shared/madara src/sources/sites/mangasushi --maxWorkers=2`。本站自造夹具检查精确 URL 认领、身份、能力、请求数量、取消、目录归属和正文页槽；不含源站漫画 HTML 或图片。

真实源站验证需分别检查详情 → AJAX 目录 → 首末章节原始响应及图片解码，再使用[共享真实浏览器入口](../../shared/madara/README.md#验证入口)检查导入、阅读和重开位置，站点参数为 `mangasushi`。普通 HTTP 检查、自造夹具、真实浏览器与翻译模型是不同验收项；证据保存于忽略的 `artifacts/`，不提交源站图文。

名称搜索使用同一共享入口中的 `verify-search-browser.mjs`，逐次点击加载更多验证真实搜索、满页末尾标记、空结果、封面解码和无目录预取；不以离线夹具代替真实源站验收。
