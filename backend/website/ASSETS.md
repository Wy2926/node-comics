# 官网图片来源

2026-09-20：三张介绍插画使用用户指定的兼容图片 API，模型固定 gpt-image-2、high 品质。通过 imagegen 技能的 CLI 备用路径完成两次生成和一次图片编辑，使用真实请求并检查可解码图片；没有调用其他生图服务。接口密钥只用于生成时的进程环境，不保存到项目、静态 HTML 或日志。

- journey-original.webp：1024 × 1536，海边车站漫画三格；[原始提示词](assets/prompts/hero.txt)，生成约 59.7 秒。
- reading-corner.webp：1536 × 1024，海边阅读角；[原始提示词](assets/prompts/reading.txt)，生成约 53 秒。
- journey-translated.webp、journey-en.webp、journey-ko.webp：2026-09-21 用户提供的中文、英文、韩文效果图，原文件分别为「中文效果.png」「英文效果.png」「韩文效果.png」，760 × 1140；转换为 WebP quality 92，中文图替换先前生成版本。本次未调用图片模型。
- social-cover.webp：阅读角图片裁切为 1200 × 630、WebP quality 85，用于分享卡片。构建时 Astro/Sharp 另外生成响应式尺寸与压缩版本。

这些是原创 AI 插画和功能示意，不是某部商业漫画、真实用户作品或已测量的产品翻译效果；对照组件明确标注示意用途。AI 图片不以第三方开源许可证重新授权，不假定其具备排他版权。生成模型由指定 API 提供，不分发模型权重。

品牌 Logo 与 favicon 复用插件已确认的 `apps/extension/src/assets/brand/*-light.webp`、`apps/extension/public/brand`，未重新生成；品牌命名依据 [品牌文档](../../docs/BRAND_AND_STORE_LISTING.md)。SVG/CSS UI 元素不属于介绍插画。

| 产物 | SHA-256 |
| --- | --- |
| [src/assets/journey-original.webp](src/assets/journey-original.webp) | `491d167fbb8460b59346f8b13dd2ba7dfd32d7d52145c2ebff0bfaf0336ad499` |
| [src/assets/journey-translated.webp](src/assets/journey-translated.webp) | `47c90681880b9e1f98481d5e9e92e190a680100d21d3b5a2d66c47b544801a98` |
| [src/assets/journey-en.webp](src/assets/journey-en.webp) | `7cf086e17271406df6f193d145995508b7757373d14485c716012186c601d9a1` |
| [src/assets/journey-ko.webp](src/assets/journey-ko.webp) | `5ef144b6df6f8f224137c772d1b80702f5f6659f99a6e0b97ce5e2dbf2644fa3` |
| [src/assets/reading-corner.webp](src/assets/reading-corner.webp) | `58fe02d84ca2a235fca477e1a7b90d96094618a42f78728daa792a45444a4127` |
| [public/social-cover.webp](public/social-cover.webp) | `6c6dba9712a00be1312673373e26f8a289a6d14cc6a1dc26277e72c11dc8c322` |
| [src/assets/logo-zh.webp](src/assets/logo-zh.webp) | `3bab8e6227e9a68de9d2cc2f34a1cb0d60ad1de15e937294e87d602ece0add7a` |
| [src/assets/logo-en.webp](src/assets/logo-en.webp) | `abac28ef1514504dfcfee05374a85d230987809ce906cd08d864f19d79801023` |
| [public/icon-128.png](public/icon-128.png) | `a83fe892bb1599baaba3c8c11f2a19ce10cff2560956c3072cde57f20f52da53` |
| [public/favicon.ico](public/favicon.ico) | `6ec5ace09c14e6a3865397956490a92488059b8ac07fee995907670b529017c2` |
