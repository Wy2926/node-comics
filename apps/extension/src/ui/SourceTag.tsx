import type {SourceLabel} from '../comics/application/types';
import {msg} from '../i18n/runtime';

export function SourceTag({sources=[]}:{sources?:SourceLabel[]}){
 const unique=[...new Map(sources.map(source=>[source.id,source])).values()];
 if(!unique.length)return null;
 const label=unique.length>1?msg('{0} 个来源',{'0':unique.length}):unique[0].label;
 return <span className="nc-cover-tag nc-source-tag" title={unique.map(source=>source.label).join(' · ')}>{label}</span>;
}
