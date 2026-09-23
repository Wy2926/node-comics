# Node Comics · 漫游插件

React / TypeScript / WXT Manifest V3 漫画阅读器。原图、译图和阅读位置分别保存；插件轻量，翻译计算由后端集群执行。

漫画使用单来源模型：本地漫画文件、Google Drive CBZ/ZIP 或专用网站适配器。选文件自动导入，点卡片直接读；没有散图导入、资料编辑、跨来源合并和版本管理。使用独立新库，不迁移或兼容旧书架。见[产品契约](../../docs/SIMPLE_COMIC_READING_DESIGN.md)与[本轮验收](../../docs/validation/SIMPLE_READING_2026_09_23.md)。

## 运行与检查

界面现支持 16 种语言，包括韩语（한국어）。界面语言可在“外观与偏好”中选择；跟随浏览器时 `ko` / `ko-KR` 自动使用韩语，界面语言与漫画翻译目标语言独立保存。完整词典位于 `src/i18n/dictionaries/ko.json`；构建时同时生成包内 UI 词典与 Chrome `_locales/ko/messages.json` 商店元数据。`npm test -- tests/i18n.test.ts` 检查词典键、占位符、语言匹配与设置隔离，`npm run zip` 生成 Chrome MV3 安装包。

要求 Node.js 22.23+、npm 10+。开发预览默认位于 `http://127.0.0.1:5173`；产品 API 由 `src/service.ts` 固定。

```powershell
cd apps/extension
npm ci
npm run dev          # http://127.0.0.1:5173
npm run check        # 类型、未使用变量、模块边界
npm test
npm run build        # .output/chrome-mv3
npm run build:web    # dist-web
```

Firefox MV3 打包：`npm run zip -- --browser firefox --mv3`，产物位于 `.output/node-comicsextension-0.1.0-firefox.zip`；本地清单检查：`npx --no-install web-ext lint --source-dir .output/firefox-mv3`。固定 Firefox ID 为 `comics@nodelane.net`。最低版本为桌面 140、Android 142，以使用内置数据同意提示；清单声明账户认证、个人身份信息和用户选择的漫画图片内容传输。该声明不代表签名或商店审核已完成。要求见 [Firefox 数据同意文档](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)。

2026-09-21 Firefox 修复：后台与设置初始化仅在 API 存在时调用 `setAccessLevel`，避免后台提前退出、网页导入消息无人处理。回归命令：`npm run check`、`npm test`；332 项测试通过，包括缺失 API 时的后台导入处理、设置初始化和私有凭据存取。Firefox 156 隔离配置实测加载临时扩展，阅读器正常显示；在 `www.copy4000.com/comic/laizishenyuan` 点击导入按钮，打开目录页并读取到 100 个条目、4 个分组。本轮未验证真实 OIDC 登录、章节图片下载或翻译。`web-ext lint` 为 0 错误、7 条现有构建代码警告（动态 import、innerHTML、Function 构造器）；尚未签名或提交商店。

Chrome / Edge 扩展管理页打开开发者模式，加载 `.output/chrome-mv3`。产品服务固定为 `https://comics.nodelane.net`（`src/service.ts`），插件不提供运营管理页面或服务地址设置。供应商密钥只在后端。

“我的账户”已开放 PLUS 卡片，右上角切换月付／年付；结账自动使用后台唯一的全站默认渠道，不显示支付渠道选择。商店公钥固定扩展 ID 为 `aiajdjliifeeaogpalejpggkiccjbneo`；沙盒 API 的 `EXTENSION_IDS` 也须包含该 ID。使用新构建后，在扩展管理页重新加载插件。

独立沙盒可在构建前设置 `$env:VITE_API_BASE='https://<沙盒域名>'`，再执行 `npm run check` 与 `npm run build`。该地址同时写入客户端与扩展的精确 host permission，仍不能由用户在运行时修改。正式构建前执行 `Remove-Item Env:VITE_API_BASE -ErrorAction SilentlyContinue`，恢复默认服务。固定扩展 ID 不变，沿用已登记的 OIDC 扩展回调；沙盒需要独立后端数据库和支付配置。

