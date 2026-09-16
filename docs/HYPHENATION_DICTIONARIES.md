# 嵌字字典准备与离线运行

2026-09-16：修复英文嵌字反复联网下载断词字典。正常 AMD 版本为 `mit-95227a2-classic-v4-dml-v4`，CPU/CUDA 为 `mit-95227a2-classic-v5-cluster`；渲染缓存版本为 `masked-png-v2-hyphen-32b006a2`。模型、字体与原排版算法保持原配置；节点执行位现由服务端配置。

## 原因与修复

原渲染器在每个横排文本块的布局、绘制阶段分别构造 `Hyphenator('en')`。PyHyphen 下载后登记 `en_GB` 等地区代码，下一次精确查询 `en` 仍判定未安装；5 块文字重复触发 20 次公共字典 HTTP 请求。`hyphenate=False` 未覆盖布局和断词器初始化，所以不能阻止这些请求。

`hyphenation.py` 现在将 `en`、`ENG`、`en_GB` 规范化到同一个已加载对象，直接从经过校验的文件初始化 PyHyphen 4.0.4 的原 C 引擎。保留原 `syllables`、长词换行和图像合成语义，不在运行时调用会下载的构造函数。布局与绘制共用同一选择器。

字典必须在节点接单前准备并加载。启动时自动补全并校验所声明语言资源，无法准备时启动失败；渲染请求不会联网补字典。中、日、韩不使用该拉丁语系断词字典，沿用字符排版路径。`/health` 的 `hyphenation` 字段显示目录版本、已加载地区语言与 `network:false`。

## 指定语言提前下载

在仓库根目录执行；使用已经安装引擎依赖的 Python，无需加载模型：

```powershell
# 预下载指定语言；空格或逗号均可。英文默认沿用此前的英国英语字典。
services/classic-engine/.venv/Scripts/python.exe services/classic-engine/prepare_dictionaries.py --languages en en-US de fr es it pt-BR pt-PT ru pl uk --directory engines/mit-models/hyphenation

# 列出目录内支持的语言、别名和对应许可
services/classic-engine/.venv/Scripts/python.exe services/classic-engine/prepare_dictionaries.py --list

# 下载目录内全部字典
services/classic-engine/.venv/Scripts/python.exe services/classic-engine/prepare_dictionaries.py --all --directory engines/mit-models/hyphenation

# 完全离线校验，缺失/损坏时以非零状态退出
services/classic-engine/.venv/Scripts/python.exe services/classic-engine/prepare_dictionaries.py --all --verify --directory engines/mit-models/hyphenation
```

当前目录有 11 份字典：`en-GB`、`en-US`、`de-DE`、`fr-FR`、`es-ES`、`it-IT`、`pt-BR`、`pt-PT`、`ru-RU`、`pl-PL`、`uk-UA`。支持目录中列出的别名和 ISO 三字母代码；未知语言直接报错。`zh-Hans`、`zh-Hant`、`ja`、`ko` 明确返回“不需要字典”，不会误报下载成功。字典准备能力不改变产品当前支持的五种翻译目标语言。

文件按目录版本保存到 `engines/mit-models/hyphenation/`，带原始相对路径与许可说明。下载有 30 秒请求超时和固定长度上限；SHA-256 匹配后才原子替换文件。再次执行时只检查已安装文件，完整且正确的资源不重新下载。失败后可重跑同一命令，已验证文件可复用。

## 启动配置

使用 `ENGINE_CONFIG_FILE` 指定 JSON，本地 `runtime.languages` 声明产品支持的目标语言，`dictionary_dir` 可指定字典根目录；默认 `${model_dir}/hyphenation`。节点首次启动在模型接单前自动补全缺失／损坏的所需文件，校验通过才 ready。准备工具仍可独立使用 `--languages` / `--all` / `--verify` 管理目录中的其他字典，但不会据此扩展产品目标语言。

服务端 `engine.languages` 可覆盖本地声明；变更时节点停止新领取、等待当前阶段完成、准备语言资源并确认应用版本。翻译请求不发起字典下载。配置样例、线程参数和完整协议见[节点配置](NODE_CONFIGURATION.md)。

## 执行位的含义

后台设置每节点 1–32 个在途阶段执行位，代理据此并发处理阶段；单物理设备模型保留串行锁。AMD 两个 LaMa 子进程并行处理当前页裁剪，不是两个额外节点。文本 LLM 仍有独立控制资源池。

## 字典来源与许可

所有字典固定到 [LibreOffice/dictionaries@32b006a2c22a4ac7e8ed3f03346f7b3d85a970a4](https://github.com/LibreOffice/dictionaries/tree/32b006a2c22a4ac7e8ed3f03346f7b3d85a970a4)。[目录清单](../services/classic-engine/hyphenation-catalog.json)逐一记录文件路径、字节数、SHA-256、许可说明资源及其校验和。下载原字节，不改写字典。

许可按每份断词资源核对：英语为上游 BSD-style 条款；德、法、意、波兰语含 LGPL 及其原始模式的说明；西班牙语提供 GPL/LGPL/MPL 选择；葡萄牙语两地区和乌克兰语有各自 GPL/LGPL/MPL 条款；俄语使用其上游再分发条款。具体权利和义务以随文件下载的原文为准，未用 LibreOffice 仓库总许可证或拼写词典许可证替代断词资源许可。更新目录必须重新核实资源及许可，并更新缓存版本。

## 检查

```powershell
cd services/classic-engine
.venv/Scripts/python.exe -m unittest -v test_hyphenation.py
```

覆盖语言别名复用、未知语言、CJK 跳过、重复准备零下载、离线检查、损坏修复、许可校验、错误响应不能落盘，以及绕开下载构造函数。相关阶段契约继续验证三个图像阶段不会意外并发。

本轮本机证据：36 项引擎/缓存/阶段检查与 14 项相关后端检查通过；扩展旧版本缓存隔离断言后另复查 1 项通过。11 份字典、28 个字典及许可资源下载后全部离线校验通过，再次准备已安装语言下载数为 0。

复用已完成任务的 5 个英文文本块、相同译文和白底画布：旧实现重复执行为 6.677 秒，新正式渲染代码重复执行为 0.176 秒，原样输出像素和字形掩膜一致，封锁网络请求的检查通过。切换后的真实 HTTP 引擎探针为 0.312 / 0.172 秒嵌字（HTTP 为 0.390 / 0.266 秒），字形一致，单像素修复探针之外像素一致。该探针使用已有译文与合成图片，不创建控制任务、不调用 LLM 或 R2；不替代新一轮真实漫画全链路效果验收。

切换前确认没有在途任务或未释放租约并备份数据库，已有完成/失败记录保留。API、控制执行池与 AMD v4 节点已启动，健康接口确认离线字典版本。本轮未构建运行 Docker 镜像或部署公开服务；Compose 配置检查通过。
