# 来源数据库启动回归（2026-09-22）

用户在编译扩展中遇到 `IDBDatabase.transaction` / `NotFoundError`。旧实现复用了早期开发数据库的名称和版本 1；已有数据库即使缺少新表也不会触发 `onupgradeneeded`，列表第一次发起事务时才抛错。此前仅使用空 profile 的验收未覆盖这一条件。

## 修复与数据边界

目录、完整容器、五类缓存 / 下载和翻译操作共 8 个数据库统一使用固定的 `node-comics-sources-v1-` 新基线，由 [storage/database.ts](../../apps/extension/src/storage/database.ts) 创建并在打开时核验表、主键、autoIncrement 和索引定义；字节库另点查后端标识。不扫描 Blob 或全库记录。关闭 / 版本变化时释放缓存句柄，失败后允许重新打开。

本次遵守项目的新库开发约定：不迁移、不双写、不删除旧库，也不因结构错误静默清空资料。早期导入需在新基线重新导入。若当前基线本身损坏，页面显示明确的结构错误；下载管理捕获列表失败，不再产生未处理的 Promise。账户身份数据库不在此次更名范围。

## 已执行验证

- `npm run check`：类型检查与 182 个模块的边界、循环和可达性检查通过。
- `npm test`：49 个测试文件、435 项通过，规模测试 1 项默认跳过；规模项此前独立通过，详见[主验收](SOURCE_ARCHITECTURE_2026_09_22.md)。依赖 `node-unrar-js` 缺失 sourcemap 的警告不影响测试结果。
- `npm run build`：Chrome MV3 构建通过。
- 新增 `tests/source-database-baseline.test.ts` 的 15 项回归：残缺旧库与新库并存、旧记录保持、表 / 索引 / 主键 / 后端标识错误、错误传播，以及打开时不扫描业务记录；残缺译图库进入真实 `loadResultBlob()` 流程时明确拒绝，不重复远端下载或改动已有 Blob。
- 另补 13 个调用方用例，确认页面服务、译图与内联原图不把结构损坏当缓存未命中，仍容忍一般缓存 / 配额错误。Firefox 启动模拟覆盖 Drive 已配置和未配置两种情况，不依赖本机 `.env.local`，也不假设 Chromium 专有 `setAccessLevel` API 存在。
- `scripts/verify_source_database_baseline.mjs`：在 Chrome for Testing 141 的隔离扩展 profile 中，先建立 8 个只有部分表的旧 v1 库，再打开真实编译页面；导入自制图片、阅读、关闭浏览器重开继续阅读均通过，旧库版本 / 表 / 哨兵记录完全不变。
- 同一脚本的第二个隔离 profile 刻意破坏当前基线：页面显示结构错误，未出现页面异常或未处理的 Promise，旧库仍不变。

浏览器结果与截图位于忽略目录 `artifacts/source-database-baseline/`；运行入口见 [scripts/README.md](../../scripts/README.md#新来源架构验收)。没有读取用户漫画或修改用户浏览器资料。

## Drive 测试构建的配置修复

WXT 0.21.4 在导入配置文件之后才加载 `.env.local`。此前立即计算 manifest，导致授权 URL 已进入客户端代码却缺少对应 host permission。现使用 WXT 支持的 manifest 回调，在环境加载完成后生成权限，同时修正 `VITE_API_BASE` 的同类时序问题。

已通过实际构建检查临时授权域名与 `https://www.googleapis.com/*` 权限，且运行时注入的 `content-scripts/drive-bridge.js` 存在。测试凭据与临时域名仅保存在忽略的本地配置；不写入版本库。真实 Google 授权、Picker 和所选文件的 Range 读取仍需账户交互验收，构建通过不能替代这些结果。

使用隔离 Chrome for Testing 141 与 Edge 153，已从编译扩展点击 Drive 入口，经真实公网隧道载入授权页，background 核验标签页 documentId，专用桥与真实 GIS / Picker SDK 均就绪，两个授权按钮可用。修复了 SDK 比桥先就绪时的状态文字滞留，以及 Google SDK inline CSS 被阻断；仅 CSS 放行 inline，脚本来源限制保留。两浏览器没有授权页 CSP 或 JavaScript 异常；产品 API 的 503 是脚本主动隔离的响应。

没有点击 Google 授权按钮，没有 OAuth / Drive API 请求或 token，也未显示 Picker。截图与脱敏结果在 `artifacts/drive-connect-local/authorization-ready*.png`、`browser-results*.json`。因此尚不能确认用户控制台配置或实际授权成功。
