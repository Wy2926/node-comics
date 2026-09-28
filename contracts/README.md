# API 契约

`openapi.json` 从当前工作区的 FastAPI 路由离线导出，包含请求与响应 schema、错误和授权方式。导出器只使用显式合成配置与代码默认值，不读取 dotenv、不继承真实服务配置，也不启动应用生命周期、数据库、worker 或供应商。更新后端接口后，使用已安装后端依赖的 Python 在仓库根目录执行：

```powershell
backend/.venv/Scripts/python.exe scripts/export_openapi.py
```

无需设置运行环境或准备服务凭据；可用 `--output <路径>` 导出到其他文件作对比。

前端封装在 `apps/extension/src/api.ts`，当前使用手写 TypeScript 类型；此文件是可用于生成客户端类型的机器契约，尚未建立 CI 自动生成流程。
