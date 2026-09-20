# 代码规范与模块维护

模块说明随代码维护；运行命令以各模块 README 和 package.json 为准。

## 当前模块边界

| 职责 | 入口与约束 |
| --- | --- |
| 应用协调 | `apps/extension/src/App.tsx` 管理账户、书架和翻译提交，子组件通过 props 接收操作，不反向导入 App |
| 公共 UI | `src/ui/components.tsx` 提供 Modal、PageTitle、Stat、SettingRow；不依赖业务页面 |
| 偏好页面 | `src/ui/Preferences.tsx` 管理阅读、语言与外观偏好；不提供用户队列设置 |
| 阅读目录 | `src/reader/ThumbnailDirectory.tsx` 管理缩略图虚拟列表；主阅读器保留图片窗口、导航和阅读位置 |
| 任务状态 | `src/reader/jobs.ts` 统一状态优先级、排序、合并；恢复、轮询和 IndexedDB 写入共用，不允许旧快照恢复失效译图 |
| 作品与副本存储／偏好 | `library/store.ts` 原子保存副本并按引用清理本机缓存；偏好只存当前 Settings 字段；阅读操作、幂等请求与上传进度由 `translation/store.ts` 的持久化清单管理 |
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

后端使用 [Docker 隔离测试](../backend/README.md#验证)，无需恢复已移除的宿主机虚拟环境。

测试夹具使用临时 SQLite 和独立对象目录。PostgreSQL 并发用例需显式设置 `RUN_POSTGRES_CONCURRENCY=1` 并使用独立测试数据库；未启用时的 skipped 不代表通过。

`.editorconfig` 约定 UTF-8、缩进和行尾。不要以压缩源码代替构建压缩；需要压缩的是发布产物。CSS 按规则和声明分行，保留必要的层叠顺序。清理选择器必须考虑弹出页、动态类名、响应式规则和阅读状态，不能只按一次截图的覆盖率删除。
