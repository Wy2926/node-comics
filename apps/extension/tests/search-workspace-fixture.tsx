/** Real search UI, synthetic failures and no external network or model calls. */
import {Profiler, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ApiError, type Api} from '../src/api';
import {listSearchSites} from '../src/sources';
import {ComicSearchPanel} from '../src/ui/comic-search/ComicSearchPanel';
import type {SearchSiteState} from '../src/comics/application/search/types';
import {SearchSiteGroups,searchSiteGroup,searchSiteStateLabel} from '../src/ui/comic-search/SearchSiteGroups';
import {SearchResultCard} from '../src/ui/comic-search/SearchResultCard';
import {searchResultCoverKey} from '../src/ui/comic-search/SearchResultCover';
import {Scrollbars} from '../src/ui/Scrollbars';
import {installDictionary,msg} from '../src/i18n/runtime';
import english from '../src/i18n/dictionaries/en.json';
import german from '../src/i18n/dictionaries/de.json';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';
import '../src/ui/phone.css';

if (location.origin !== 'http://127.0.0.1:5206') throw Error('Use the isolated http://127.0.0.1:5206 fixture.');
const params=new URLSearchParams(location.search),dense=params.get('sites')==='20',locale=params.get('locale');
installDictionary(locale==='en'?'en':locale==='de'?'de':'zh-CN',locale==='en'?english:locale==='de'?german:{});
let blockedFetches=0;
globalThis.fetch = async () => {document.body.dataset.fixtureFetches=String(++blockedFetches);throw Error('Fixture: network requests disabled');};
localStorage.setItem('nc-search-sites', JSON.stringify(Object.fromEntries(listSearchSites().map((site, index) => [site.key, index < 2]))));
let commits = 0, renderMs = 0, titleCalls = 0, sample: ReturnType<typeof setTimeout> | undefined;
const report = (label: string) => {document.getElementById('metrics')!.textContent = JSON.stringify({label, commits, renderMs: Number(renderMs.toFixed(2)), titleCalls});};
const api = {translateComicTitle: async () => {titleCalls++; throw new ApiError('Fixture: retry in five seconds', 'RATE_LIMITED', 429, undefined, 5);}} as unknown as Api;
const sampleSites=listSearchSites().slice(0,24);
const coverUrl=new URL('/samples/starlight-bookshop.png',location.origin).href;
const sampleHits=sampleSites.slice(0,20).flatMap((site,index)=>Array.from({length:index%4+1},(_,page)=>({key:`fixture:${index}:${page}`,sourceId:site.adapterId,siteId:site.id,catalogId:`fixture:${index}:${page}`,catalogUrl:new URL(`fixture-${index}-${page}`,site.url).href,title:`星光书店 · ${index+1}-${page+1}`,authors:['星野葵'],cover:{url:coverUrl}})));
const sampleCoverCache=new Map(sampleHits.map(hit=>[searchResultCoverKey(hit),coverUrl]));
const sampleStates:SearchSiteState[]=sampleSites.map((site,index)=>{
  const resultKeys=sampleHits.filter(hit=>hit.sourceId===site.adapterId&&hit.siteId===site.id).map(hit=>hit.key);
  return {site,selected:true,resultCount:resultKeys.length,resultKeys,status:index<20?'ready':index<22?'empty':'error',...(index===22?{error:{kind:'verification' as const,message:'Fixture: login or verification required'}}:index===23?{error:{kind:'unavailable' as const,message:'Fixture: search unavailable'}}:{})};
});
function SiteDensityFixture({open}:{open:boolean}){
  const [expandedGroups,setExpandedGroups]=useState<Record<string,boolean>>({found:true}),[expandedLists,setExpandedLists]=useState<Record<string,boolean>>({}),[selected,setSelected]=useState('');
  const current=sampleStates.find(state=>state.site.key===selected),hits=sampleHits.filter(hit=>!current||current.resultKeys.includes(hit.key));
  if(!open)return null;
  return <section className="nc-comic-search nc-search-page" data-density-fixture>
    <section className="nc-search-results">
      <div className="nc-search-result-heading"><h2>{msg('搜索结果')}</h2><div className="nc-search-progress"><span>{msg('{0}/{1} 个网站已返回',{'0':24,'1':24})}</span><span className="nc-search-candidate-count">{msg('{0} 个候选',{'0':hits.length})}</span></div></div>
      <SearchSiteGroups sites={sampleStates} selectedSiteKey={selected} expandedGroups={expandedGroups} expandedLists={expandedLists} onSelectSite={key=>setSelected(value=>value===key?'':key)} onToggleList={group=>setExpandedLists(value=>({...value,[group]:!value[group]}))} onToggleGroup={group=>{const expanded=!expandedGroups[group];setExpandedGroups(value=>({...value,[group]:expanded}));if(!expanded&&current&&searchSiteGroup(current)===group)setSelected('');}}/>
      {current&&<section className={'nc-search-status-detail is-'+current.status}><div className="nc-search-detail-copy"><h3>{current.site.name}</h3><p>{current.error?.message??searchSiteStateLabel(current)}</p></div></section>}
      <div className="nc-search-result-list">{hits.map(hit=><SearchResultCard key={hit.key} hit={hit} site={sampleSites.find(site=>site.adapterId===hit.sourceId&&site.id===hit.siteId)} cache={sampleCoverCache} current={false} onImport={()=>{}}/>)}</div>
    </section>
  </section>;
}
function Fixture() {
  const [open, setOpen] = useState(true), [locale, setLocale] = useState(false);
  return <div className="nc-app"><Scrollbars/>
    <header className="nc-app-header" style={{flexWrap: 'wrap', gap: 8}}>
      <button className="button secondary" onClick={() => {if (sample) clearTimeout(sample); commits = renderMs = 0; report('sampling'); sample = setTimeout(() => report('10 seconds'), 10_000);}}>采样 10 秒</button>
      <button className="button secondary" onClick={() => setOpen(value => !value)}>{open ? '暂时离开' : '返回搜索'}</button>
      <button className="button secondary" onClick={() => {installDictionary(locale ? 'zh-CN' : 'en', locale ? {} : english); setLocale(value => !value);}}>中 / EN</button>
      <button className="button secondary" onClick={() => {document.documentElement.dataset.appearance = document.documentElement.dataset.appearance === 'dark' ? 'light' : 'dark';}}>亮 / 暗</button>
    </header>
    <main className="nc-main"><Profiler id="search" onRender={(_id, _phase, duration) => {commits++; renderMs += duration;}}>
      {dense?<SiteDensityFixture open={open}/>:<ComicSearchPanel open={open} presentation="page" seed={{title: ''}} api={api} defaultLanguage="en" onImportHit={async () => {throw Error('Fixture: import disabled');}}/>}
    </Profiler></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
