# MangaCopy 动态分类与卡片目录菜单

日期：2026-09-23。状态：代码、Chrome MV3 本地构建和桌面浏览器验证完成；未发布。

## 修正内容

- 删除漫画卡片右键／更多菜单的“目录”以及对应的目录弹框。阅读器内目录保持可用；没有可靠默认入口时，在页面内选择开始位置。
- 原实现已动态读取分组，但通过 `/同人|其他系列|其它系列/` 名称规则设置 `related`，导致同一本漫画的章节被排除出可阅读目录。删除该名称规则，继续用来源域名和漫画资源键验证章节归属。
- 只按源站 `default` ID 确定默认入口；其他 ID、名称和原始标签完全来自页面。不同分组／标签保持独立阅读序列，重复引用仍共用一个条目与进度。

## 真实页面核对

在浏览器中等待两个来源页面完成异步目录加载，读取所有分组及隐藏分页中的链接数量：

| 页面 | 分组与条目数 |
| --- | --- |
| [碧蓝之海](https://www.copy4000.com/comic/grandblue) | 默認 104；其它汉化版 2；其他系列 10，共 116 |
| [来自深渊](https://www.copy4000.com/comic/laizishenyuan) | 默認 82；单行本 13；其它汉化版 1；同人漫画 4，共 100 |

这些是当日真实页面结构核对，数量可能随来源更新变化。没有将这些分组名、ID 或数量写入生产适配逻辑。本轮未在真实来源执行章节图片下载或翻译。

## 可复现验证

在仓库根目录运行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
$env:PLAYWRIGHT_MODULE = '<已安装 playwright 模块的绝对路径>'
$env:TEST_CHROMIUM = '<支持加载解压扩展的 Chromium 可执行文件>'
node scripts/verify_catalog_sync.mjs
```

浏览器脚本使用临时 profile、合成站点与图片，需要 Python 的 `cryptography` 生成本机 TLS 证书；不访问个人浏览器数据或真实翻译服务。

- 类型和 194 个模块边界检查通过；637 项单元测试通过，1 项既有测试跳过。新增 6 项适配器测试覆盖两个示例的分类结构、未知分类与标签、默认分组改名、伪默认名称、跨分组重复引用与异步未完成分类。
- Chromium 141、1440 × 1000 下的 11 项浏览器检查通过，页面运行错误为 0：右键／更多菜单删除目录项、目录内阅读同人漫画、新增自定义分组自动同步、无默认入口的页面选择、续读第 2 页、目录加载失败保留旧数据、图片失败保留更新提示等。
- 已检查 `artifacts/catalog-sync/` 中的 `card-context-menu.png`、`dynamic-categories.png`、`choose-reading-start.png`，其余检查结果见同目录 `results.json`。隔离图片仅用于交互验证，不代表真实漫画翻译效果。
- 同步调整 `verify_website_source_lifecycle.mjs` 的起点选择定位，删除该处旧窄屏验收；本轮未重新运行其完整下载与缓存场景。

测试日志仍有既有 `node-unrar-js` source map 缺失警告，不影响上述检查。
