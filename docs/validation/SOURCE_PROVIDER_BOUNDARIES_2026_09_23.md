# 文件来源与漫画核心边界复审（2026-09-23）

本轮将 Google Drive 从漫画核心的默认远程实现改为注册的文件来源驱动。来源契约和显式安装仍是必要依赖；目标是在已有文件格式能力内添加来源时，只实现驱动及注册 / 配置，不修改漫画核心、阅读器或翻译。网站来源继续使用独立的网页发现和按图读取流程。

## 审查前后的边界

| 原侵入点 | 当前职责 |
| --- | --- |
| App、导入和来源生命周期直接调用 Drive 选择 / 重连并消费 Drive 类型 | `SourceSelection` / `SourceAccessChange` 承载通用结果；应用服务通过 registry 选择、登记、重连和断开 |
| PageService、恢复索引把非本地文件一律交给 `openDriveSource`，并把 snapshot 强转为 DriveBinding | `openFileSource` 按 connection.provider 查找驱动；Drive 驱动验证自己的冻结 revision 快照、账户、资源和允许的远程格式 |
| Drive 模块导入 `storage/source-ranges` 并配置目录 / 缓存清理 | 来源只获取字节和通知访问变化；公共 runtime 负责范围缓存，页面 / 应用服务负责页缓存、目录代次与失效策略 |

[contracts.ts](../../apps/extension/src/comics/sources/contracts.ts) 定义驱动、选择、打开上下文与访问事件；[registry.ts](../../apps/extension/src/comics/sources/registry.ts) 保存已注册能力；[runtime.ts](../../apps/extension/src/comics/sources/runtime.ts) 打开来源、装饰范围缓存并关闭活跃读取；[install.ts](../../apps/extension/src/comics/sources/install.ts) 是明确知道本地与 Drive 实现的安装入口。

[Drive driver](../../apps/extension/src/comics/sources/google-drive/driver.ts) 保留 Google 品牌、所选文件映射、账户和快照校验。其内部模块负责 OAuth、安全桥、固定 Google API、版本和 Range 字节校验，不导入漫画仓储、应用编排、页面服务、翻译或缓存策略。Chrome background / content-script 入口和 manifest 继续显式声明 Google 安装与权限，不需要为隐藏品牌名再引入一层空包装。

复审未发现 App、application、pages、reader、translation 中残留 Google 驱动导入、DriveBinding 强转或按 Google 名称分支。未注册来源只在对应读取 / 选择操作返回“来源未启用”，不再把未知来源猜成 Drive；其他已注册来源与核心可独立运行。公共回归使用未注册 Google 的 `fixture-cloud` 驱动验证选择、索引、恢复、撤权与删除，而不是 mock Drive 模块后宣称解耦。

## 资源身份、版本与开发数据

`providerItemId` 是连接范围内稳定资源身份，Drive 使用真实 fileId；`sourceKey` 是文档去重身份，可以包含该资源版本。仓储按 `[connectionId, providerItemId]` 唯一定位 binding，同文件的多个文档版本共用它，各 revision 固定独立 sourceSnapshot。访问事件按 connection / item 使全部相关版本失效，不误伤其他文件或账户。删除一个版本时，只在最后一个文档引用释放后移除 binding。

打开来源使用 revision 快照，不从可变 binding.locator 推断当前版本。Drive 驱动在网络访问前校验账户、稳定 item ID、版本 / 大小字段及 CBZ/ZIP / 单图格式范围。公共代码不解析 Drive 的 accountId、fileId、resourceKey 等快照字段。

当前按新开发基线工作，不做旧数据迁移、双写或兼容回退，也不为本次改造清空全库。早期 Drive 测试条目曾把版本 sourceKey 写入 providerItemId；这些条目与当前契约不兼容，须由用户移除对应书架测试条目后重新导入。**直接重复登记会命中原 sourceKey，不能修复旧条目。** 不自动删除既有记录或字节，本地已保存完整源文件无需为此清理。

## 产品入口与验证范围

书架和阅读器只暴露“导入漫画”，弹框列出本地文件和驱动注册的来源；通用组件不提供独立 Google 按钮。网站导入仍由目标网站内嵌按钮触发，不新增插件页的网站来源按钮。

模块检查新增公共层到具体来源的传递依赖限制，以及驱动到应用、仓储、页面、其他来源和缓存策略的反向依赖限制。定向回归覆盖不含 Google 的来源注册与读取、未知 / 未配置来源、共享 binding 多版本、重复索引、跨账户撤权隔离，以及 Drive 快照与事件映射。工具入口是扩展目录的 `npm run check`、`npm test`、`npm run build`；Drive 浏览器回归仍使用 `scripts/verify_drive_import.mjs` 的网页和 Chrome 托管模拟模式。

公共 runtime 同时校验连接与 binding 的访问状态：来源打开期间发生撤权会关闭迟到的来源实例；断开后才完成的读取和版本核验结果也不会返回给调用方。恢复选择只恢复已核实的连接和文件权限，旧缓存令牌保持失效。

本轮最终验证结果：

- `npm test`：57 个测试文件、593 项测试通过；已有规模测试文件 / 用例各跳过 1 项。
- `npm run check`：TypeScript 与 191 个模块的边界、环依赖和可达性检查通过。
- `npm run build`：Chrome MV3 构建通过，产物位于 `apps/extension/.output/chrome-mv3`。
- 隔离 Chrome for Testing 141 实测编译产物：本地 120 页 CBZ 导入、跳至第 100 页、重启恢复、独立清理缓存、390px 窄屏和统一导入弹框共 6 项检查通过，无页面错误。截图确认书架仅保留“导入漫画”，本地文件与 Google Drive 位于同一弹框。
- 模拟 Chrome Identity / Google Picker：7 项检查通过，覆盖导入读图、第二次选择、浏览器重启后的非交互恢复、断开后禁止恢复和错误呈现；模拟网页 GIS / Picker：5 项检查通过。两种模式均无页面错误或不支持操作。

本地证据为 `artifacts/drive-connect-local/source-boundaries-{tests,check,build}.log`；浏览器结果为 `artifacts/source-architecture/chrome-source-providers-2026-09-23/extension-results.json`、`artifacts/source-architecture/drive/run-Id6383/results.json` 与 `artifacts/source-architecture/drive/run-WUYBFO/results.json`。这些证据使用隔离配置及合成图片，未操作用户实际浏览器账户。

静态依赖检查和模拟驱动测试不能证明所有动态行为、所有未来来源或真实 Google 长期授权已经通过。真实账户验收与模拟 Identity API 的边界继续以 [Drive 授权记录](DRIVE_AUTH_2026_09_23.md) 为准；本次没有 Git 提交、发布商店或生产部署。
