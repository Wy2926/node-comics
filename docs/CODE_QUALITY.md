# 代码规范与模块维护

2026-09-14。本文件记录当前实际执行的检查和模块边界。早前模块整理未修改产品 API 或供应商协议；后续[作品管理实现](COMIC_LIBRARY_IMPLEMENTATION.md)使用全新本地数据库，后端数据库与供应商协议保持原有职责。

## 当前模块边界

| 职责 | 入口与约束 |
| --- | --- |
| 应用协调 | `apps/extension/src/App.tsx` 管理账户、书架和翻译提交，子组件通过 props 接收操作，不反向导入 App |
| 公共 UI | `src/ui/components.tsx` 提供 Modal、PageTitle、Stat、SettingRow；不依赖业务页面 |
| 偏好页面 | `src/ui/Preferences.tsx` 管理本页表单和账户队列设置；本机请求并发与服务器队列并发独立 |
| 阅读目录 | `src/reader/ThumbnailDirectory.tsx` 管理缩略图虚拟列表；主阅读器保留图片窗口、导航和阅读位置 |
| 任务状态 | `src/reader/jobs.ts` 统一状态优先级、排序、合并；恢复、轮询和 IndexedDB 写入共用，不允许旧快照恢复失效译图 |
| 作品与副本存储／偏好 | `library/store.ts` 原子保存新模型与副本，按引用清理字节；偏好只存当前 Settings 字段；自动授权由 `reader/auto-consent.ts` 独立管理 |
| 运营 API | `backend/app/admin_api.py` 包含供应商、额度调整与结果核实；认证、权限、幂等与结算仍复用原有实现 |
| 请求校验 | `backend/app/request_models.py` 统一 JSON 请求拒绝额外字段的规则；响应模型与请求模型独立 |

前端的 `src/…` 均相对于 `apps/extension/`。文件上传读取和用户公开字段分别复用 `backend/app/assets.py`、`backend/app/auth.py`，运营路由不依赖 `main.py`。

## 已接入的检查

在仓库根目录：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
npm --prefix apps/extension run build:web
```

`check` 包含 WXT 类型生成、TypeScript strict、未使用局部变量／参数检查及模块依赖检查。`check:modules` 从扩展入口遍历静态导入、动态 import 和 Worker 引用，拒绝运行时循环依赖及没有入口可达的源码模块；类型引用可以互相依赖，不被误判为运行时循环。检查器本身有循环、孤立模块和 Worker／懒加载回归用例。

后端使用既有隔离测试：

```powershell
cd backend
.venv/Scripts/python.exe -m pytest -q
```

测试夹具使用临时 SQLite 和独立对象目录。PostgreSQL 并发用例需显式设置 `RUN_POSTGRES_CONCURRENCY=1` 并使用独立测试数据库；未启用时的 skipped 不代表通过。

`.editorconfig` 约定 UTF-8、缩进和行尾。不要以压缩源码代替构建压缩；需要压缩的是发布产物。CSS 按规则和声明分行，保留必要的层叠顺序。清理选择器必须考虑弹出页、动态类名、响应式规则和阅读状态，不能只按一次截图的覆盖率删除。

## 本轮审查与处理

| 发现 | 处理 |
| --- | --- |
| Reader、Library、Feedback 从 App 导入弹窗，App 又导入这些组件 | 公共 UI 独立，消除反向引用；43 个源码模块通过可达性与运行时循环检查 |
| 内存恢复和 IndexedDB 使用两套任务合并规则，删除结果后旧快照可能重新带回输出 ID | 合并为纯函数，统一保持失效标记；增加内存与跨快照存储回归测试 |
| App 与后端 main 同时承担过多页面／接口职责 | 拆出偏好页、缩略图目录、运营路由；保持原回调、认证依赖及公开契约 |
| 旧 ServerJobs 页面、Status 组件、online 状态、unused import、仅测试引用的旧窗口工具残留 | 删除无入口代码；实际阅读锚点计算复用已测试的 anchorFor |
| 旧 autoTranslate／autoLimit 跟随普通偏好不断传播 | Settings 移除旧开关字段，读取与写入仅保留当前字段；自动授权仍独立保存 |
| 基础样式保留大量旧侧栏、旧首页与旧阅读器规则 | 删除 378 个没有源码类名引用的选择器；保留复杂选择器、当前 nc-* 样式和公共／弹出页样式 |
| ZIP CRC 测试通过 UTF-8 字符索引定位二进制 payload，偶发修改错误字节 | 改为字节定位并断言确实找到 payload；保留实际校验失败验证 |

以本轮开始时的工作区为基线，两份 CSS 经相同压缩器处理后从 **85,571 B 降至 58,550 B，减少 31.6%**。CSS 源文件因恢复可读格式而增加行数，不用行数衡量精简。前端 App 文件从 52,158 B 降至 44,703 B，后端 main 从 514 行降至 357 行；移出的业务仍正常保留。

## 验证与保留边界

- 前端 122 项测试通过；TypeScript、43 模块检查、Chrome MV3 与 Web 构建通过。
- 后端 159 项通过，14 项 PostgreSQL 相关用例跳过；现有测试依赖产生两项弃用警告，本轮未升级依赖。
- 重构后内存生成的 OpenAPI 与已有契约逐项相同，共 38 个路径；不需要数据库迁移。
- 浏览器验证复用 [自动翻译检查脚本](../scripts/verify_auto_translation.mjs) 与临时 API／模拟供应商。设置页、目录、报价弹窗、书架和弹出页使用清理前后 CSS 做截图对照；阅读位置、开关记忆、异常恢复和未知提交仍按原流程验证。输出保存在 `artifacts/auto-validation/`。提供 `CSS_BASELINE` 指向清理前的 `styles.css` 时启用像素对比。

六组样式截图对照通过（含宽／窄设置页），`UI_ONLY=1` 可单独复测设置与样式而不重复翻译流程。对照等待缩略图解码完成；允许 Chromium 阴影重绘中至多 0.5% 像素出现 1/255 的通道舍入差异，布局或明显颜色差异仍会失败。完整自动翻译检查已覆盖到连续滚动位置保持，UI 对照的独立复测结果为 `artifacts/auto-validation/ui-results.json`。供应商结果为模拟图片，不代表本轮重新验证了真实翻译质量。

保留阅读器的窗口管理、持久化提交记录、结果未知保护和各导入格式的独立适配器：这些逻辑具有不同的生命周期或协议，不能为了减少函数数量强行合并。保留尚有用途的 CSS 层叠规则与现有本地记录结构，不在无迁移方案的情况下批量重写用户数据。

本轮完成代码与本地验证，未提交、推送或部署；此前工作区改动继续保留。