插件图标和左上角品牌使用 `output/imagegen/nodelane-logo-v1` 素材：发布所需图标复制到 `public/brand`，横版 WebP 复制到 `src/assets/brand`，构建不依赖输出目录。漫画管理页与弹窗共用 `BrandLogo`，中文界面显示中文图片文字，其他语言显示英文，并跟随亮暗外观切换对应素材。横版图片保持 5:1 比例；浏览器工具栏、扩展管理页和插件标签页使用同版图标。

## 阅读翻译

自动翻译当前页与后三页，逐页保存稳定操作编号并调用 `POST /v1/translation-plans`；响应丢失时按原编号核实。已有原图无需重传，缺失原图按回执上传。已受理任务在关闭客户端后继续由后端执行。

普通／PLUS 每滚动 60 秒最多新增 30／100 张翻译图片，跨模式、语言、设备合计；重复请求、重传与直接复用完成结果不计数。分钟限额与日／月页数权益分开。客户端不查询队列作准入预判、不显示批量预存或常规额度；限流按 Retry-After 恢复，额度不足在图内提供升级入口。

阅读会话租约负责当前窗口的实时优先级，账户长轮询直接消费任务增量。原图上传固定并发 5，图片按有限阅读窗口加载；服务端负责公平执行。完整时序、取消、重试与验收见[阅读计划契约](../../docs/READING_TRANSLATION_CONTRACT.md)，版本授权见[译图共享](../../docs/RESULT_SHARING.md)。

## 账户同步与按需取图

- `GET /v1/me/translation-changes` 提供账户增量状态，游标和任务快照在同一 IndexedDB 记录保存。后台仅同步状态，不下载全部已完成译图。
- 来源修订与页面定位符用于按需读取；真正物化后的图片 SHA-256 是翻译内容身份。恢复上传重新读取冻结页引用并核对 SHA-256 / 字节数，不依赖旧整文件页匹配接口。
- 当前页附近按需下载原图和最新译图；阅读视口按 3200 万像素预算进一步收缩解码窗口。译图变化不修改原图布局尺寸、页 ID 或相对阅读位置。
- 新状态使用服务端 `change_sequence` 排序，能接受租约恢复后的状态变化并拒绝迟到快照。不同模式、语言、版本与账户的结果分别标识。
- 原图缺少本地缓存时，可按本人有效 R2 原图恢复；授权链接按需请求，不写入持久清单。删除服务端译图撤销远端访问，用户已保存的本地副本保留。

## 本地导入、书架与采集

目录、完整容器、五类缓存 / 下载与翻译操作统一使用 `node-comics-sources-v1-` 数据库基线，仍按类别分库。启动先校验表、主键、索引和字节后端；早期同名 v1 测试库原样保留，不迁移、不自动删除。早期导入需在新基线重新导入。详见[实施记录](../../docs/COMIC_SOURCE_IMPLEMENTATION.md)与[数据库回归](../../docs/validation/DATABASE_BASELINE_2026_09_22.md)。

