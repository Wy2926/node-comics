# API 契约

`openapi.json` 从当前工作区的 FastAPI 路由离线导出，包含请求与响应 schema、错误和授权方式，不含密钥或用户数据，不连接数据库或供应商。更新后端接口后，使用已安装后端依赖的 Python 在仓库根目录执行：

```powershell
backend/.venv/Scripts/python.exe scripts/export_openapi.py
```

前端封装在 `apps/extension/src/api.ts`，当前使用手写 TypeScript 类型；此文件是可用于生成客户端类型的机器契约，尚未建立 CI 自动生成流程。
