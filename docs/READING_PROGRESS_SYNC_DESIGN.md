# 跨网站阅读追踪同步

插件将不同网站中已确认属于同一作品的阅读完成进度，同步到同一个 AniList 漫画条目。书架、来源目录、图片、翻译与精确续读位置仍独立；不合并多来源漫画，不改变 [OPDS 位置同步](COMIC_SOURCE_ARCHITECTURE.md)。

## 当前范围

- 首期入口为**插件内置图片阅读器**，目标为 AniList；MangaDex、Comix 已提供原生章节字段。其他来源没有可靠字段时明确提示，不能用目录序号、标题数字或已读条目数代替。
- 设置中连接自己的 AniList 账号并主动开启自动追踪。阅读器设置中选择作品，确认整数章号计数规则／偏移一次，后续有效章节完成自动上报。
- 原站阅读页面的自动观测、其他 tracker、卷数、小数章／番外的手工进度换算不在当前实现中。仅打开网站、下载或预加载不触发同步。
- Chrome／Edge 构建使用 Node Comics 自有 OAuth 应用；其他浏览器未配置自有应用时界面明确显示未配置并禁止连接。真实授权及写入仍是发布验收条件，不能用模拟测试代替。

## 账号与部署配置

Chrome／Edge 的自有公开 `VITE_ANILIST_CLIENT_ID` 分别保存在 [`.env.chrome`](../apps/extension/.env.chrome)／[`.env.edge`](../apps/extension/.env.edge)。WXT 按构建目标自动读取，手动包与商店包均生效；构建环境中的同名变量可覆盖文件配置。Firefox 尚未配置默认应用。

