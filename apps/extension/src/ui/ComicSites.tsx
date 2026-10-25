import { formatDate, msg } from '../i18n/runtime';
import { Icon } from '../icons';
import { listSupportedSites, sortSupportedSites, matchesSiteFilters, safeImageUrl, type SiteFilters } from '../sources';
import {readSiteFavorites, saveSiteFavorites, siteFavoritesKey} from '../comics/application/preferences';
import {emptySiteFilters, PricingIcon, SiteFilterControls, siteLabels} from './SiteFilterControls';
import { SupportRequestForm } from './SupportRequestForm';
import { LanguageFlag } from './LanguageFlag';
import { languageLabel } from '../types';
import './comic-sites.css';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

const sites = listSupportedSites();

export function ComicSites({onImport}:{onImport?:(url:string)=>Promise<void>}) {
  const {contentTagLabels, accessTagLabels, pricingLabels} = siteLabels();
  const [filters, setFilters] = useState<SiteFilters>(emptySiteFilters);
  const [favorites, setFavorites] = useState(readSiteFavorites);
  const orderedSites = useMemo(() => sortSupportedSites(sites, favorites), [favorites]);
  const filteredSites = orderedSites.filter(site => matchesSiteFilters(site, filters));
  function toggleFavorite(key: string) {
    const next = favorites.includes(key) ? favorites.filter(value => value !== key) : [...favorites, key];
    saveSiteFavorites(next); setFavorites(next);
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => {if (event.key === siteFavoritesKey || event.key === null) setFavorites(readSiteFavorites());};
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
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
    {onImport&&<form className="nc-site-link-import" onSubmit={event=>{event.preventDefault();if(busy)return;setError('');setBusy(true);void onImport(url.trim()).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>
      <label htmlFor="nc-site-url">{msg('通过链接添加漫画')}</label>
      <div><input id="nc-site-url" type="url" required value={url} onChange={event=>{setUrl(event.target.value);setError('');}} placeholder={msg('粘贴漫画详情页或章节链接')} disabled={busy}/><button className="button primary" disabled={busy}><Icon name="plus"/>{busy?msg('正在获取全部章节…'):msg('添加到书架')}</button></div>
      <p>{msg('粘贴已适配网站的漫画详情页或章节链接，读取目录后即可开始阅读。')}</p>
      {error&&<p role="alert">{error} {safeImageUrl(url.trim(),url.trim())&&<a href={url.trim()} target="_blank" rel="noopener noreferrer">{msg('打开来源')}</a>}</p>}
    </form>}
    <div className="nc-sites-layout">
      <section aria-labelledby="nc-sites-title">
        <div className="nc-section-heading nc-sites-section-heading"><div><h1 id="nc-sites-title">{msg('漫画网站')}</h1><span className="nc-muted">{msg('已适配 {0} 个网站', { '0': sites.length })}</span></div><a className="button secondary small nc-site-request-shortcut" href="#sites/request" onClick={event=>{
          if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||location.hash!=='#sites/request')return;
          event.preventDefault();focusRequest();
        }}><Icon name="message" size={16}/>{msg('申请适配网站')}</a></div>
        <SiteFilterControls filters={filters} onChange={setFilters} visibleCount={filteredSites.length} totalCount={sites.length}/>
        {!filteredSites.length && <div className="nc-sites-empty"><Icon name="filter" size={28}/><p>{msg('没有符合条件的网站，请调整或清除筛选。')}</p></div>}
        <ul className="nc-sites-grid">{filteredSites.map(site => {const favorite = favorites.includes(site.key); return <li key={site.key} className="nc-site-card" data-site-key={site.key}>
          <a className="nc-site-card-link" href={site.url} target="_blank" rel="noopener noreferrer" aria-label={`${site.name} · ${pricingLabels[site.pricing].label}${site.isRaw ? ' · ' + msg('生肉') : ''} · ${msg('在新标签页打开')}`}>
            <span className={'nc-site-pricing-badge nc-site-pricing-' + site.pricing} role="img" title={pricingLabels[site.pricing].description} aria-label={pricingLabels[site.pricing].description}><PricingIcon pricing={site.pricing}/></span>
            <div className="nc-site-card-top"><span className="nc-site-monogram" aria-hidden="true"><img src={site.icon} alt="" width={44} height={44} onError={event => { event.currentTarget.hidden = true; }}/><Icon name="globe" size={27}/></span><span className="nc-site-languages">{site.primaryLanguages.map(language => <span key={language} role="img" aria-label={languageLabel(language)} title={languageLabel(language)}><LanguageFlag language={language}/></span>)}</span></div>
            <h3>{site.name}</h3><span className="nc-site-domain">{new URL(site.url).hostname.replace(/^www\./, '')}</span>
            <div className="nc-site-tags">{site.isRaw && <span className="nc-site-raw" title={msg('以未翻译的日语或韩语原文内容为主')}>{msg('生肉')}</span>}{site.contentTags.map(tag=><span key={tag}>{contentTagLabels[tag]}</span>)}</div>
          </a>
          <div className="nc-site-card-footer"><span className="nc-site-adapted">
              <span><span className="nc-site-supported"><Icon name="check" size={15}/>{msg('已适配')}</span>{site.accessTags?.map(tag => <span key={tag} className={'nc-site-access nc-site-access-' + tag} title={accessTagLabels[tag].description} aria-label={accessTagLabels[tag].description}>{accessTagLabels[tag].label}</span>)}</span>
              <time dateTime={site.adaptedOn} title={msg('适配日期')}>{formatDate(site.adaptedOn + 'T00:00:00')}</time>
            </span>
            <button type="button" className="nc-site-favorite" aria-pressed={favorite}
              aria-label={`${msg('收藏网站')} · ${site.name}`} title={favorite ? msg('取消收藏网站') : msg('收藏网站')}
              onClick={() => toggleFavorite(site.key)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2-4.5-4.4 6.3-.9Z"/></svg>
            </button>
          </div>
        </li>;})}</ul>
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
