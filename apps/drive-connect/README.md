# Google Drive 连接页

插件共用的静态 HTTPS OAuth 页面，只读取用户选择的文件。

1. Google Cloud 启用 Drive API、Picker API；Web OAuth client 登记精确回调。
2. 部署副本 `config.js` 填公开 clientId，不使用 client secret。
3. 四个页面文件部署到连接路径；`public/` 中三项资源部署到同域根路径。设置 no-store、nosniff 与禁止嵌入的 CSP。
4. 插件构建设置 `VITE_DRIVE_CONNECT_URL` 为完整连接页 URL。

授权使用 `drive.file`，实现仅只读。桥接校验 origin、路径、tab、frame、nonce、OAuth state 与期限；token 回调后清理 fragment，凭据只留可信浏览器会话，断开拒绝迟到结果。

模拟验证：根目录 `node scripts/verify_drive_import.mjs`。真实 Google 授权按目标浏览器另验。
