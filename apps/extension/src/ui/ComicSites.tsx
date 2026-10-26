import { msg } from '../i18n/runtime';
import {useUiLocale} from '../i18n/react';
import { Icon } from '../icons';
import { listSupportedSites, sortSupportedSites, matchesSiteFilters, type SiteFilters } from '../sources';
import {readSiteFavorites, saveSiteFavorites, siteFavoritesKey} from '../comics/application/preferences';
import {emptySiteFilters, SiteFilterControls, siteLabels} from './SiteFilterControls';
import { SupportRequestForm } from './SupportRequestForm';
import {ComicSiteCard} from './ComicSiteCard';
import {SiteLinkImport} from './SiteLinkImport';
import './comic-sites.css';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject} from 'react';

const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
const sites = listSupportedSites().map(site => {
  const hostname = new URL(site.url).hostname;
  return {...site, domain: hostname.replace(/^www\./, ''), searchText: normalize(`${site.name} ${hostname}`)};
});
export type SiteDirectoryView = {filters: SiteFilters; query: string; advanced: boolean; scrollTop: number};

export function ComicSites({onImport, view}:{onImport?:(url:string)=>Promise<void>; view?: RefObject<SiteDirectoryView | undefined>}) {
  const locale = useUiLocale(), labels = useMemo(siteLabels, [locale]);
  const [filters, setFilters] = useState<SiteFilters>(() => view?.current?.filters ?? emptySiteFilters);
  const [query, setQuery] = useState(() => view?.current?.query ?? '');
  const [advanced, setAdvanced] = useState(() => view?.current?.advanced ?? false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [favorites, setFavorites] = useState(readSiteFavorites);
  const orderedSites = useMemo(() => sortSupportedSites(sites, favorites), [favorites]);
  const favoriteKeys = useMemo(() => new Set(favorites), [favorites]);
  const filteredSites = useMemo(() => {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    return orderedSites.filter(site => matchesSiteFilters(site, filters) && terms.every(term => site.searchText.includes(term)));
  }, [orderedSites, filters, query]);
  const toggleFavorite = useCallback((key: string) => {
    const saved = readSiteFavorites();
    const next = saved.includes(key) ? saved.filter(value => value !== key) : [...saved, key];
    saveSiteFavorites(next); setFavorites(next);
  }, []);
  useLayoutEffect(() => {
    if (view) view.current = {filters, query, advanced, scrollTop: view.current?.scrollTop ?? 0};
  }, [view, filters, query, advanced]);
  useLayoutEffect(() => {
    if (!view) return;
    if (location.hash !== '#sites/request') window.scrollTo({top: view.current?.scrollTop ?? 0, behavior: 'instant'});
    const rememberScroll = () => {if (view.current) view.current.scrollTop = window.scrollY;};
    window.addEventListener('scroll', rememberScroll, {passive: true});
    return () => window.removeEventListener('scroll', rememberScroll);
  }, [view]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {if (event.key === siteFavoritesKey || event.key === null) setFavorites(readSiteFavorites());};
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const [requestSite]=useState(()=>{
    if(location.hash!=='#sites/request')return;
    const query=new URLSearchParams(location.search);
    try{
      const url=new URL(query.get('site_url')??'');
      if(!['https:','http:'].includes(url.protocol))return;
      return {site_name:(query.get('site_name')?.trim()||url.hostname).slice(0,100),url:url.origin+'/'};
    }catch{return;}
  });
  const requestSection=useRef<HTMLElement>(null);
  const focusRequest=useCallback(()=>{
    requestSection.current?.scrollIntoView({block:'center'});
    requestSection.current?.querySelector<HTMLInputElement>('.nc-support-form fieldset input')?.focus({preventScroll:true});
  },[]);
  useEffect(()=>{
    let frame=0;
    const locateRequest=()=>{
      cancelAnimationFrame(frame);
      if(location.hash!=='#sites/request')return;
      const page=new URL(location.href);
      if(page.searchParams.has('site_url')||page.searchParams.has('site_name')){
        page.searchParams.delete('site_url');page.searchParams.delete('site_name');
        history.replaceState(null,'',page.href);
      }
      frame=requestAnimationFrame(()=>{
        if(location.hash!=='#sites/request')return;
        focusRequest();
      });
    };
    locateRequest();
    window.addEventListener('hashchange',locateRequest);
    return()=>{cancelAnimationFrame(frame);window.removeEventListener('hashchange',locateRequest);};
  },[focusRequest]);
  return <div className="nc-sites-page">
    {onImport&&<SiteLinkImport onImport={onImport}/>}
    <div className="nc-sites-layout">
      <section aria-labelledby="nc-sites-title">
        <div className="nc-section-heading nc-sites-section-heading"><div><h1 id="nc-sites-title">{msg('漫画网站')}</h1><span className="nc-muted">{msg('已适配 {0} 个网站', { '0': sites.length })}</span></div><a className="button secondary small nc-site-request-shortcut" href="#sites/request" onClick={event=>{
          if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||location.hash!=='#sites/request')return;
          event.preventDefault();focusRequest();
        }}><Icon name="message" size={16}/>{msg('申请适配网站')}</a></div>
        <div className="nc-site-search">
          <label className="nc-search"><Icon name="search" size={18}/><input ref={searchInput} type="search" aria-label={msg('搜索网站')} placeholder={msg('搜索网站名称或域名')} value={query} onChange={event => setQuery(event.target.value)}/></label>
          {query && <button type="button" className="text-link" onClick={() => {setQuery(''); searchInput.current?.focus();}}>{msg('清除搜索')}</button>}
        </div>
        <SiteFilterControls filters={filters} onChange={setFilters} visibleCount={filteredSites.length} totalCount={sites.length} expanded={advanced} onExpandedChange={setAdvanced}/>
        {!filteredSites.length && <div className="nc-sites-empty"><Icon name="filter" size={28}/><p>{msg('没有符合条件的网站，请调整或清除筛选。')}</p><button type="button" className="text-link" onClick={() => {setQuery(''); setFilters(emptySiteFilters); searchInput.current?.focus();}}>{msg('清空筛选')}</button></div>}
        <ul className="nc-sites-grid">{filteredSites.map(site => <ComicSiteCard key={site.key} site={site} favorite={favoriteKeys.has(site.key)} onToggle={toggleFavorite} labels={labels} locale={locale}/>)}</ul>
        <p className="nc-sites-hint"><Icon name="info" size={19}/><span>{msg('进入漫画阅读页后，通过插件添加到书架。')}</span></p>
      </section>
      <section ref={requestSection} className="nc-site-request" aria-labelledby="nc-site-request-title">
        <div className="nc-site-request-icon"><Icon name="message" size={26}/></div>
        <h2 id="nc-site-request-title">{msg('申请适配网站')}</h2><p className="nc-site-request-intro">{msg('想读的网站还不在这里？告诉我们，无需登录。')}</p>
        <SupportRequestForm kind="website" initialSite={requestSite}/>
      </section>
    </div>
  </div>;
}
