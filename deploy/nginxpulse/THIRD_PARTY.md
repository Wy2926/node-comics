# NginxPulse 部署依赖

| 组件 | 版本 | 来源与许可 | 固定摘要 |
| --- | --- | --- | --- |
| NginxPulse 官方镜像 | v1.6.24 | [源码及发布](https://github.com/likaia/nginxpulse/releases/tag/v1.6.24)、[MIT](https://github.com/likaia/nginxpulse/blob/v1.6.24/LICENSE)、[Docker Hub](https://hub.docker.com/r/magiccoders/nginxpulse) | 多架构清单 SHA-256 `92b40d49ce7e84d61b2aa4aaab1027747a6e509faafccd6d6ed6f08c5a9cb5f6` |

使用上游镜像，不复制或修改其源代码。镜像内 Nginx、PostgreSQL、ip2region 数据和前端依赖随该镜像固定，保留上游提供的许可；构成见该版本 [Dockerfile](https://github.com/likaia/nginxpulse/blob/v1.6.24/Dockerfile)、[Go 依赖](https://github.com/likaia/nginxpulse/blob/v1.6.24/go.mod)及前端锁文件。升级必须同步版本、摘要并复验代理、解析及设置保存。

地理补全采用上游 `ip-api.com` 接口，不属于管理后台 DB-IP 数据库；数据外发与部署规则见[访问统计](../../docs/OPERATIONS.md#nginx-访问统计)。
