import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const manifest=JSON.parse(await readFile('package.json','utf8'));
const names=[...new Set([...Object.keys(manifest.dependencies),...Object.keys(manifest.devDependencies),'jwt-decode','scheduler','sharp'])].sort();
const rows=names.map(name=>{const item=lock.packages[`node_modules/${name}`];return `| ${name} | ${item.version} | ${item.license} | [npm source](${item.resolved}) | \`${item.integrity}\` |`;});
await writeFile('DEPENDENCIES.md','# 官网依赖与许可\n\n由 `npm run notices` 从已安装依赖及 package-lock.json 生成。校验和为 npm tarball 的 SRI SHA-512；全部间接依赖版本、下载源和校验和以 package-lock.json 为准。没有在官网分发模型权重或字体文件；使用系统字体。Sharp/libvips 仅在构建期处理图片，不进入浏览器。\n\n| 组件 | 版本 | npm 声明许可 | 来源 | 校验和 |\n| --- | --- | --- | --- | --- |\n'+rows.join('\n')+'\n\n浏览器运行依赖的完整许可证随静态产物发布在 `/third-party-licenses.txt`。\n');
const runtime=['astro','@astrojs/react','react','react-dom','scheduler','oidc-client-ts','jwt-decode'];
const notices=[];
for(const name of runtime){
  const dir=`node_modules/${name}`;
  const files=await readdir(dir);
  const license=files.find(file=>/^licen[sc]e(?:\.md|\.txt)?$/i.test(file));
  if(!license)throw Error(`License not found: ${name}`);
  notices.push(`${name} ${lock.packages[dir].version}\n${(await readFile(`${dir}/${license}`,'utf8')).replace(/[ \t]+$/gm,'')}`);
}
await writeFile('public/third-party-licenses.txt',notices.join('\n\n----------------------------------------\n\n'));
const assets=['src/assets/journey-original.webp','src/assets/journey-translated.webp','src/assets/reading-corner.webp','public/social-cover.webp','src/assets/logo-zh.webp','src/assets/logo-en.webp','public/icon-128.png','public/favicon.ico'];
const checksums=await Promise.all(assets.map(async path=>`| [${path}](${path}) | \`${createHash('sha256').update(await readFile(path)).digest('hex')}\` |`));
await writeFile('ASSETS.md',`# 官网图片来源\n\n2026-09-20：三张介绍插画使用用户指定的兼容图片 API，模型固定 gpt-image-2、high 品质。通过 imagegen 技能的 CLI 备用路径完成两次生成和一次图片编辑，使用真实请求并检查可解码图片；没有调用其他生图服务。接口密钥只用于生成时的进程环境，不保存到项目、静态 HTML 或日志。\n\n- journey-original.webp：1024 × 1536，海边车站漫画三格；[原始提示词](assets/prompts/hero.txt)，生成约 59.7 秒。\n- reading-corner.webp：1536 × 1024，海边阅读角；[原始提示词](assets/prompts/reading.txt)，生成约 53 秒。\n- journey-translated.webp：1024 × 1536，基于原创漫画编辑中文气泡；[编辑提示词](assets/prompts/translation.txt)，约 427.1 秒。\n- social-cover.webp：阅读角图片裁切为 1200 × 630、WebP quality 85，用于分享卡片。构建时 Astro/Sharp 另外生成响应式尺寸与压缩版本。\n\n这些是原创 AI 插画和功能示意，不是某部商业漫画、真实用户作品或已测量的产品翻译效果；对照组件明确标注示意用途。AI 图片不以第三方开源许可证重新授权，不假定其具备排他版权。生成模型由指定 API 提供，不分发模型权重。\n\n品牌 Logo 与 favicon 复用插件已确认的 \`apps/extension/src/assets/brand/*-light.webp\`、\`apps/extension/public/brand\`，未重新生成；品牌命名依据 [品牌文档](../../docs/BRAND_AND_STORE_LISTING.md)。SVG/CSS UI 元素不属于介绍插画。\n\n| 产物 | SHA-256 |\n| --- | --- |\n${checksums.join('\n')}\n`);
