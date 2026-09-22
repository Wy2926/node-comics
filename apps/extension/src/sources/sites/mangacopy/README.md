# MangaCopy

`definition.ts` 持有主站／copy4000 镜像的严格 HTTPS 主机、作品／章节身份、目录引用和原有安装权限。`catalog.ts` 读取当前 DOM 的分组、隐藏条目和原始类型，返回标准分类建议，不写书库归属或排除项。`pages.ts` 保留容器中的页槽；`data.ts` 解码页面已有的 AES-CBC 数据并交叉核对页序，不执行页面脚本。

目录和章节可有限等待完整清单；不自动滚动、翻章或处理登录挑战。缺少页槽保持部分结果，数据校验失败不退回通用图片发现。`tests/` 覆盖镜像、伪造域名、目录等待、清单解码、重复 URL、取消和暂停。隔离浏览器验收使用仓库根目录 `scripts/verify_web_import.mjs`、`scripts/verify_acquisition_order.mjs`。真实站点验收使用 `RUN_LIVE_MANGACOPY=1` 的 `scripts/verify_mangacopy.mjs`，结果与隔离样本分别记录。
