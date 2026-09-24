# 官网独立部署

此次交付只更新 `backend/website` 的静态构建。官网使用现有 API 的静态文件服务，保留其 CSP、私有路由、登录、安装包下载和缓存规则。

## 部署前确认

1. 在目标服务器读取 OpenResty 中 `comics.nodelane.net` 的实际配置，核实 upstream 和 API 容器。2026-09-24 检查结果为 `127.0.0.1:18088`，由 `node-comics-production-api-1` 提供，文件位于容器 `/app/app/website_dist`，没有独立静态目录挂载。
2. 从实际运行容器核对安装包目录，并实际下载公开 ZIP 比较版本、字节数和 SHA-256。此次同步的是已经发布的 0.2.0 元数据，不重新发布安装包。
3. 执行 `npm test --prefix backend/website`、`npm run build --prefix backend/website`。记录 Git 提交及构建文件清单和哈希，上传构建产物，不上传开发夹具或本机环境文件。

## 更新与回滚

- 运行目录：`/opt/nodelane/node-comics`。实际 Compose 文件为 `compose.server.yaml`，Compose 插值来自 `.env`；应用配置由 `.env.server` 提供。
- 部署前备份当前官网、Compose 和 `.env`，备份目录仅 root 可读。记录 API 原镜像、容器 ID 与两个 worker 的容器 ID。
- 在服务器以当前运行 API 的精确镜像为基础创建本地派生镜像，仅替换 `app/website_dist`，保留生产后端代码、安装包目录和管理后台。新镜像带本次 Git 提交标签，无需推送镜像仓库。
- 确认 API 仍是检查时的实例后，只更新 `.env` 中的 `API_IMAGE`，运行 `docker compose --env-file .env -p node-comics-production -f compose.server.yaml up -d --no-deps --pull never api`。不重建 control-worker、maintenance，不执行数据库迁移。
- 若启动或就绪检查失败，恢复备份中的 `.env`，以相同命令重建 API，使其回到原镜像。旧镜像和备份保留以便回滚。

## 上线验收

核对容器中的构建文件哈希、主页新内容、安装包入口、API 就绪和 worker 容器 ID；再检查公开五语页面及其资源，并在浏览器实际切换截图、放大关闭和翻译对照。HTML 可能经过 Cloudflare 注入，公开验收以内容、响应、资源和交互为准，不能只比较整份 HTML 哈希。

本机部署包、SSH 临时脚本和验收结果保留在被忽略的 `artifacts/marketing/2026-09-24/`；生产连接凭据不进入仓库。部署结果与当前 Git 提交分别报告。
