# NodeLane 漫译 · NodeLane Comics

带漫画阅读器的 Chrome / Edge Manifest V3 浏览器插件。支持本地未加密 MOBI、CBZ/ZIP、CBR/RAR、PDF 与专门适配的网站漫画；云盘支持 CBZ/ZIP。一本漫画一个来源，不支持散图导入；通用网页可使用原位翻译。

常规翻译由 [classic-engine](services/classic-engine/README.md) 完成检测、OCR、抹字和嵌字，具体模型与运行要求在引擎文档维护，文本 LLM 由中心调用；AI 重绘使用兼容 `POST /v1/images/edits` 的图片供应商。原图与译图保存在私有 R2，任务由后端持久化管理，供应商密钥不进入插件。

新漫画默认原图，用户选择翻译后自动处理当前页与后三页。普通／PLUS 每滚动 60 秒最多新增 10／100 张翻译图片；会员页数与赠送规则见[会员设计](docs/MEMBERSHIP_AND_QUOTAS.md)。客户端不显示翻译队列或批量预存。

## 开发与验证

当前后端只支持 `payments_0001` 全新空库，不升级旧数据库。部署记录与当前源码分开维护；[VPS 记录](docs/VPS_DEPLOYMENT.md)不代表最新代码已上线。

- [后端运行与 Docker 隔离测试](backend/README.md)：根 `.env` 配置、`scripts/bootstrap.ps1 -Start`、控制进程与数据库。
- [五语官网与账户](backend/website/README.md)：静态 SEO 页面、独立语言字典、同域 API 与 OIDC 登录、商店链接配置。
- [插件运行与构建](apps/extension/README.md)：Node.js 22.23+、npm、浏览器夹具和扩展加载。
- [计算节点安装](services/classic-engine/README.md)：独立模型、字体、Vulkan 与节点身份。根 Compose 只启动控制服务，常规翻译默认关闭。
- [脚本入口](scripts/README.md)：运维、验证与样本工具的依赖及用途。

本地控制 API 默认为 `http://127.0.0.1:18088`；插件产品服务固定在 `apps/extension/src/service.ts`，运行本地网页预览不会自动切换到本地 API。交互检查使用隔离夹具。

## 文档导航

| 范围 | 入口 |
| --- | --- |
| 产品与界面 | [产品设计](docs/PRODUCT_DESIGN.md)、[品牌与商店文案](docs/BRAND_AND_STORE_LISTING.md)、[界面国际化](docs/UI_INTERNATIONALIZATION.md)、[共享主题](docs/POPUP_AND_THEME.md) |
| 阅读与翻译 | [阅读计划契约](docs/READING_TRANSLATION_CONTRACT.md)、[网页内翻译](docs/IN_PAGE_TRANSLATION.md)、[语言支持](docs/NODE_CONFIGURATION.md#目标语言与节点能力)、[译图共享](docs/RESULT_SHARING.md) |
| 漫画与直接阅读 | [单来源简化设计](docs/SIMPLE_COMIC_READING_DESIGN.md)、[来源与缓存架构](docs/COMIC_SOURCE_ARCHITECTURE.md)、[格式与缓存](docs/IMPORT_FORMATS_AND_CACHE.md) |
| 网站适配开发 | [精简规范与站点入口](docs/SITE_ADAPTERS.md) |
| 服务端 | [架构](docs/ARCHITECTURE.md)、[集群调度](docs/TRANSLATION_CLUSTER_DESIGN.md)、[计算协议](docs/COMPUTE_PROTOCOL.md)、[节点配置](docs/NODE_CONFIGURATION.md) |
| 管理与运营 | [管理后台](docs/ADMIN_CONSOLE.md)、[系统设置](docs/SYSTEM_SETTINGS.md)、[文本供应商](docs/TRANSLATION_PROVIDERS.md)、[会员与额度](docs/MEMBERSHIP_AND_QUOTAS.md) |
| 身份与部署 | [生产身份](docs/PRODUCTION_IDENTITY.md)、[对象存储](docs/OBJECT_STORAGE.md)、[运维与恢复](docs/OPERATIONS.md)、[VPS 部署记录](docs/VPS_DEPLOYMENT.md) |
| 研发依据 | [AI 图片与格式验证](docs/TECH_RESEARCH.md)、[常规翻译选型](docs/CLASSIC_TRANSLATION_RESEARCH.md)、[代码维护](docs/CODE_QUALITY.md)、[API 契约](contracts/README.md) |
| 支付 | [Stripe／Creem 多渠道支付、产品价格与订单](docs/STRIPE_BILLING.md) |

用户漫画、凭据及运行产物不入库；公开示例仅使用项目生成的原创图片。长期云书架、长图分段和其他电子书格式仍属后续范围。
