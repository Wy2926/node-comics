# Gunnerkrigg

认领主站／www 的首页和 `index.php`，保留查询参数中的漫画页号；其他路径明确不支持。仅从 `img.comic_image, #comic img` 发现当前页，单张图片满足单页完整性契约。没有目录或自动翻页能力，不扩大安装权限。`tests/page.test.ts` 检查等待状态、选择器与不同页号身份。
