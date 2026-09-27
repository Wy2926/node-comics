import type {CSSProperties} from 'react';
import sprite from './assets/icons.svg?url';
import './icons.css';

/** Comic SVG symbols share theme fills while retaining contextual text/status colors. */
export function Icon({name,size=20,style,className=''}:{name:string;size?:number;style?:CSSProperties;className?:string}) {
  return <svg className={`nc-icon ${className}`} data-compact={size<=16||undefined} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><use href={`${sprite}#${name}`}/></svg>;
}
