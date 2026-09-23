# 阅读器窗口隔离验收

日期：2026-09-22。使用合成图片与 30 章 × 120 页元数据；未读取用户漫画、调用翻译供应商或连接 Google Drive。

运行：在 `apps/extension` 执行 `npm exec vite -- --host 127.0.0.1 --port 5181 --strictPort`，打开 `http://127.0.0.1:5181/tests/reader-window-fixture.html`。该 fixture 硬性限制专用 localhost origin，使用新分用途原图缓存和实际 `Reader` 组件。浏览器为 Codex In-app Chromium 浏览器；此项不替代 Chrome / Edge / Firefox 扩展持久化验收。

已实际操作并观察页面 / 截图：

- 直接输入第 100 页，正确渲染对应页面；DOM 11 页，解码窗口 5 页。
- 第 100 页向下滚动后保存 `pageId=window-page-0-99`、`relativeOffset=0.451`；关闭并重开阅读器，实际几何测量相对位置为 `0.45055971216799606`。
- 从适应窗口切到铺满宽度，相同页内相对位置保持；更新页面尺寸后窗口仍有界。
- 从第 1 章第 120 页跨到第 2 章，再连续跨到第 30 章。每次实际操作后读取 DOM，最大章节数 3、页面节点 11、解码窗口 5；最后为 `window-page-29-0`。
- 大幅滚动直接越过未挂载占位区，定位到第 36 页并显示当前图片，DOM 仍为 11 页。
- 第 8 页模拟读取失败；错误与重试按钮可见，前后页面独立可读。验收中修复了铺满宽度时错误提示居中到首屏外的问题。
- 390 × 844 窄屏检查了失败提示、阅读工具与相邻页；切换单页模式后仅 1 章 / 1 页 DOM，仍停留第 8 页。

命令检查：`npm exec vitest run tests/i18n.test.ts tests/drive.test.ts tests/reader-window.test.ts tests/reader-view.test.ts`，41 项通过（Drive 为模拟 HTTP / 桥安全契约，不是线上 OAuth / Range 实测）。

合成样本截图：[第 100 页](../../output/source-architecture/reader-page100-desktop.png)、[失败页](../../output/source-architecture/reader-failure-desktop.png)、[390 像素窄屏](../../output/source-architecture/reader-failure-narrow.png)。截图不含用户漫画或凭据。

本验收尚未覆盖：真实扩展重启、OS 重启、Firefox 渲染、真实 Google OAuth、多账户授权与云盘版本变化。真实源文件与主应用导入闭环由主任务的独立验收记录覆盖。

本轮新界面文案继续通过 16 语言字典交付：新增键提供简体中文与英语，其余语言对这些新键暂用英语；旧键的已有翻译保留。新增非英语翻译尚未经人工复核，不声明完整本地化验收。字典键与插值占位符一致性测试通过。
