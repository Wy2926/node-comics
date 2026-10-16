# LHTranslation

- 仅认领 `https://lhtranslation.net`；作品 `/manga/<slug>/`，章节 `/manga/<slug>/<chapter>/`。章节标识保留小数、连字符和原始文本，`?style=list`／`?style=paged` 不改变身份；不认领镜像或其他主机。
- 通过 [Madara 共享引擎](../../shared/madara/README.md)读取作品详情及只读 AJAX 完整目录，校验 canonical、作品数字 ID 和所有章节归属；章节行的下载按钮只作已校验辅助信息，不发起下载或改变源站。
- 正文使用列表样式，校验章节 canonical、标题、AJAX 导航占位标记及当前章节 ID，保留连续 `image-N` 页槽和重复图片 URL。目录、正文、封面均走普通 HTTP，不读取页面脚本数据、不依赖打开来源标签页。
- 提供浮动导入／管理入口、作品／章节「寻找其他语言」、12 小时目录更新和 `inlineRecognition: 'generic'` 原位识图；页面入口仅提供作品元数据。图片和封面沿用公共权限、Referer 和取图预算。
- 主要内容为英语翻译日漫。收费类型为 `free`：[首页](https://lhtranslation.net/home/)及[最新章节样本](https://lhtranslation.net/manga/kuro-no-shoukanshi/chapter-199-2/)可直接阅读，[捐赠说明](https://lhtranslation.net/donate/)用于支持更新、托管和购买原作，未将捐赠列为章节阅读前提。依据这些公开内容判断免费阅读，不把自愿捐赠当成漫画收费。
- 站内名称搜索复用 Madara 的只读 AJAX 搜索与分页：每页 12 项、一次 POST，显式名称和页码；末尾标记或成功空响应确认结束，短页缺少结束标记则报错，不预取候选目录。搜索不依赖源站标签页，权限、取消、游标绑定与封面读取沿用公共运行时。

协议依据为源站公开 HTML 及 Keiyoushi 固定版本的 [LHTranslation](https://github.com/keiyoushi/extensions-source/blob/780153a29642a57364e894bc0850c4e76619c7de/src/en/lhtranslation/src/eu/kanade/tachiyomi/extension/en/lhtranslation/LHTranslation.kt)。共享引擎维护协议与[上游来源声明](../../shared/madara/upstream.json)，不运行上游 Kotlin 或源站脚本。本地图标为自制识别图。

## 验证

在插件目录执行 `npm test -- src/sources/shared/madara src/sources/sites/lhtranslation --maxWorkers=2`。本站自造夹具检查精确 URL 认领、身份、能力、请求数量、取消、目录归属和正文页槽；不含源站漫画 HTML 或图片。

真实源站验证需分别检查详情 → AJAX 目录 → 首末章节原始响应及图片解码，再使用[共享真实浏览器入口](../../shared/madara/README.md#验证入口)检查导入、阅读和重开位置，站点参数为 `lhtranslation`。普通 HTTP 检查、自造夹具、真实浏览器与翻译模型是不同验收项；证据保存于忽略的 `artifacts/`，不提交源站图文。

名称搜索使用同一共享入口中的 `verify-search-browser.mjs`，逐次点击加载更多验证真实搜索、分页终点、空结果、封面解码和无目录预取；不以离线夹具代替真实源站验收。
