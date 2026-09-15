# 自动翻译开关与阅读连续性检查（历史）

2026-09-14，本地实现与 Chrome 验证；未发布或部署。

此页保留旧自动翻译设计的历史证据。旧开关、授权存储与验证脚本已在集群重构中移除；以下复现入口已更新为当前独立队列流程，不能据此宣称历史开关仍受支持。当前方案见 [翻译集群与队列设计](../TRANSLATION_CLUSTER_DESIGN.md)。

## 原因与调整

原实现将自动翻译授权保存在 React 内存，并绑定漫画 ID。退出阅读器、切换漫画、模式、语言、账户或服务都会调用停止函数；手动准备单页翻译同样直接关闭。普通偏好存取强制清除旧 `autoTranslate` 字段，所以刷新也不会恢复。任意提交异常、报价单价或内部配置版本变化会停用开关，提示五秒后消失。

现将已确认单价单独保存在本机 `nc-auto-consents-v1`，按账户、服务、模式、语言隔离。漫画 ID 仍用于撤销过时的准备操作，不再用于清除用户选择。离开阅读器停止新增，返回或换漫画恢复；主动关闭会删除当前组合的授权。旧偏好字段不会迁移为支出授权，升级后需确认一次。

手动翻译仅暂让出准备／提交队列。暂停保留开启状态及可见原因，不主动弹窗。临时准备故障与已明确拒绝的过期报价、配置变化、额度不足每 15 秒重试；批次内只补齐临时准备失败页。单价变化需要重新确认，同价内部配置变化按新报价继续。提交结果未知时保留原报价和幂等键，核实前不新增；核实使用相同键，成功后继续。

## 复现命令与证据

在仓库根目录运行类型检查和相关测试：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test -- tests/translation-queue.test.ts tests/classic.test.ts tests/reader-presentation.test.ts tests/file-pages.test.ts tests/concurrency.test.ts
npm --prefix apps/extension run build
```

类型检查、67 项测试及 Chrome MV3 插件构建通过。

浏览器使用新的 Chrome context、独立测试账户、临时 SQLite／对象存储。启动两个终端：

```powershell
cd backend
.venv/Scripts/python.exe tests/manual_ui_server.py
```

```powershell
cd apps/extension
npm run dev -- --port 5174
```

将服务打印的目录填入 `UI_FIXTURE_DIRECTORY`；`PLAYWRIGHT_MODULE` 指向本机已安装的 Playwright 包（若正常可解析则省略），在仓库根运行：

```powershell
$env:UI_FIXTURE_DIRECTORY='<UI_FIXTURE_DIRECTORY>'
$env:PLAYWRIGHT_MODULE='<playwright package path>'
node scripts/verify_cluster_reader.mjs
```

当前脚本检查独立模式队列、会员容量与实时名额、预存清单确认、暂停后上传、关闭页面后服务器持续消费、阅读位置与结果恢复、窄屏布局。输出 JSON 与截图写入 `artifacts/cluster-validation/`，不包含认证令牌。未知提交保留原请求与幂等键的恢复另由 `translation-queue.test.ts` 覆盖。

供应商是模拟实现，API、任务、持久化、幂等与结算使用实际后端；这轮验证不代表真实 OCR 或图片翻译效果。
