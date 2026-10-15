# Lagoon Scans

支持 `https://lagoonscans.com/manga/<slug>/` 作品及 `/<slug>-chapter-<话号>/` 章节。提供名称分页搜索、HTTP 完整静态目录、标准 JSON 正文、专门封面及 12 小时目录同步；作品／章节使用浮动导入入口，标签页原位翻译复用通用已加载大图识别。其他主机、搜索／分类路径和非章节文章不能导入。

裸章节由源站 `.allc` 的作品链接确定归属，不从章节标题或 slug 推断作品。目录条目添加本机片段 `#nodelane-lagoonscans=<作品 slug>`，读取前核对作品与当前章节；片段不发送到源站。章节身份与作品绑定独立，目录保留源站标题、实际条目和阅读顺序，不根据话号补造缺话。

## 协议与边界

使用 [MangaThemesia 共享引擎](../../shared/mangathemesia/README.md)。协议参考 [Keiyoushi 的 LagoonScans](https://github.com/keiyoushi/extensions-source/tree/main/src/en/lagoonscans) 及 [源站公开 HTML](https://lagoonscans.com/)；精确版本、摘要和许可见引擎目录的来源清单。站点模块只定义来源身份、路径、元数据与 HTTP 图片地址校验，本地图标为自制 SVG。

作品 `.infotable` 及列表类型标注确认 Manga、Manhwa 和 Manhua，主要内容为英语译作；尚未确认全站收费规则，因此标为 `unknown`，不宣称全部免费。图片使用源站数据提供的普通 HTTP(S) 地址，拒绝凭据及片段；实际访问权限、请求预算和取消由公共层处理。不执行远端脚本，不绕过登录、验证或付费限制；未知读取器变体明确失败，不改用另一通道。

## 验证

在仓库根目录执行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test -- --run src/sources/shared/mangathemesia/tests src/sources/sites/lagoonscans/tests
npm --prefix apps/extension run build
```

隔离样本覆盖来源／章节身份、目录绑定、页序、重复图址、搜索、失败保留及取消；不保存源站正文或图片。真实协议可使用 `/manga/30-years-since-the-prologue/` 与 `/30-years-since-the-prologue-chapter-20/` 检查搜索、目录、正文及图片读取。构建后还须在目标浏览器验证浮动导入、原图读取、阅读／重开位置、原位恢复与权限撤销；隔离测试不代表浏览器安装或真实模型效果。