- 支持图片、无 DRM MOBI、CBZ/ZIP、CBR/RAR、PDF。MOBI 分块摘要每次读取至多 1 MiB，不执行书内 HTML；GIF 首帧转 PNG。参见[格式与缓存](../../docs/IMPORT_FORMATS_AND_CACHE.md)、[本地导入](../../docs/SIMPLE_COMIC_READING_DESIGN.md)。
- 网页图片发现与字节采集分离；MangaCopy 按懒加载与总页数核对完整性，失败页有重试原因。参见[采集与漫画管理](../../docs/COMIC_LIBRARY_IMPLEMENTATION.md)、[网页图片导入](../../docs/SIMPLE_COMIC_READING_DESIGN.md)。
- 身份、图片、任务归服务 origin 与账户 ID；来源 Cookie 与登录令牌不上传。登录前可读本地原图。
- 会话统一在 `src/auth` 管理。Chrome / Edge 的访问令牌和续期凭据存于限制为 `TRUSTED_CONTEXTS` 的 `chrome.storage.local`；Firefox 不支持该访问级别 API，改存扩展 origin 的 IndexedDB，`storage.local` 仅广播无凭据的会话 ID 与变更标记。到期前自动续期，认证 401 最多续期重试一次，失效后同步退出并显示重新登录入口；断网保留会话，原图和阅读位置不受影响。旧会话结构已删除，不迁移或兼容。配置、边界与隔离验收见[生产身份说明](../../docs/PRODUCTION_IDENTITY.md#客户端会话与续期2026-09-20)。

## 浏览器隔离验收入口

```powershell
npm run dev -- --port 5176
```

访问 `http://127.0.0.1:5176/tests/reader-fixture.html`；`?plus` 切换会员名额，`?redrawOutcome=success` 或 `failure` 提供模拟完成与失败。fixture 拒绝其他源站请求并检查非测试书架数据。模拟译图使用原创《星光书店》原图字节，只验证交互、状态和位置稳定，不代表真实模型翻译效果。

本次前端类型与模块检查、单元测试、Chrome MV3 构建和 Web 构建已通过。真实浏览器、R2 与多机器验收由整体验收记录分别说明；历史证据文件保留其日期，不能当作本轮验收。

书架卡片封面左上角以浮层标签显示最近阅读时间；“批量管理”支持勾选、全选当前搜索结果、取消选择和确认移除，选择不受虚拟列表渲染窗口限制。移除释放所选漫画的本机记录与文件引用，不删除云盘、源站或服务器共享图片。单项失败不阻塞其余项目。书架顶部不再显示下载管理。

设置中的本机资料、独立缓存和云盘账户沿用统一容器宽度与卡片样式，移除“管理漫画”“管理下载”快捷入口。来源驱动通过注册的 `listAccounts`、`subscribeAccounts` 和 `describeAccount` 提供账户列表、变化通知与专属展示字段；账户独立于缓存统计加载，授权后尚未导入漫画也可显示。Google Drive 显示已验证账户的邮箱和标识；设置页不判断供应商 ID。具体契约见[来源与缓存架构](../../docs/COMIC_SOURCE_ARCHITECTURE.md#账户展示注册)。

兼容与交互验收以桌面浏览器为目标，窄屏不在项目兼容范围。本轮证据见[书架与设置验收](../../docs/validation/LIBRARY_SETTINGS_2026_09_23.md)。

## 登录界面验收（2026-09-20）

登录使用漫画分镜风格的阅读通行证。准备、授权等待、错误原因与重试均显示在原生 dialog 内；收起后保留书签入口，重复点击不会重复发起登录。网页回调在面板内确认结果，成功或失败均恢复登录前的漫画；登录成功关闭面板并提示结果。深色、主题色、大字体与减少动效设置沿用阅读器偏好。

```powershell
npm run dev -- --port 5187
```

打开 `http://127.0.0.1:5187/tests/auth-lifecycle-fixture.html?login=oidc#account`。点击登录后，用 Alt+E 返回模拟失败、Alt+S 返回模拟成功；`?login=config-error#account` 验证首次配置请求失败后的重连，`?login=loading#account` 验证配置加载，`?login=development#account` 验证测试用户名表单。仅允许隔离端口和测试数据，身份窗口与请求全部模拟，不联系真实身份服务。

本轮 Chrome 验证覆盖面板内等待／失败与重试、收起后失败提示、服务重连、Escape 焦点恢复、收起期间翻页及登录后保留第 2 页、390px 窄屏与深色 125% 字号。类型与模块检查、304 项现有测试及 Chrome MV3 构建通过。本轮属于本地 UI 和模拟身份流程验收，未进行真实身份服务登录或公开部署。
