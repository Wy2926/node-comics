# 后台国家解析依赖

| 组件 | 版本 | 来源与许可 | 发布包摘要 |
| --- | --- | --- | --- |
| maxminddb | 3.2.0 | [MaxMind Python Reader](https://github.com/maxmind/MaxMind-DB-Reader-python)，[Apache-2.0](https://github.com/maxmind/MaxMind-DB-Reader-python/blob/v3.2.0/LICENSE)；[PyPI 源包](https://files.pythonhosted.org/packages/b9/34/0923a42cce579398890058775ea145214acf80dd3340c26cfb0f16989300/maxminddb-3.2.0.tar.gz) | SHA-256 `d28e0073fd1dd637c8b95947bc864b5625eca9f8f2db1538145e33b2a1cd4b92` |

使用本地 MMDB，不调用 MaxMind 在线服务。生产复用已有 DB-IP Lite City，来源、月份、SHA-256 与 CC BY 4.0 许可由 `scripts/traffic.py geoip` 写入部署目录的 `sources.json`；数据库不进仓库。前端依赖版本、来源与完整性由 [package-lock.json](admin-ui/package-lock.json) 固定，许可说明见[管理后台](../docs/ADMIN_CONSOLE.md#前端依赖)。
