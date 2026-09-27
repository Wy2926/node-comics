import type {CSSProperties} from 'react';
import sprite from './assets/icons.svg?url';
import './icons.css';

/** Shared comic artwork keeps its palette while status controls can override the ink. */
export function Icon({name,size=20,style,className=''}:{name:string;size?:number;style?:CSSProperties;className?:string}) {
  return <svg className={`nc-icon ${className}`} data-compact={size<=16||undefined} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--icon-stroke,var(--icon-comic-ink))" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><use href={`${sprite}#${name}`}/></svg>;
}
