import {useUiLocale} from '../i18n/react';
import {msg} from '../i18n/runtime';
import zhLight from '../assets/brand/logo-horizontal-zh-light.webp';
import zhDark from '../assets/brand/logo-horizontal-zh-dark.webp';
import enLight from '../assets/brand/logo-horizontal-en-light.webp';
import enDark from '../assets/brand/logo-horizontal-en-dark.webp';
import './BrandLogo.css';

export function BrandLogo(){
  const chinese=useUiLocale().startsWith('zh');
  return <span className="nc-brand-logo">
    <img className="nc-brand-logo-light" src={chinese?zhLight:enLight} alt={msg('brand.name')} width={1600} height={320} draggable={false}/>
    <img className="nc-brand-logo-dark" src={chinese?zhDark:enDark} alt={msg('brand.name')} width={1600} height={320} draggable={false}/>
  </span>;
}
