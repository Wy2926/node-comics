# 漫画网站目录与匿名反馈（2026-09-23）

## 交付范围

- 插件顶部导航新增独立 `#sites` 页面。网站卡片沿用漫画描边、纸片阴影、主题色与语义变量，收紧到 36 px 图标和 16 px 内边距；网格根据可用宽度容纳至少 200 px 宽的卡片。
- `SourceDefinition.sites` 由每个适配器声明 0–N 个 `{id, name, url, icon}` 入口，目录层统一展平；页面不按适配器 ID 写分支。MangaCopy 提供 copy4000 与 mangacopy 两个入口，其余三个适配器各提供一个。通用网页图片适配器不列入目录。
- 图标为本项目制作的字母标识 SVG，位于插件 `public/site-icons`，不是第三方官方商标素材。由适配器指定本地资源路径，随插件打包，打开目录不请求外部 favicon 服务；图标失败时显示通用网站图标。
- 网站申请直接在页面提交。设置按钮左侧新增通用插件反馈弹窗。两者无需登录，都可选填任意格式的联系方式，后台分开展示；不公开展示联系方式。
- 新文案覆盖已有 16 种界面语言。

## 接口与数据

- `POST /v1/support-requests`：匿名，必填 UUID `Idempotency-Key`；正文包含 `kind: website | plugin`、`site_name`、`url`、`comment`、`contact`。
- 网站申请必须有网站名称和 HTTP/HTTPS 公开地址；插件反馈必须有正文。网站名称最多 100 字符、网址 2048、说明 1000、联系方式 200；联系方式不限定邮箱格式。网站地址拒绝凭据及本地地址，去除 query/fragment；服务端只存储，不抓取申请网址。
- 成功仅返回 `id` 与 `created_at`。重复请求不重复保存，重用编号但更改内容返回 409。页面在发送前保存本标签页草稿与编号；未知结果冻结原正文，重试核实；已知拒绝允许修正。使用独立匿名客户端，不受账户登录、到期或切换影响。
- `GET /v1/admin/support-requests?kind=website|plugin&offset=0&limit=25`：仅管理员可读取，返回正文、选填联系方式与回执编号；分页按时间和 ID 倒序。
- 两种反馈共享匿名入口限流：ASGI 对端地址的摘要对应持久受理记录，每 60 秒最多新增 5 条、每 UTC 日 20 条；重放不消耗次数。429 返回 `Retry-After`。不信任请求自行提供的转发头；反向代理客户端地址由服务器的可信代理配置决定。超过两天的受理计数可清理，反馈记录持续保留。
- 请求体限制 16 KiB。联系方式、正文和原始网络地址不写应用日志；公开响应不包含反馈内容。
- 数据表 `support_requests`、`support_request_admissions` 纳入空库初始基线；按项目约束不提供旧库迁移或兼容接口。

## 验证

- 插件：`npm run check`；`npm test -- tests/i18n.test.ts tests/site-directory.test.ts`（8 项）；`npm run build`（Chrome MV3，含本地图标）。
- 管理后台：`npm run build`。
- 后端：`.venv/Scripts/python.exe -m pytest -q tests/test_support_requests.py tests/test_request_limits_migration.py`（17 项）。覆盖匿名受理、任意联系方式、分类隔离、管理员权限、分页、输入和体积校验、限流恢复、幂等重放及并发重复提交、初始结构与 ORM 一致性。
- 本地浏览器检查了目录卡片、导航、反馈弹窗、网站申请、任意联系方式、响应丢失后关闭再打开保留原草稿、重试成功、后台读取与重放去重。网站申请后台为 1 条，插件反馈测试两次不同正文为 2 条，均与回执一致。
- 此轮为本地代码、构建和隔离 SQLite / 浏览器验收；未调用图片模型、未测试源站可用性、未验证 PostgreSQL 并发、未公开部署。

## 复现隔离界面

先安装 `backend/requirements.txt` 并构建管理后台，然后分别运行：

```powershell
# backend 目录；临时数据库与测试身份，不读取 .env，不连接外部服务
.venv/Scripts/python.exe tests/support_preview.py --lose-first-response

# apps/extension 目录；环境变量只用于当前预览命令
$env:VITE_API_BASE='http://127.0.0.1:18089'
npm run dev -- --port 5191
```

访问 `http://127.0.0.1:5191/#sites`；后台为 `http://127.0.0.1:18089/console-fixture/`，隔离开发用户名 `admin`。`--lose-first-response` 会在每个新请求已提交事务后丢弃首次成功响应，供重试验收；不传该参数则正常返回。停止测试服务后临时目录由 fixture 清理。正式构建前清除当前 shell 的 `VITE_API_BASE`。
