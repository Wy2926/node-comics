# 单来源阅读验收 · 2026-09-23

状态：代码与本地构建完成，隔离浏览器验证通过；未发布商店或部署。产品范围见[单来源设计](../SIMPLE_COMIC_READING_DESIGN.md)。

## 变更

- Comic 只绑定一个固定来源，Entry 只保存当前内容；移除旧作品／单元／文档／修订／多来源关系和编辑命令。
- 删除作品管理、版本选择、资料编辑、导入归属、页面增删重排、通用网页图片选择及右键图片导入。
- 本地仅漫画容器与文档，Google Drive 仅 CBZ/ZIP；本地与云盘均拒绝散图。网站必须专门适配。
- 选择文件自动导入，单本直接阅读、多本独立入架；书架点卡片续读，来源自定义目录只读。
- 删除 363 条仅用于旧管理与导入流程的词典键，并清理旧样式、脚本和被替代设计。官网五种语言的当前功能说明同步移除散图导入与章节整理。

## 自动化

在 `apps/extension` 执行：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | TypeScript 与 188 个模块的依赖边界、循环和可达性检查通过 |
| `npm test` | 58 个文件、610 项通过；容量用例默认跳过 |
| `$env:NC_CATALOG_SCALE='1'; npm test -- tests/catalog-scale.test.ts` | 容量用例单独通过，1000 本漫画、100000 页元数据 |
| `npm run build` | Chrome MV3 构建通过 |
| `npm run build:web` | Web 构建通过 |

测试覆盖来源重复导入和并发、文件／页失败、恢复日志、删除后迟到写入、内容替换与位置复位、云盘撤权／断开、缓存持有、当前内容与翻译身份、未知网站拒绝、自定义目录树与重复引用、序列边界。原有翻译、额度及账户权限测试保留。

官网在 `backend/website` 执行 `npm run build` 通过，包括 Astro 类型检查以及 110 个静态页面的元数据、JSON-LD、本地链接和图片验证。

依赖 `node-unrar-js` 的已有缺失源码映射警告仍出现；Web 构建有大型分块提醒，不影响本轮构建结果。

## 浏览器证据

使用 Chromium 141.0.7390.37，加载实际编译的 MV3 扩展。所有脚本创建全新 profile，拦截产品 API，只使用项目自制漫画和本机站点夹具；不操作用户浏览器、旧书架或真实云盘。

| 脚本 | 本轮覆盖 |
| --- | --- |
| `verify_simple_reading.mjs` | 15 组：导入按钮直开选择器；单本自动阅读；新表结构；120 页容器、有限窗口、第 100 页位置及重启恢复；改名重复导入；混合批量中散图拒绝；PDF、MOBI、RAR4/5 解码；加密／损坏文件不留空漫画；坏页隔离且不误记已读；390px 书架／阅读器；简短菜单与移除 |
| `verify_website_source_lifecycle.mjs` | 7 组：无默认入口时显示来源自定义目录与标签，倒序和窄屏操作；专用按钮直接阅读；HTTP 图片在受管页关闭后可读；显式保存当前原图；清缓存不删主动下载；重启且来源失败仍能离线读 |
| `verify_comicpash.mjs` | 9 组：画布页面直接阅读，部分清单保持部分；排除广告；未登记页拒绝；画布变化、SPA 切换、元素移除和标签页关闭后旧句柄失效 |
| `verify_popup.mjs` | 未适配网页没有导入入口且后台消息拒绝；原位翻译、权限拒绝、页面变化校验仍正常；语言双向同步；主题与自动翻译开关检查通过 |
| `verify_drive_import.mjs`（web 模式） | 模拟 GIS／Picker 与真实 Range 读取：CBZ 选择后自动阅读、令牌复用、索引失败可见且不生成空漫画；未捕获页面异常 0 |
| `verify_source_export.mjs` | 完整源文件逐字节相等；3 页 CBZ 带清单，PDF 3 页可重新解析 |
| `verify_source_database_baseline.mjs` | 当前基线独立运行且不读取／修改残缺旧库；当前基线缺表明确报错，不静默修复 |

已人工检查宽屏／390px 书架、阅读失败和只读网站目录截图。截图与日志在被忽略的 `artifacts/simple-reading/`、`artifacts/source-architecture/`、`artifacts/comicpash-validation/`、`artifacts/popup-validation/` 和 `artifacts/single-source/`。

## 重复执行

先运行 `python scripts/generate_import_fixtures.py`，安装脚本要求的 Pillow、ReportLab 等依赖，并构建扩展。浏览器脚本依赖 Playwright 和支持加载解压扩展的 Chromium；网站／Drive 夹具额外依赖 Python cryptography。

```powershell
$env:PLAYWRIGHT_MODULE = '<playwright 模块绝对路径>'
$env:TEST_CHROMIUM = '<Chromium 可执行文件>'
$env:CHROMIUM_PATH = $env:TEST_CHROMIUM
node scripts/verify_simple_reading.mjs
node scripts/verify_website_source_lifecycle.mjs
node scripts/verify_comicpash.mjs
node scripts/verify_popup.mjs
node scripts/verify_source_export.mjs
node scripts/verify_source_database_baseline.mjs
```

Drive 测试需要构建时配置 HTTPS `VITE_DRIVE_CONNECT_URL`。脚本将地址与 Google 服务映射至本机 TLS 夹具；`TEST_DRIVE_AUTH_MODE=web` 验证模拟 GIS 路径。其他环境说明见[脚本入口](../../scripts/README.md)。

## 验证限制

本轮没有重新验证真实网站在线状态、Google OAuth 授权与长期续期、原生权限弹窗、Firefox 运行或真实翻译模型效果。新增交互文案提供简体中文与英文，其他界面语言保留键与参数一致，新增文案使用英文回退。没有修改后端任务与 R2 保留策略，也没有迁移用户旧数据。
