# 网站适配开发规范

新增或修复网站从本文开始。产品边界见[单来源阅读](SIMPLE_COMIC_READING_DESIGN.md)，类型以 [sources/contracts](../apps/extension/src/sources/contracts) 为准；站点规则和验证限制放在各站自己的 README，不复制公共契约。

## 最小目录与接入

在 `apps/extension/src/sources/sites/<id>/` 添加文件，注册表按统一通配约定静态收集，无需手工注册具体站点：

| 文件 | 职责 |
| --- | --- |
| `definition.ts`（必需） | 导出 `definition`：与目录名一致且唯一的稳定 ID、纯 URL 识别、能力、可选目录同步与网站入口元数据 |
| `installation.json`（必需） | 安装权限与可选来源；由定义引用，构建工具直接读取 |
| `page.ts`（按需） | 导出 `createPage`：DOM／canvas 会话、发现、显示目标、观察与清理 |
| `network.ts`（按需） | 导出 `network`：独立可选的 `catalog`、`pages` HTTP 解析操作 |
| `image.ts`（按需） | 导出 `image`：图片请求头或解码；不依赖是否实现网络目录 |
| `icon.svg`、`README.md`、`tests/` | 本地图标、支持范围与证据、脱敏夹具和站点测试 |

先检查真实站点的目录、页序、懒加载、图片与权限，再声明能力。选择 DOM、HTTP 或混合通道；纯网络站点不创建空 `page.ts`。公共接口缺少必要能力时修改契约及通用实现，不向核心添加站点分支。

## 必须保持的约束

1. **站点隔离。** 域名、路径、选择器、特殊观察属性、协议与分类规则只在本站目录；站点之间不互相导入。复用无站点语义的 `shared/` 工具，不调用整个 `generic` 作隐式兜底。
2. **依赖方向。** 站点只依赖自身、`contracts/`、`shared/` 和现有 i18n；不调用 `chrome.*`／`browser.*`，不导入 UI、漫画仓储、缓存、翻译或来源运行时。`definition.ts` 的传递依赖不访问 DOM、浏览器全局或 CSS。
3. **公共入口。** UI、漫画应用与页面服务使用 `sources/index.ts`；内容脚本使用 `sources/page.ts`。公共层负责权限、网络、消息、标签页、清单登记和生命周期，注册表不得直接引用具体站点文件。
4. **明确认领。** 先校验 HTTP(S) URL，再精确核对主机、路径与资源归属。一个站点匹配才使用；冲突报错。未知站点仅用通用原位翻译，不能导入漫画。已认领站点等待、失败或能力缺失时不退回通用规则或另一读取通道。
5. **稳定身份与只读目录。** 身份包含来源命名空间，不按标题或临时 CDN 地址去重；保留必要的查询参数与片段，镜像等价须有证据。条目、分组、原始标签和可选阅读序列来自源站；不推断章节类型、正文归属或跨组连续阅读。目录更新只使用调用方给出的 `previous`，不另存已选上传状态。
6. **发现不等于取图。** 返回稳定页槽和来源顺序，重复 URL 可以是不同页；缺页不重编号。`ready / not-ready / unsupported / error` 与清单完整性分开；只有可靠总数、完整列表或单页契约能证明完整，canvas 窗口和暂时不增长不能。
7. **临时资源受控。** 站点给出 HTTP 地址或页面逻辑资源，公共层登记后才能读取。句柄绑定文档、导航、元素和版本，不能持久化为离线原图。导航、替换、画布重绘、取消与销毁后拒绝旧读取，清理观察器、挂载入口和译图；`pageshow` 重建会话而不复用旧句柄。
8. **权限与数据。** 新站默认 `requiredOrigins`、`autoContentMatches` 为空，按用户操作申请必要的可选主机权限；不能因注册扩大安装权限。需嵌入网站入口时声明 `optionalContentMatches`，公共运行时仅在主机授权后登记内容脚本，并在撤销后取消登记。页面文字、HTML、URL 均不可信，不执行下载的源站脚本，不上传 Cookie／令牌，不记录私有图片、全文或签名地址。请求头与图片解码经公共取图接口处理，不直接修改全局网络规则。
9. **按能力开放。** 漫画导入须声明 `importable` 和页面能力；目录、原位翻译、完整页清单、自动同步分别声明并有实现。`catalogSync` 仅在能可靠读取完整目录时开放；调度、更新提示、缓存与阅读位置由公共应用层维护。网站入口使用 `sites` 元数据和随包图标，UI 不加专属组件。

公共执行边界以 [resolve.ts](../apps/extension/src/sources/core/resolve.ts)、[catalog.ts](../apps/extension/src/sources/core/catalog.ts)、[resources.ts](../apps/extension/src/sources/core/resources.ts) 和 [runtime](../apps/extension/src/sources/runtime) 为准。HTTP 与 DOM 清单共用校验；`readSourceImage` 只向页面服务交付 Blob。精确图片 URL 的请求头由公共层以 Web Lock 隔离，完成或取消后释放。资源大小、超时和缓存预算不由站点绕过。

