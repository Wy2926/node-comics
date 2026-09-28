# GA4 插件使用分析

分析用于改善插件激活、有效阅读、留存和功能体验，仅覆盖明确同意并成功上报的用户。官网不采集 GA4；任务、额度和付款事实以[运营后台](ADMIN_CONSOLE.md)及[翻译契约](READING_TRANSLATION_CONTRACT.md)为准。

## 同意与数据边界

- 默认关闭。首次正常进入书架时显示使用主题令牌的可选卡片，位于工具栏之后的正常内容流，不遮挡、不抢焦点；允许与不发送使用同级按钮，关闭等同不发送，设置中可随时更改。拒绝、关闭、已有明确选择及撤回后均不重复提示。
- 未同意时不创建分析标识、不写事件队列、不发送分析请求。提示是否已处理单独保存在本机，撤回不清除此选择。Firefox 可选数据权限也是必要条件，原生权限不能替代插件中的明确同意。
- 同意后只观察新行为。跨越新一轮同意的导入、搜索和缓存旧任务结果不补发；冻结页面恢复时，阅读器、逻辑页面与原位翻译按最新同意时间建立新观察窗口，旧异步结果不能进入新窗口。
- 撤回作用于所有插件上下文，停止后续发送并清除待发队列和分析标识；重新同意创建新标识。已交给中继的在途事件及已送达 Google 的数据不能靠本地清理撤回，历史数据请求需另行核实处理。
- 只发送有限分类和数量：界面、版本、语言、来源类别、阅读方式、翻译渠道类别、结果、耗时和错误类别。排除账户信息、漫画名、搜索词、文件名／路径、图片／OCR／译文、图片哈希、源站或签名地址、自定义渠道名与地址、Cookie、令牌和原始异常；不向 Google 转发用户 IP 或 UA。
- 本机随机标识属于假名标识，不等于完全匿名；不关联登录账户、订单、官网访问或跨设备 User-ID，不同步到云端。不同设备、重装或清除标识可能被计作不同观察对象，GA4 人数不是全部安装量或去重后的自然人数。

五语隐私政策、插件说明和商店数据收集声明须保持一致。官网承载隐私政策，但页面本身不埋点。

## 事件口径

事件及允许字段以[插件白名单](../apps/extension/src/analytics/schema.ts)和[服务端白名单](../backend/app/analytics.py)为准，跨语言测试检查一致性。只保留已有业务入口的事件，不以预留事件代替实际覆盖。

| 事件 | 触发口径与限制 |
| --- | --- |
| `page_view` | 同意后的主界面逻辑页面变化；使用固定界面枚举，不读取真实网址或标题 |
| `extension_first_use` | 该分析标识第一次可观察使用；现有安装首次同意不等于新安装 |
| `import_started` / `import_result` | 每个本地／Drive 文件或一次网站导入的开始与结果；文件区分新增、重复、失败和取消，网站成功仅表示导入操作成功 |
| `search_started` / `search_result` | 有效搜索与首轮完成／停止；名称翻译失败也有结果，逐站重试和加载更多不重复计首轮，不传搜索文本 |
| `reader_open` | 一次阅读会话首张可读图像实际展示，加载壳不计成功 |
| `reading_summary` | 每 30 秒分段汇总，隐藏／离开时尽力提交，模式变化时切分；时长和页数为增量 |
| `reading_engaged` | 本次阅读会话首次达到有效阅读标准，每会话一次 |
| `reader_activated` | 该分析标识首次达到有效阅读标准，由后台去重 |
| `translation_requested` | 阅读器主动开启／切换翻译，或原位会话首次有效阅读窗口返回；表示开启意向，可能使用缓存，不等于服务端新建计算任务 |
| `translation_viewed` | 阅读器按渠道、模式和语言首次实际展示译图，或原位会话首张译图已解码且进入视口；阅读器有本次开启意向时才附等待耗时，原位不报等待时长 |
| `translation_view_changed` | 用户主动切换原图、译图或对照 |
| `offline_download_result` | 持有任务的运行端提交完整／部分完成状态后上报；数量为完整缓存章节数，观察页面刷新不重复计 |
| `quota_blocked` | 可见阅读页展示明确的额度／会员障碍，按会话内渠道、模式和语言去重；不等于普通限流或收费失败 |
| `upgrade_click` | 点击阅读器升级入口，仅表示查看订阅意向 |

原位手动重新启动、自动启动新页面或配置更新建立新观察会话；普通滚动、轮询、图片重新解码、暂停恢复及原图／译图切换不重复计开始与首图展示。显示常规译图回退时，记录实际显示模式。

当前未采集按页翻译结果聚合、缓存暂停／取消／启动失败和统一功能异常，不能据此计算完整翻译失败率或全部缓存任务成功率；不采集注册、支付或退款事件。

## 阅读与报表口径

有效阅读指一次阅读会话中前台有效停留累计至少 60 秒，且实际展示至少两张不同页面。图片必须已解码且在阅读视口可见，预取不计展示；窗口失焦、页面隐藏、阅读面板／搜索／登录弹层遮挡及连续 120 秒无阅读交互时暂停计时。同一本漫画章节跳转或组件重挂载延续会话，离开阅读器或打开另一本漫画开始新会话。这是产品口径，不是 GA4 默认活跃用户定义。

累计阅读时间和页数须筛选 `reading_summary`；该事件的 `active_ms`、`pages_viewed` 和 `engagement_time_msec` 为增量。`reading_engaged`、`reader_activated` 是里程碑快照，不能再与汇总相加。翻译等待耗时仅统计带 `duration_ms` 的 `translation_viewed`，缺失不解释为零秒。

