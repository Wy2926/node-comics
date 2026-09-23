# 书架批量管理与设置账户展示

2026-09-23。状态：代码实现、Chrome MV3 构建与桌面 Chromium 隔离验收完成；未发布或部署。按本次确认，窄屏不在项目兼容与验收范围。

## 变更

- 我的漫画顶部移除下载区块；封面左上角以浮层标签显示实际 `lastReadAt`，标签仅有时钟图标与时间，不显示“最近阅读”文字，未读明确标示。
- 批量管理支持勾选、全选搜索结果、取消选择与确认移除。搜索后保留选择，虚拟列表未渲染的漫画同样参与全选；逐本失败隔离并保留重试。
- 本机资料、独立缓存与上方偏好卡片宽度、左边缘、标题分隔与编号一致，移除两个管理快捷按钮。
- 云盘账户采用紧凑横排，信息在左，状态与操作在右。通用 UI 只渲染注册来源返回的纯文本字段；Google Drive 注册邮箱与账户标识，基础来源、账户名称和连接状态始终可见。重新选择刷新显示资料，不改变有效访问代次。
- 修复账户列表只读取漫画导入记录、连接成功但零文件时提前返回的问题。注册来源可独立提供账户列表与变化通知，设置页不依赖缓存统计；加载失败有明确错误与重试，不误显示无账户。账户展示快照不写入漫画目录或恢复文件访问。
- 16 个界面词典补齐新增文案。

## 自动检查

在 `apps/extension` 执行：

- `npm run check`：TypeScript 与 187 个模块的边界、循环、可达性检查通过，已删除下载 UI 遗留的孤立 `download-service`。
- `npm test`：619 项通过、1 项既有跳过。包括任意新增来源注册、独立账户读取与失败隔离、后台消息唯一归属、令牌不泄露、会话过期、可选邮箱解析、账户资料更新、批量去重、失败重试、未选漫画保留与迟到缓存写入拒绝。`node-unrar-js` 仍有既有缺失 sourcemap 提示。
- `npm run build`：Chrome MV3 构建通过，输出 `.output/chrome-mv3`。

## 桌面浏览器

使用 `scripts/verify_simple_reading.mjs`，Playwright Chromium 141.0.7390.37、1440 × 1000，新建隔离 profile，加载本轮构建的扩展。沿用[脚本说明](../../scripts/README.md)配置 `PLAYWRIGHT_MODULE`、`TEST_CHROMIUM`，并设置 `TEST_BROWSER_NAME=desktop-library-settings`。只用仓库自制样本与合成账户数据，产品 API 被拦截。

18 项检查通过、0 页面异常，覆盖：

- 单本／批量导入、重复导入续读、真实关闭重启后恢复第 100 页；CBZ、PDF、MOBI、RAR 解码以及损坏文件／图片失败隔离。
- 卡片时间与数据库保存的最近阅读时间一致；标签位于封面内，不再占用封面上方空间；顶部无下载区块；单本移除保留原有语义。
- 42 本合成漫画超过可见窗口，全部可选；搜索后取消一本，确认取消保留全部数据，再移除 41 本，仅留下未选项，其他漫画保持可读记录。
- 五个设置卡片的宽度与左边缘逐一测量一致；账户信息与操作使用紧凑横排；没有“管理漫画”“管理下载”入口；清理原图页缓存保留漫画。
- 已注册 Google Drive 的邮箱、账户标识与连接状态在设置显示；其他上下文断开连接的广播触发页面刷新，保留只读账户信息。

结果与截图位于 `artifacts/simple-reading/desktop-library-settings/`：`results.json`、`desktop-shelf.png`、`desktop-shelf-top.png`、`batch-management.png`、`settings-storage-accounts.png`、`source-account.png`。截图已逐张检查。

## 授权后账户为空的专项回归

`scripts/verify_drive_import.mjs` 在 1400 × 1000 的真实隔离 Chromium 中加载构建扩展，通过本地 HTTPS 模拟 Google 元数据、GIS 与 Picker。Chrome 模式 9 项检查通过，网页模式 6 项检查通过，两者均无页面异常：

- Chrome 授权后取消 Picker，确认漫画目录的账户数和漫画数均为零，设置仍显示后台已连接账户、邮箱及标识；读取后目录仍为空。
- 两种模式选择零文件时均保存账户记录、不生成漫画，设置正确显示账户；打开账户面板不增加授权、账户探测或文件读取请求。
- 正常导入、原图 Range 读取与解码、复用连接、索引失败提示仍可用；Chrome 隔离浏览器重启后恢复以及显式断开后禁止恢复通过。

结果与专项账户截图位于 `artifacts/source-architecture/drive/run-*/`，包含 `results.json`、`account-without-import.png`（Chrome）与 `account-only-connection.png`。

账户流程使用模拟资料，未检查用户实际浏览器中的账户，也未验证真实 Google OAuth／线上账户返回。已有账户在重新连接或选择文件时补齐可用邮箱；接口未提供邮箱时只显示其他可用资料。没有调用翻译模型、外部计费或公开部署。
