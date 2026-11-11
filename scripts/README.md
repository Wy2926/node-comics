# 辅助脚本

从仓库根目录运行；脚本参数与默认端口见文件。测试产物写入 `artifacts/` 或 `output/playwright/`。

| 入口 | 用途 |
| --- | --- |
| `generate_import_fixtures.py` | 自制导入样本；需 Pillow、ReportLab |
| `verify_simple_reading.mjs` | MV3 导入、阅读与重启恢复 |
| `verify_reader_*.mjs` | 阅读器夹具、位置与图片窗口 |
| `verify_translation_*.mjs` | 渠道、字体、语言与结果 |
| `verify_*source*.mjs`、`verify_comic_search.mjs` | 来源与搜索 |
| `prepare_*translation_fonts.py` | 按本地固定清单生成字体描述和预览 |
| `prepare_*screenshots.mjs` | 商店图片排版；先在本目录 `npm ci` |

浏览器脚本使用 `PLAYWRIGHT_MODULE` 指向已安装的 Playwright，`TEST_CHROMIUM` 或 `CHROMIUM_PATH` 指定浏览器。MV3 测试先构建插件，网页夹具先启动对应 Vite 配置。

`verify_overlay_tiles.mjs` 需要 `COMICS_COMPUTE_ROOT` 和安装了 NumPy、Pillow 的 `PYTHON`，用于真实节点编码联调。其他服务端工具在 `node-comics-backend/scripts/`。
