# Drive 消息回传与重复授权修复（2026-09-22）

用户实际点击 Google Drive 后，插件立即提示“不支持的操作”，授权页仍会打开，但选图无法交付到导入确认。此前 SDK / 安全桥就绪检查没有覆盖插件收到的连接回复，不能证明完整导入成功。

## 已定位原因

扩展按顺序注册网站来源与 Drive 后台监听器。网站来源监听器对所有可信扩展页面消息都返回异步响应；不认识 `NC_DRIVE_*` 时先回复“不支持的操作”。Chrome 会将同一消息分发给多个监听器，但只有第一个回复生效。Drive 后台仍打开授权页，插件端的等待却已经因错误结束，形成“页面打开但选图无反馈”。

网站来源监听器现只接管明确列出的来源消息，其余交给所属模块。回归使用完整后台入口和全部 5 个监听器，按 Chrome 首回复语义分发，断言每种请求只有一个响应者；覆盖 Drive CONNECT → INIT → RESULT → STATUS → TOKEN → DISCONNECT、语言、主题、未知消息及来源权限边界。

插件端另阻止重复点击开启并行选图流程，收到文件后列出文件名和归属确认，登记失败在当前弹窗显示原因，登记成功给出反馈。仅连接账户而未选择文件时显示连接成功，不出现空文件导入弹窗。

完整浏览器回归进一步发现：`DriveRangeSource` 将原生 `fetch` 存为实例属性，再作为方法调用，浏览器接收到错误的 `this`，在实际图片请求发出前抛 `Illegal invocation` 并被转成离线提示。元数据通过普通函数参数调用，因而能成功；原有 Node fetch mock 未体现此差异。现将请求函数绑定到 `globalThis`，并新增要求正确 receiver 的回归。

## 有效授权复用

独立授权页通过已核验的 tab、顶层 frame、固定 HTTPS URL、nonce 和 documentId 初始化一次。后台只向本次桥交付尚有效的会话 token，页面直接将它用于 Picker，取消选文件也保留本页期内授权。没有有效 token，或用户主动点击“只重新连接账户”时，才调用 GIS。

复用结果仍重新核验 Google 账户与所选文件权限。同一 token 的到期时间与连接代次保持原值，不能通过页面报告的 `expiresIn` 延长；过期或在初始化途中被替换的 token 不下发。token 不进入 URL、日志、漫画数据库、localStorage 或同步存储。

会话存储在浏览器重启、扩展禁用 / 重载 / 更新后会清空，所以首次重新加载修复版时仍需授权；后续同会话、期内选择直接复用。参见 [Chrome storage.session](https://developer.chrome.com/docs/extensions/reference/api/storage) 与 [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)。没有引入长期凭据或扩大 scope。

导航、关闭和断开连接以同步取消代次阻止异步旧结果交付；已经在途的会话写入若遇到取消，会撤回本次新凭据。结果提交或回滚结束前，状态查询只返回等待，不将尚未提交完成的结果提前交给插件。安全回归包含在 token 点查或 session 写入等待期间触发这些变化的场景。

## 自动化与构建

`npm test`：52 个文件、479 项通过，1 项规模测试默认跳过。`npm run check`：TypeScript 与 182 个模块检查通过；`npm run build`：Chrome MV3 构建通过。新增后台多监听器路由、会话复用、授权页模拟和 fetch receiver 回归；授权安全与路由定向检查 69 项通过。

`scripts/verify_drive_import.mjs` 在 Chrome for Testing 141 的全新 profile 中通过 5 项完整流程检查：网站与 Drive 监听器共存、真实按钮到文件名确认弹窗、登记后通过 Range 显示 640×960 自制原图、第二次选文件复用期内授权、模拟 503 在导入弹窗内显示错误。两次 Picker 选择共调用 GIS 1 次、账户核验 2 次、元数据 7 次、Range 1 次，没有页面异常或未授权请求。选择、阅读、错误截图均已实际检查。

本次结果位于忽略目录 `artifacts/source-architecture/drive/run-mG3koy/results.json`，截图同目录。Google SDK、账户、Picker、元数据和图片服务均为本机 TLS / DNS 夹具；没有真实 OAuth 或云盘访问。此检查证明编译扩展的完整业务流程，不替代用户实际 Google 账户验收。

## 验证边界

代码回归与使用自制文件、模拟 Google 服务的新建隔离浏览器测试，不等于用户账户的真实 OAuth / Picker / Drive 验收。用户指定的 `chrome-extension://` 页面被浏览器工具的 URL 安全策略拒绝，未绕过该限制接管用户 profile；实际页面需要用户重新加载扩展后操作。

用户随后按复测步骤重新加载修复版、选择实际 Drive 图片并登记，反馈“已导入并能阅读”。这确认了用户实际账户的一次授权 / 选文件 / 导入 / 阅读链路成功，属于用户手动验收；代理没有读取该私人图片或获取其令牌。真实多账户、令牌过期、远程版本变化和撤权等边界仍不能由这一次成功推断。

临时 HTTPS 授权服务继续运行，未修改 Google 控制台或扩大 Drive scope。原网站导入仍从网站内嵌按钮触发。
