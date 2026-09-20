import { useState } from 'react';
export default function Compare({ original, translated, copy = {} }: { original: string; translated: string; locale?: string; copy?: Record<string,string> }) {
  const t=(value:string)=>copy[value]??value;
  const [mode, setMode] = useState<'original' | 'translated'>('translated');
  return <div className="compare">
    <div className="compare-toolbar"><span>{t("一页，两种读法。")}</span><div className="segmented" role="group" aria-label={t("插画语言对照")}><button type="button" aria-pressed={mode === 'original'} onClick={() => setMode('original')}>{t("日文原图")}</button><button type="button" aria-pressed={mode === 'translated'} onClick={() => setMode('translated')}>{t("中文示意")}</button></div></div>
    <div className="compare-art"><img src={mode === 'original' ? original : translated} width="1024" height="1536" loading="lazy" decoding="async" alt={mode === 'original' ? t("原创漫画：海边站台上的旅人，气泡文字为日文") : t("相同漫画的中文示意：下一站，会是怎样的世界？")} /></div>
    <p className="image-note" aria-live="polite">{mode === 'original' ? t("日文原图") : t("中文示意")}{t("· AI 生成的功能插画，非产品实测效果承诺")}</p>
  </div>;
}
