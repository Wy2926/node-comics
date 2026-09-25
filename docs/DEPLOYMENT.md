# 构建与部署

部署输入为当前源码、锁文件和环境配置。公开服务使用私有 R2、OIDC 和 `translations_0001` 数据库基线；安装与运行入口见[后端](../backend/README.md)、[插件](../apps/extension/README.md)及[计算节点](../services/compute-node/README.md)。

## 控制服务与官网

1. 核对目标服务、数据库、镜像和代理配置，按[运维规范](OPERATIONS.md)备份。首次部署准备专用空库；数据库不兼容时先确定数据处置，不能以镜像回退代替数据库恢复。
2. 以 `backend/Dockerfile` 构建新的版本标签；镜像同时包含 API、官网和管理后台。保留原标签以便回退。
3. 使用 [compose.server.yaml](../deploy/compose.server.yaml)：`.env` 提供 `SERVER_IMAGE`、端口和网络；`.env.server` 提供应用配置，模板见 [环境示例](../deploy/.env.server.example)。配置文件限运行账号读取。
4. 在部署目录执行：

```sh
docker compose --env-file .env -f compose.server.yaml config --quiet
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps api python -m app.config --production
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps api python -c 'from app.db import initialize; initialize()'
docker compose --env-file .env -f compose.server.yaml up -d
docker compose --env-file .env -f compose.server.yaml ps
curl --fail https://comics.nodelane.net/health/ready
```

反向代理使用 [OpenResty 模板](../deploy/openresty.comics.conf)，保留 API／私有后台路由优先级、缓存和 CSP；关闭图片磁盘缓冲与包含授权参数的访问日志。OIDC 回调配置见[身份规范](PRODUCTION_IDENTITY.md)。

官网纯静态更新仍由 API 镜像中的 `app/website_dist` 提供。若单独更新官网，以实际运行 API 镜像为基础，仅替换该目录并保留后端、安装包目录与后台；核对目标 Compose 后只重建 API。失败时恢复原镜像配置。公开 HTML 可能被 CDN 注入，验收使用内容、资源与交互，不只比较 HTML 哈希。

## 插件安装包

1. 在 `apps/extension` 设置正式 `VITE_API_BASE`、`VITE_DRIVE_CONNECT_URL`，更新版本并完成 `npm run check`、`npm test`。
2. 分别生成 Chrome／Edge 手动安装包与无 `manifest.key` 的商店包。Firefox 审核包运行 `npx --no-install web-ext lint --source-dir .output/firefox-mv3`；公开下载使用 AMO 已签名 XPI。
3. 在 [extension-release.json](../backend/extension-release.json) 追加平台、版本、文件名、大小和 SHA-256；保留已有下载地址，更新 `current` 与 `current_by_browser` 中各浏览器已就绪的版本。Firefox 新版尚未取得 AMO 签名时，保留其上一已签名版本并在更新日志中说明。
4. 使用后端 Python 依赖并注入目标 R2 配置，从仓库根目录运行：

```powershell
python scripts/upload_extension_release.py --browser <chrome|edge|firefox> --zip <安装包路径> --manifest backend/extension-release.json
```

脚本核验包身份及正式 API，Firefox 另核对 AMO 官方摘要与签名；上传不可覆盖并回读核对哈希。重新部署后端与官网以更新下载目录。商店提交包不放入手动下载目录。

## 上线检查

- 核对镜像、数据库、控制进程、节点版本与心跳，确认 `/health/ready`。
- 实际完成 OIDC 登录、R2 授权读写、插件阅读与翻译；支付按配置渠道独立验证。R2 公开入口应关闭。
- 检查五语页面、商店入口与平台下载。设置 `WEBSITE_PREVIEW_URL` 后运行 `node scripts/verify_website_download.mjs`，核对包文件名、大小与摘要。
- 运行记录保存在部署环境或忽略的产物目录；仓库文档只维护流程。
