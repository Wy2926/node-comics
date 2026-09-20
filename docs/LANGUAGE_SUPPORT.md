# 目标语言与节点能力

产品的常规翻译目标项来自 [backend/app/languages.py](../backend/app/languages.py)：`zh-Hans`、`zh-Hant`、`ja`、`en`、`ko`、`fr`、`es`、`pt-BR`、`de`、`it`、`ru`、`pl`、`uk`、`tr`、`vi`、`id`，共 16 项。AI 重绘只开放前五项。

节点通过配置应用回执报告 `supported_languages`，中心仅把匹配目标语言与引擎版本的图像阶段分给该节点。后台可配置语言子集；移除语言不会修改已排队任务，其阶段等待其他匹配节点。未知或该模式未开放的目标语言返回 `LANGUAGE_UNSUPPORTED`。

仓库包含 [classic-engine](../services/classic-engine/README.md) 源码、模型清单和测试；模型权重与字体需另行准备。产品允许选择某目标语言，不代表已有可用节点，也不代表 OCR 能可靠识别该源语言。接入引擎需要自行验证源语言 OCR、目标字体、换行、缺字和排版边界，并准确报告能力。参见[节点配置](NODE_CONFIGURATION.md)和[交互协议](COMPUTE_PROTOCOL.md)。
