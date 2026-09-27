import {msg} from '../i18n/runtime';

export function ShelfUpdates({count,active,onToggle}:{count:number;active:boolean;onToggle:()=>void}){
 if(count===0)return null;
 return <button className="nc-shelf-updates" type="button" aria-pressed={active} onClick={onToggle}>
  <svg className="nc-shelf-updates-frame" viewBox="0 0 160 60" preserveAspectRatio="none" aria-hidden="true" focusable="false">
   <path className="nc-shelf-updates-shadow" d="m9 7 142-3 5 10-4 34-24 1-9 9-6-9-107 2Z" transform="translate(3 3)"/>
   <path className="nc-shelf-updates-paper" d="m9 7 142-3 5 10-4 34-24 1-9 9-6-9-107 2Z" vectorEffect="non-scaling-stroke"/>
   <path className="nc-shelf-updates-hatch" d="m10 38 7-7m-5 13 13-13m-5 14 7-7" vectorEffect="non-scaling-stroke"/>
  </svg>
  <svg className="nc-shelf-updates-spark" viewBox="0 0 30 34" aria-hidden="true" focusable="false">
   <path d="m15 3-9 15 9-1-3 14 15-20-11 2 5-10Z"/>
   <path d="m3 5 3 3m20 19 2 3M2 26l4-2" fill="none"/>
  </svg>
  <span className="nc-shelf-updates-label">{msg('有更新')}</span>
  <span className="nc-shelf-updates-count">
   <svg viewBox="0 0 48 44" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="m8 3 29-1 9 10-3 24-12 6-27-5-2-23Z" vectorEffect="non-scaling-stroke"/></svg>
   <strong>{count}</strong>
  </span>
 </button>;
}