留存按媒体资源时区和首次有效阅读日期分组：以 `reader_activated` 入组、`reading_engaged` 回访，按每天、标准计算查看 D1／D7／D30。D7 表示第七个自然日回来，不是七天内回来；未满观察天数的群组不参加比较。激活漏斗使用“首次可观察使用 → 首次有效阅读”；已有漫画用户无需重新导入，导入应单独作为可选分支。

## GA4 资源与报表

使用 NodeLane 账号下的[插件媒体资源](https://analytics.google.com/analytics/web/#/a409676032p556145674/admin)，专用 Web 数据流为 `NodeLane Extension`，衡量 ID 为 `G-Z2EZ7RRTSS`，报表时区为中国 GMT+8。Web 是数据流类型，不代表采集官网。

用户级和事件级保留期为 14 个月，不随新活动重置；汇总报告不受此期限限制。Google Signals、用户提供的数据、广告个性化、精细位置／设备收集及增强型衡量关闭；`reader_activated` 为无货币价值的关键事件，开发者调试流量排除。Measurement Protocol 数据可能缺失常规网页标签的归因或地域信息，不为补齐报表扩大采集范围。

已有事件级维度为 `surface`、`screen`、`extension_version`、`ui_language`、`browser`、`source_type`、`format`、`mode`、`channel`、`target_language`、`layout`、`outcome`、`search_mode`、`error_code`、`entry_point`。当前业务报表使用 `active_ms`、`pages_viewed`、`duration_ms` 指标；新增参数需按分析需要注册定义，不将用户／任务／漫画 ID 用作维度。

已保存[NodeLane · 插件使用分析](https://analytics.google.com/analytics/web/#/analysis/a409676032p556145674/edit/oHc_vQo9QAuk-t-VBcuKtw)，默认过去 28 天：

| 标签 | 用途与解读 |
| --- | --- |
| 功能使用 | 事件用户数、次数；用户数仅指可观察分析标识 |
| 阅读时长与页数 | 仅汇总 `reading_summary`，按来源类型查看时间、页数和人数 |
| 翻译使用 | 对比开启与实际展示的模式／渠道；两个事件总数相除不是严格转化漏斗 |
| 导入、搜索与离线结果 | 按事件及结果查看次数和人数，覆盖范围以上述事件口径为准 |
| 激活与升级意向 | 查看观察起点、首次有效阅读、额度障碍和升级意向；点击不等于付款 |

这五个标签是概览表，顺序漏斗和留存需另建探索。报表及自定义定义有处理延迟；解读时注明日期和样本量，不把拒绝分析者视为零使用，也不把调试事件当成产品样本。

## 中继与发布

插件页面／原位脚本 → 后台消息校验与有界本地队列 → `POST /v1/analytics/events` → 固定 GA4 收集端点。MV3 不加载远程 `gtag.js`，secret 只保留在服务端。队列容量、寿命、批量和重试限制见[引擎](../apps/extension/src/analytics/engine.ts)；中继的请求大小、速率、去重、并发及超时限制见[后端实现](../backend/app/analytics.py)。

中继无需登录，不接收账户凭据、不混用翻译额度、不持久排队；安装标识由客户端声明，不是可信业务事实。服务端通过 Redis 共享速率、8 个中继执行位和短期去重，不使用进程内限流锁；IP 仅保存共享随机盐的 HMAC，事件仅保存去重摘要，不存正文。请求桶自动过期，去重最多 20,000 个标记并保留最多 24 小时，正常 API 重启和增加副本不会重置。Redis 不可用时丢弃事件，数据丢失或达到去重容量仍可能造成遗漏或重复。UUID 本机标识仅为满足 Web 数据流格式而稳定派生为 GA4 双数字段标识，仍不关联账户。代理来源地址边界遵循[部署规范](DEPLOYMENT.md)。

首次上线先更新 API 镜像及镜像内的五语隐私政策，在私密 `.env.server` 中设置 `GA4_ENABLED=true`、`GA4_EXTENSION_MEASUREMENT_ID` 和 `GA4_EXTENSION_API_SECRET`，然后重建 API 容器。生产 `GA4_DEBUG_MODE` 保持 false 或不设置；API 需能出站访问 Google HTTPS。同步 OpenResty 模板的来源地址覆盖规则并检查、重载代理。

分析无需新数据库迁移、新依赖或后台任务，单独上线本功能只需更新 API 服务，不要求升级控制 worker、maintenance 或翻译计算节点。确认中继、隐私披露及商店声明就绪，再发布插件并核实明确同意后的真实入库。旧 API 的 404，以及关闭／缺配置中继的 204，均不能留待以后回放；健康检查和 HTTP 成功码不代表 GA4 入库。

## 验证

自动测试禁止真实外发。单元测试覆盖白名单、同意边界、队列、发送方权限、重复执行及恢复；[脚本入口](../scripts/README.md)分别提供 MV3 模拟交互验收和 GA4 严格格式验证，后者不产生报表数据。

真实联调使用独立数据库、插件 profile、自制内容及测试数据流。需在已授权的真实联调服务开启 `APP_ENV=development`、`GA4_DEBUG_MODE=true` 时，由后端添加 DebugView 标记；客户端不能控制，生产开启会拒绝启动。保留开发者流量排除，并在 Google 中核实事件和参数；完成后停止临时服务、恢复正式构建。运行报告和截图放忽略的 `artifacts/`，不在规范中记录每轮结果。

参考：[Chrome 扩展接入 GA4](https://developer.chrome.com/docs/extensions/how-to/integrate/google-analytics-4)、[Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4)、[格式验证](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events)、[Firefox 数据同意](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)。