使用其他自有 [AniList OAuth 应用](https://docs.anilist.co/guide/auth/)时，将插件设置页「阅读追踪 → AniList 回调地址」显示的完整地址登记为 Redirect URI（包含 `/anilist`），并在对应浏览器的 `.env.<browser>.local` 或构建环境中设置公开的 Client ID。修改后重新构建并在扩展管理页重新加载。例如为 Firefox 配置后，在 `apps/extension` 执行：

```powershell
$env:VITE_ANILIST_CLIENT_ID = '<自有应用 ID>'
npm run build -- --browser firefox --mv3
```

不得编入 client secret、用户 token、MALSync 的 client ID 或回调域名。Chrome／Edge／Firefox、商店与手动包的扩展身份可能不同，必须分别核验实际回调；扩展使用 `chrome.identity.getRedirectURL('anilist')` 和 `launchWebAuthFlow`，不依赖网页内容脚本接收凭据。

客户端授权使用随机一次性 state、精确回调 origin/path、10 分钟会话时限和 Viewer 身份验证。回调缺少 state／身份不符时拒绝，不能为了兼容而放宽。AniList 当前不提供 scopes／refresh token；过期后重新授权，不声称“仅进度 OAuth scope”或自动刷新。真实服务是否回传 state、浏览器回调及账号权限必须实测。

连接失败提示保留到显式重试或新操作，不被状态通知或窗口焦点刷新清除。已知用户取消与其他授权失败分别提示；原始浏览器异常和回调地址中的令牌不显示、不记录。

凭据仅保存于扩展源私有 IndexedDB，不进入普通设置、`storage.local/sync`、导出、内容脚本消息、分析或默认日志，不上传 NodeLane 后端。公共 AniList 发现与搜索保持匿名；NodeLane OIDC／Logto 不变，追踪不要求 NodeLane 登录。

连接账号与启用自动追踪是两个动作。界面说明会创建或更新 CURRENT 条目、公开性由 AniList 设置决定；首次启用不补传历史书架。续授权期间暂停发送；关闭追踪或断开可以取消未完成的授权，不等待弹窗结束。换账号不会继承旧账号待发送记录；同账号续授权核验通过后只恢复授权故障任务，不解除重置／保护状态。

发布方还须核验 [AniList 使用条款与商业许可](https://docs.anilist.co/guide/terms-of-use)。本功能是阅读器的附加追踪能力，不代表已经取得商业许可；不将 API 当备份服务，不下载整库或镜像用户全部列表。

## 作品与章节关联

保存的绑定包含本地漫画 ID、来源键与代次、AniList mediaId、标题、已确认偏移和绑定修订。多个来源可以指向同一 mediaId；解除／改绑只使本地待发送贡献失效，不删除或回退远端条目。

来源提供的精确 AniList 外链优先作为确认候选。从 AniList 发现页进入来源搜索，原 mediaId 经应用层传给导入后的确认界面；修改搜索词或选错同名作品不会自动授权绑定。已有绑定不会被候选覆盖。

当前界面允许 AniList 漫画链接、整数 ID 或名称搜索；用户须确认所选条目和编号规则。查询严格限定 MANGA／ONE_SHOT，不把同名小说作为漫画。MangaDex 的 AniList／MAL ID 分开保存，provider 支持 `Media(idMal, type: MANGA)`，但尚未自动消费 MAL-only 来源关联。MALSync 托管映射服务未启用，不能把代码许可视为数据／服务许可。

AniList 的 `progress` 是整数章数（[官方 mutation](https://docs.anilist.co/reference/mutation)）。本地原生章号字符串只接受完整正整数，再应用已确认整数偏移，结果须大于零且在 GraphQL Int 范围内。`12.5`、`12a`、`12.0`、番外、合章、卷和分季重置均不自动截断。无法映射的完成只给当前绑定标记问题，不阻塞另一个可靠来源的目标。

同章多个站点、语言和汉化组只取同一计数体系中的最高有效完成序数，不累加。跳读至 N 不回填本地 1..N 的 `readAt`。未知总章数的连载可以推进；超过可信已知总数则暂停。读到网站最后一话不等于作品完结，首期不写卷数、不自动标 COMPLETED。

## 完成与同步链路

~~~text
前台成功显示、实际进入视口的全部页 + 到达完整章节末尾
  → 核验 entryId / contentId / generation
  → 同一目录事务保存本地已读 + 合并当前账号的待发送目标
  → 后台单一发送者读取 AniList 当前记录
  → 身份／状态／基线检查 → 必要的最小 progress mutation
  → 校验回执 → 只确认对应修订
~~~

阅读器使用有限挂载页面窗口的可见证据，不将 DOM 图片加载、后台预加载、译图切换或只跳末页算作全章阅读。不能证明完整清单、缺页、解码失败、旧内容代次的回调不登记目标。已具有 `readAt` 的章节被重新完整阅读也可产生新完成事件，不能仅依赖 `readAt` 的首次变化。

本地阅读不等待网络。存储追踪意图失败时仍尝试保存本地已读，并显示错误，不显示已同步。无绑定、未启用或重复目标不唤醒网络发送者；每页位置保存不产生 tracker 请求。

## 远端合并与保护

普通阅读目标为 `max(刚读取的远端进度, 当前有效完成序数)`；远端已达到目标时不发 mutation。已有列表项使用 list entry ID，新项使用 mediaId，两类 ID 不混用。

| 远端情况 | 行为 |
| --- | --- |
| 首次不存在／PLANNING | 已启用并出现有效完成后创建／转 CURRENT，不因打开漫画而创建 |
| CURRENT | 只更新 progress |
| PAUSED／DROPPED／COMPLETED／REPEATING | 暂停，用户在 AniList 调整后重试；不覆盖状态、不填满重读轮次 |
| 进度低于上次确认，或已有条目被删除／替换 | 暂停旧目标，不自动恢复历史高水位或复活列表项 |
| 用户明确接受远端进度 | 丢弃该目标所有来源的待发送贡献，采用当前远端基线；下一次真实完成才继续 |

不写评分、笔记、私密性、自定义列表、日期、卷数或重读次数。HTTP 200 + GraphQL errors、错误账号／mediaId、低于目标的回执均不算成功。超时结果未知，下次必须先读取远端，不盲目重发 mutation。

新进度、重新领取、改绑和基线确认均使用修订保护；旧 ACK 不清理新目标、不降低已确认基线，不能撤销用户接受的重置。AniList 公开接口没有条件版本／CAS，无法保证与另一设备同时写入绝不回退；已经发出的请求也无法在断开后撤销。不宣称强一致或 exactly-once。

## 持久化、恢复与开销

目录库显式从 v1 升至 v2，只增加 `trackingBindings`、`trackingJobs` 和索引；不删除重建已有库，不混用下载 `tasks`。队列以账号／授权代次／mediaId 合并，保留来源绑定修订。发送前重查来源仍存在、代次与绑定仍有效；移除来源时删除其绑定，废弃贡献不能继续决定最高值。

后台按到期索引读取，单实例串行、每轮最多十项或 25 秒。90 秒领取期限与预先设置的恢复 alarm 允许 worker 中断后重新读取远端；重启不扫描全书架。账号切换清理旧 scope，认证暂停按索引有界恢复。

网络／5xx 与限流最多自动重试五次，指数退避，之后需手动重试。429 遵守 Retry-After／reset；同平台公共查询与追踪只共享非敏感冷却时间，不共享 token。冷却为本机建议值，服务端和其他客户端仍决定实际额度；不可硬编码依赖 90 次／分钟。

正常单章最多一次远端读取和一次必要 mutation，多次离线完成合并为一个有效最高目标；未知结果、身份搜索与失败重试另计。可见性检查仅访问有限挂载页面，不全 DOM 扫描、没有高频轮询。功能增加了章完成事务与一次写前查询，换取恢复与误覆盖保护；真实大书架、跨设备与网络延迟基准尚未完成。

## 模块与上游来源

| 所有者 | 实现 |
| --- | --- |
| AniList 协议、授权、凭据与冷却 | [tracking](../apps/extension/src/tracking/anilist.ts)、[auth](../apps/extension/src/tracking/auth.ts) |
| 绑定、完成事务、持久队列与确认 | [store](../apps/extension/src/tracking/store.ts)、[coordinator](../apps/extension/src/tracking/coordinator.ts) |
| 后台受信命令与 alarm | [background](../apps/extension/src/tracking/background.ts)，不提供任意 URL／GraphQL／读取 token 命令 |
| 设置与阅读器界面 | [UI](../apps/extension/src/ui/tracking/TrackingSettings.tsx)，通过受限应用接口操作 |
| 站点编号和外链 | 各站适配器及 [SourceEntry](../apps/extension/src/sources/contracts/source.ts)，公共层不加站点分支 |

AniList 查询与 mutation 协议实现从 MALSync `0.12.5`、commit `f40f226b8bc52cdb42655f2a8448441b1b18b6f8` 的 AniList Single／helper 改编；保留其媒体查询和列表更新路径，改为最小字段写入、严格校验、独立凭据和持久确认。未整体引入 Vue／jQuery／Chibi、客户端 ID、token 日志或其托管映射服务。源码摘要、原许可、归属及修改范围见[第三方说明](../apps/extension/THIRD_PARTY.md)，分发包保留对应 notice 和 GPL。

MALSync 的原站 collector／SPA 生命周期规则留给后续逐站接入：检测失败不能回退成即时已读，generic 大图识别不能证明章节完整。不预建其他 tracker 的空实现。

## 验证

在插件目录执行 `npm run check`、`npm test`、`npm run build`。新增测试覆盖协议、OAuth 回调／取消／身份、旧库迁移回滚、原生字段、跨站去重、离线领取、陈旧回执、远端重置、账号切换、受信消息与界面；已有 OPDS、下载、匿名发现继续回归。

隔离 UI 验证先在插件目录运行 `npx vite --host 127.0.0.1 --port 5181 --strictPort`，再从仓库根目录运行 `node scripts/verify_tracking_ui.mjs`；Playwright／Chromium 路径见[脚本入口](../scripts/README.md)。它验证真实组件与模拟追踪服务的绑定、失败、暂停、状态、重置确认、语言与阅读位置，阻断外部网络；不是实际 OAuth、后台队列或 AniList 账号写入测试。真实发布仍需自有客户端回调、授权测试账号、真实章节和重启／离线恢复联调，未经授权不替用户账号创建应用或写进度。
