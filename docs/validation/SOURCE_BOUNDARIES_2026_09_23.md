# 来源边界修正验收（2026-09-23）

## 实现

- `ComicSites.tsx` 保留为所有网站共用的目录 UI，只经 `sources` 公共入口消费注册元数据。没有引用具体站点组件。链接导入由应用服务处理；UI 不判断网络通道、不读取安装权限。
- 页面服务调用 `readSourceImage`，只传来源引用并接收 Blob。清单核验、域名授权、请求头及图片解码留在来源模块。
- 网络目录、网络页清单和图片解码独立注册。支持 HTTP 目录配 DOM 阅读页、DOM 目录配 HTTP 阅读页及独立解码能力；删除 Comix 的空 `page.ts`。
- HTTP 和 DOM 清单共用页校验和清单登记。持久清单的 `pageContext` 仅保存真实页面上下文，网络清单没有负标签页 ID 或虚假导航。
- 图片请求头规则只匹配精确 URL；同 URL 的扩展图片读取通过 Web Lock 串行，包括无特殊头的读取。读完、失败或取消后清理规则，后台恢复不会清理活跃读取持有的规则。
- 用户导入、当前页导入和自动同步都以书库已接受的目录作为 `previous`。被代次或租约检查拒绝的刷新不会改变后续上传选择；网络目录读取不再写入影子目录。
- 模块检查禁止 App、UI 和漫画应用／页面服务绕过 `sources` 公共入口直接引用其运行时或注册表。

## 本轮证据

在 `apps/extension` 执行：

- `npm run check`：类型及 208 个模块的边界、循环和可达性检查通过。
- `npm test`：64 个测试文件通过、1 个跳过；676 项通过、1 项跳过。已有 `node-unrar-js` 缺失 sourcemap 警告，不影响测试结果。
- `npm run build`：Chrome MV3 构建通过。
- `git diff --check`：通过。

新增 `source-operation-runtime.test.ts` 覆盖混合发现通道、统一校验、真实页面上下文、读取无提交副作用、授权时序和取图门面。Comix 测试验证刷新被书库拒绝后，下一次读取仍保留原先已接受的上传选择。

隔离 Chromium 的 `verify-boundaries.mjs` 通过 7 项检查：公共目录错误展示、链接导入与读图、缓存重开、跨扩展页面同 URL 的不同 Referer／普通请求隔离、同主机不同 URL 的隔离、取消释放、请求页面关闭后的遗留规则恢复。站点响应使用样本；请求头验证使用真实本地 HTTP 服务及浏览器 DNR/Web Locks，非模拟规则匹配。已查看目录页和阅读器截图。首次产物：`artifacts/source-boundaries/run-2VM1aP/`；提交前清理后的复测产物：`artifacts/source-boundaries/run-ZMrc1K/`。

`scripts/verify_comicpash.mjs` 的隔离画布回归通过 9 项检查，包含部分清单、直接阅读、延迟渲染、重绘、SPA 离开再返回、元素移除和来源标签页关闭。产物：`artifacts/comicpash-validation/fixture-ARAJOx/`。

真实 Comix 复测未完成：源站请求返回 HTTP 522，目录页展示来源请求失败，未达到读图验收。本站 README 中此前真实网站验收记录仍属于此前执行，不能计入本轮结果。本轮不涉及真实翻译模型；未验证原生权限弹窗和 Firefox 实机。

提交前移除旧构建故障复现模式、未使用的权限常量、测试请求记录及重复页资源校验；保留当前构建的阅读器、图片协议和请求隔离回归。清理后重新通过类型／边界检查、676 项测试、Chrome MV3 构建及上述 7 项浏览器检查。

## 复现

先构建 Chrome MV3；以下脚本从仓库根目录执行，设置 `PLAYWRIGHT_MODULE` 指向本机 Playwright 模块，`TEST_CHROMIUM`／`CHROMIUM_PATH` 指向支持加载扩展的 Chromium：

```powershell
node apps/extension/src/sources/sites/comix/tests/verify-boundaries.mjs
node scripts/verify_comicpash.mjs
```

这些脚本只创建临时扩展副本、隔离浏览器资料和忽略目录中的产物，预授予测试域名权限，不使用个人浏览器资料。请求头回归在本地临时端口启动 HTTP 服务，结束后关闭。
