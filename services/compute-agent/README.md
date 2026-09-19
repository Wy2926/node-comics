# 计算代理

代理负责向总中心领取图像阶段、续租、获取授权输入、调用独立图像引擎并提交结果。仓库不附带图像引擎；代理本身不执行 OCR、抹字或嵌字，也不访问数据库、R2 凭据或文本供应商密钥。

## 接入与运行

1. 部署符合[交互协议](../../docs/COMPUTE_PROTOCOL.md)的独立图像引擎，确认健康接口已就绪。
2. 在后台创建节点，绑定与引擎报告一致的稳定 `resource_id`，保存一次性返回的节点凭据。
3. 复制 [node.example.json](node.example.json) 为 `node.local.json`，填写中心 HTTPS 地址、节点身份、引擎地址和独立引擎凭据。
4. 在中心启用常规模式，配置文本供应商，并令 `CLASSIC_ENGINE_VERSION` 与引擎报告一致。

在仓库根目录运行，使用已安装 Python 的独立环境：

```powershell
python -m venv services/compute-agent/.venv
services/compute-agent/.venv/Scripts/python.exe -m pip install -r services/compute-agent/requirements.txt
$env:NODE_CONFIG_FILE = (Resolve-Path services/compute-agent/node.local.json).Path
services/compute-agent/.venv/Scripts/python.exe services/compute-agent/agent.py
```

也可用 `CONTROL_URL`、`NODE_ID`、`NODE_TOKEN`、`ENGINE_URL`、`ENGINE_TOKEN` 配置；引擎地址必须显式提供。本地隔离环境可明确设置 `CONTROL_ALLOW_HTTP=true`。跨机器中心连接使用 HTTPS。

执行位、轮询、心跳、超时与缓存由中心配置。代理拉取变更后先停止新领取，排空在途阶段与结果上报，再向引擎应用并报告中心。详见[节点配置](../../docs/NODE_CONFIGURATION.md)。

## 协议检查

以下测试使用模拟引擎，不验证实际图像效果或 GPU：

```powershell
backend/.venv/Scripts/python.exe -m pytest services/compute-agent -q
# 在 backend 目录运行真实 HTTP 多进程协议测试；引擎和文本响应仍为模拟：
.venv/Scripts/python.exe -m pytest tests/test_compute_http.py -q
```

可独立构建代理镜像：`docker build -t node-comics-compute-agent:cluster services/compute-agent`。需由部署方提供控制与引擎地址、凭据及网络；根 Compose 仅包含数据库和三个控制进程。
