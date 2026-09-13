# 本地实现与验证

2026-09-13。本次交付为可以本地运行的浏览器插件、阅读器和 AI 图片翻译后端。只有 AI 图片翻译；取消的处理管线源码、容器、镜像和相关设计内容已移除。

## 启动与使用

需要 Docker Desktop（Linux 容器）、Node.js 22 和 npm。仓库根目录 `.env` 配置图片供应商，参考 [.env.example](../.env.example)。不要将 Key 放入 `VITE_*` 或插件文件。

```powershell
./scripts/bootstrap.ps1 -Start
cd apps/extension
npm ci
npm run dev
```

打开 [阅读器](http://127.0.0.1:5173/)；[API 文档](http://127.0.0.1:18088/docs)。导入漫画或打开原创示例即可阅读。按“连接翻译账户”使用本地测试账号，选择语言、页码范围，再确认预计点数。默认每账号 100 测试点、每个成功版本 8 点；与正式价格无关。开发用户名 `admin` 可进入运营管理。

普通点击不会自动翻译。可选“边读边译”需要确认本次预算，窗口为当前页和后 2 页，默认本次最多 10 页；关闭后停止创建新任务。已确认并上传的任务由后端继续。主动生成新版本需要重新确认报价；结果待核实任务还需确认可能的额外消耗。

浏览器的 `localhost`、`127.0.0.1` 和扩展页面是不同来源，拥有各自本地书架。请固定使用同一入口。译图与原图可随时对照，阅读器支持页码跳转、单页/连续阅读、方向、缩放、范围排序和单图导出。

## 构建与测试

```powershell
cd apps/extension
npm run check
npm test
npm run build
npm run build:web
npm run zip
```

Chrome / Edge 在扩展管理页打开开发者模式，加载 `apps/extension/.output/chrome-mv3`。压缩包位于同级 `.output`。浏览器预览用于本地导入；当前网页发现与图片右键需要安装扩展。

后端运行命令、配置和独立 PostgreSQL 并发测试入口见 [backend/README.md](../backend/README.md)。轻量 API 检查（需要 Python、httpx、Pillow）与真实 MOBI 解析检查：

```powershell
python scripts/smoke_api.py
node --experimental-strip-types scripts/inspect_mobi.mjs
```

`smoke_api.py --translate --wait` 会创建一次真实图片模型请求并保存操作 ID；后续运行核对相同任务，不盲目创建新付费请求。已有本次待核实记录，不要通过删除证据文件规避这个保护。

Compose 后续操作必须同时加载两个环境文件：

```powershell
docker compose --env-file .env --env-file deploy/.env.local ps
docker compose --env-file .env --env-file deploy/.env.local up -d --build
docker compose --env-file .env --env-file deploy/.env.local down
```

`deploy/.env.local` 由引导脚本产生本地数据库和签名密钥，已忽略。`down` 保留数据卷。API 只绑定 `127.0.0.1:18088`；数据库、Redis 无宿主机公开端口。不要在模型调用进行中强制重启 worker。

## 已获得的证据

| 项目 | 证据与边界 |
| --- | --- |
| 页面风格 | Chrome 实际运行，桌面书架和原创阅读页截图见下方；粉蓝色、漫画插画与紧凑阅读工具 |
| MOBI | 用户提供 221,624,973 字节样本，正文 194 页（193 JPEG + 1 GIF），按正文顺序提取；[解析记录](evidence/mobi-import.json) |
| 百页阅读 | Chrome 第 100 页实际显示，重开恢复到第 100 页，仅加载第 98–102 页共 5 张图片；194 页其余位置占位。修复后台任务与其他标签页覆盖进度的问题。私有漫画截图保存在被忽略的 `private-test-data/` |
| 窄屏阅读 | Chrome 390×844 截图已复核，工具栏默认折叠、导航保留无障碍名称，文档宽度 390；[截图](evidence/reader-mobile.png) |
| 真实图片模型 | `.env` 图片供应商、`gpt-image-2`、`POST /images/edits` multipart；已有用户触发的中译与英译任务完成，授权下载和完整解码通过；[脱敏交付记录](evidence/live-delivered.json) |
| 已知不确定请求 | 首次原创样本请求返回 `outcome_unknown`，未自动重发；[记录](evidence/live-redraw.json)。供应商可能已产生费用，用户预占与供应商消耗分别记录 |
| 后端契约与并发 | 48 项临时 SQLite / 模拟上游测试通过，另有真实 PostgreSQL 的 5 项隔离并发测试通过。默认测试命令明确跳过需要独立入口的 PostgreSQL 测试 |
| 前端测试与构建 | 27 项测试、TypeScript、扩展和 Web 构建、ZIP 全部通过；[模块验证记录](evidence/frontend-validation.md)。生产依赖审计 0；开发工具链仍有 3 项 high，不进入扩展运行包 |
| 身份 | OIDC/PKCE、回调防重放和服务来源绑定有模拟测试；真实身份服务未配置联调 |

封面原图 1066×1600，译图 1024×1536。视觉检查确认主标题可读、人物构图基本保持，部分线条、字体与专名表达有变化。按用户最新决定，不增加底部标记、作者署名或专名必须保留的约束，继续使用原提示词 `comics-translate-v1`。这次样本不能证明整卷或所有语言的质量。

![桌面书架](evidence/library-desktop.png)

![桌面阅读](evidence/reader-desktop.png)

## 交付边界

- 插件可以构建和打包；Chrome 网页阅读器已实际验收。加载解压扩展后的真实站点采集尚未人工完成，不能将浏览器预览等同于已安装插件验收。站点适配与消息权限有本地契约验证。
- `.env` 的默认图片网关在使用常规 Python User-Agent 时曾返回 403；本地通过供应商可配置 `user_agent=Mozilla/5.0` 接通。该配置不代表任意兼容网关都需要它。
- 公网 OIDC、HTTPS、正式价格、支付、站点覆盖和发布仍未完成，也没有公开部署或 Git 提交。当前目录未初始化 Git。
- MOBI 首版支持未加密 MOBI6 / MOBI6+KF8 漫画，独立 KF8、EPUB、PDF、CBZ/CBR、长图切片与整卷打包导出属于后续范围。
- 自动审批拒绝了 `engines/` 下载缓存的递归删除（返回 `blocked by policy`）。源码和运行组件已移除，残余缓存已忽略且不参与构建；没有绕过删除限制。

原创发布样例的来源与生成提示见 [samples/README.md](../samples/README.md)。私有漫画、提取图片和凭据不包含在插件产物中。
