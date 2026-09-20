import type {CSSProperties} from 'react';
import sprite from './assets/icons.svg?url';

/** Shared 24px outline symbols, inheriting the active theme's text color. */
export function Icon({name,size=20,style,className=''}:{name:string;size?:number;style?:CSSProperties;className?:string}) {
  return <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><use href={`${sprite}#${name}`}/></svg>;
}
