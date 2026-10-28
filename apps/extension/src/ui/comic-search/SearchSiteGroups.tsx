import {useId,useRef} from 'react';
import type {SearchSiteState} from '../../comics/application/search/types';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {SearchSiteIcon} from './SearchSiteIcon';

const groupOrder=['found','empty','login','failed','pending','stopped'] as const;
export type SearchSiteGroup=typeof groupOrder[number];
const PREVIEW_SITE_COUNT=10;
export const needsSiteLogin=(state:SearchSiteState)=>state.error?.kind==='login'||state.error?.kind==='verification';

export function searchSiteGroup(state:SearchSiteState):SearchSiteGroup {
  // A failed or pending later page must not hide existing candidates.
  if(state.resultCount>0)return 'found';
  if(state.status==='empty')return 'empty';
  if(state.status==='error')return needsSiteLogin(state)?'login':'failed';
  return state.status==='stopped'?'stopped':'pending';
}

export function searchSiteStateLabel(state:SearchSiteState){
  switch(state.status){
    case 'queued':return msg('等待搜索');
    case 'running':return msg('搜索中');
    case 'ready':return msg('{0} 个候选',{'0':state.resultCount});
    case 'empty':return msg('未找到');
    case 'error':return needsSiteLogin(state)?msg('需登录或验证'):state.error?.kind==='rate-limit'?msg('请求受限'):state.error?.kind==='timeout'?msg('搜索超时'):msg('搜索失败');
    case 'stopped':return msg('已停止');
    default:return msg('尚未搜索');
  }
}

export function SearchSiteGroups({sites,selectedSiteKey,expandedGroups,expandedLists,onToggleGroup,onToggleList,onSelectSite}:{
  sites:readonly SearchSiteState[];
  selectedSiteKey?:string;
  expandedGroups:Readonly<Record<string,boolean>>;
  expandedLists:Readonly<Record<string,boolean>>;
  onToggleGroup:(group:SearchSiteGroup)=>void;
  onToggleList:(group:SearchSiteGroup)=>void;
  onSelectSite:(key:string)=>void;
}){
  const id=useId(),listToggles=useRef<Partial<Record<SearchSiteGroup,HTMLButtonElement|null>>>({});
  const labels={found:msg('已找到'),empty:msg('未找到'),login:msg('需登录或验证'),failed:msg('搜索失败'),pending:msg('搜索中'),stopped:msg('已停止')};
  const groups:Record<SearchSiteGroup,SearchSiteState[]>={found:[],empty:[],login:[],failed:[],pending:[],stopped:[]};
  for(const state of sites)if(state.status!=='idle')groups[searchSiteGroup(state)].push(state);
  return <div className="nc-search-status-groups">{groupOrder.filter(group=>groups[group].length>0).map(group=>{
    const states=groups[group],expanded=!!expandedGroups[group],showAll=!!expandedLists[group];
    const visible=showAll?states:states.slice(0,PREVIEW_SITE_COUNT);
    const selected=states.find(state=>state.site.key===selectedSiteKey);
    // Keep the active filter visible when the user collapses a long list.
    const pinned=!showAll&&selected&&!visible.includes(selected)?selected:undefined;
    if(pinned)visible[visible.length-1]=pinned;
    return <section key={group} className={'nc-search-status-group is-'+group} data-expanded={expanded} aria-labelledby={id+'-'+group}>
      <h3><button type="button" id={id+'-'+group} className="nc-search-group-toggle" aria-expanded={expanded} aria-controls={id+'-'+group+'-sites'} onClick={()=>onToggleGroup(group)}><Icon name="chevron" size={14}/><span className="nc-search-group-name">{labels[group]}</span><span className="nc-search-group-count">{states.length}</span></button></h3>
      <div className="nc-search-group-sites" id={id+'-'+group+'-sites'} hidden={!expanded}>
        <div className="nc-search-status-list" id={id+'-'+group+'-list'}>{visible.map(state=>{
          const label=state.site.name+' · '+searchSiteStateLabel(state)+(state.resultCount>0&&state.status!=='ready'?' · '+msg('{0} 个候选',{'0':state.resultCount}):'');
          return <button type="button" key={state.site.key} className={'nc-search-status is-'+state.status} aria-pressed={selectedSiteKey===state.site.key} aria-label={label} title={label+' · '+msg('查看此网站结果')} onClick={()=>{if(state===pinned)listToggles.current[group]?.focus({preventScroll:true});onSelectSite(state.site.key);}}>
            <SearchSiteIcon icon={state.site.icon}/><b>{state.site.name}</b>
            <span className="nc-search-site-state" aria-hidden="true">{state.status!=='ready'&&<i className="nc-search-status-dot"/>}{state.resultCount>0&&<span className="nc-search-site-count">{state.resultCount}</span>}</span>
          </button>;
        })}</div>
        {states.length>PREVIEW_SITE_COUNT&&<div className="nc-search-sites-summary"><span>{msg('显示 {0} / {1} 个网站',{'0':visible.length,'1':states.length})}</span><button ref={element=>{listToggles.current[group]=element;}} type="button" className="nc-search-text-button nc-search-sites-expand" aria-expanded={showAll} aria-controls={id+'-'+group+'-list'} onClick={()=>onToggleList(group)}>{showAll?msg('收起网站'):msg('展开全部 {0} 个网站',{'0':states.length})}<Icon name="chevron" size={14}/></button></div>}
      </div>
    </section>;
  })}</div>;
}