HTTP 图片共用 `runtime/image-fetch.ts`：原位翻译由后台请求，阅读器由受信扩展页面请求，均先检查实际图片域名权限，再根据已校验的来源页生成 Referer。原位入口传递图片属性／meta 中的显式引用策略，缺省为 `strict-origin-when-cross-origin`；仅 HTTP 响应头声明的页面策略未回溯读取。站点 `image.headers` 只覆盖必要差异，不再为普通来源 Referer 增加专用适配。Blob／Data／Canvas 保留页面读取与导航版本校验。

原位正文筛选由 `inlineTargets()` 负责：未知站点的大图启发式只在 `generic` 适配器执行，显示层统一检查渲染状态。消息中的尺寸与来源能力由公共来源入口校验，翻译协议不解析站点。浏览器原位回归按 `sites/*/tests/verify-inline.mjs` 自动发现，各站导出 `verifyInline(context)`，站点专用开关与断言留在本站。

目录可选提供 `cover`，必须取自作品专门封面，不能使用推荐图或章节缩略图。`readSourceCover` 校验目录归属、HTTP(S) 地址与主机权限，经公共取图管线读取；防盗链规则不同时使用 `image.coverHeaders`。新增 CDN 只申请可选权限。封面不进入正文、翻译或下载清单，缩略图沿用缓存预算与访问失效规则；换封面不触发章节更新徽章。展示行为见[单来源阅读设计](SIMPLE_COMIC_READING_DESIGN.md)。

公共层使用 `webRequest` 在当前请求期间观察扩展自身精确 URL 的重定向响应头，配合 `fetch` 手动跳转，最多跟随 5 次；每跳检查权限与 URL，跨来源不转发站点请求头，重新生成来源 Referer。读取完成、失败或取消后移除监听与会话规则；不增加 debugger／页面捕获权限，不代理上传 Cookie。实现依据和验证边界见[跨域取图调研](PAGE_IMAGE_ACCESS_RESEARCH.md)。

## 验收与交付

在 `apps/extension` 执行：

```powershell
npm run check
npm test
npm run build
```

`check` 包含类型和[模块边界检查](../apps/extension/scripts/check-modules.mjs)。测试至少覆盖 URL／伪造主机／资源归属、能力与安装元数据一致性、页序与重复 URL、部分／完整清单、取消及失效读取；有目录则覆盖重复条目、分组引用、更新和失败保留旧目录。源码类型与字段以契约为准，文档不维护第二份接口声明。

在桌面目标浏览器加载构建产物，实际完成导入 → 取图／解码 → 阅读 → 重开恢复，检查错误提示与阅读位置。按能力补测原位译图恢复、canvas 重绘／SPA 导航或无标签页网络读取；仅下载成功不能代替完整阅读器验收。

通用夹具、环境和启动顺序见[脚本入口](../scripts/README.md)。站点 README 只保留支持的 URL／能力、协议或依赖来源、可复现命令，以及带日期的真实验证摘要和未验证范围。区分隔离样本、真实站点、原生授权弹窗与模型翻译效果；不保留每次测试总数和临时服务地址。

2026-09-24 封面验收：隔离 Chromium 中，MangaCopy grandblue、Comix rrzm、DM5 妖神记、NAVER 758037、Comic PASH 1fafeeae328df 均在未读取章节时显示真实封面。合成样本覆盖缓存、失败重试、封面更新与阅读位置恢复；权限恢复使用模拟响应，原生弹窗未验。复现入口见[脚本说明](../scripts/README.md)。

## 现有站点

| 适配器 | 能力与说明 |
| --- | --- |
| [MangaCopy](../apps/extension/src/sources/sites/mangacopy/README.md) | DOM 目录与 HTTP 图片；动态只读分类、完整性核对、12 小时目录同步 |
| [Comix](../apps/extension/src/sources/sites/comix/README.md) | HTTP 目录／章节、图片还原、12 小时目录同步；已加载正文图片／还原画布的原位翻译，授权后在详情页与章节页嵌入导入／管理入口 |
| [动漫屋 DM5](../apps/extension/src/sources/sites/dm5/README.md) | HTTP 完整目录／章节图片、12 小时更新；授权后嵌入导入／管理按钮，章节 Referer；网页正文图片原位翻译 |
| [NAVER Webtoon](../apps/extension/src/sources/sites/naver/README.md) | Webtoon／Best Challenge／Challenge 的 HTTP 目录与图片、12 小时更新；授权后嵌入导入／管理入口；网页正文切片原位翻译 |
| [Comic PASH](../apps/extension/src/sources/sites/comicpash/README.md) | HTTP 完整分页目录／章节、图片还原、12 小时更新；授权后嵌入作品导入入口；网页已渲染 canvas 原位翻译 |
| `generic` | 已加载图片的原位翻译；不提供漫画导入或整章完整性承诺 |
