import { formatDate, msg } from '../i18n/runtime';
import { Icon } from '../icons';
import { listSupportedSites, matchesSiteFilters, safeImageUrl, type SiteFilters, type SourceSiteAccessTag, type SourceSiteContentTag, type SourceSitePricing } from '../sources';
import { SupportRequestForm } from './SupportRequestForm';
import { LanguageFlag } from './LanguageFlag';
import { languageLabel } from '../types';
import './comic-sites.css';
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';

const sites = listSupportedSites();
const emptyFilters: SiteFilters = {content: [], pricing: [], raw: [], access: []};

function FilterGroup<T extends string | boolean>({label, options, selected, onChange}: {
  label: string; options: {value: T; label: string; icon?: ReactNode}[];
  selected: readonly T[]; onChange: (values: T[]) => void;
}) {
  return <fieldset className="nc-site-filter-group"><legend>{label}</legend><div>
    {options.map(option => {
      const active = selected.includes(option.value);
      return <button key={String(option.value)} type="button" className="nc-comic-tag" aria-pressed={active}
        onClick={() => onChange(active ? selected.filter(value => value !== option.value) : [...selected, option.value])}>
        {option.icon}{option.label}
      </button>;
    })}
  </div></fieldset>;
}

function PricingIcon({pricing}: {pricing: SourceSitePricing}) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {pricing === 'free' ? <><circle cx="12" cy="12" r="9"/><path d="M9 9V8h5M10 12h4v4H9m3-10v2m0 8v2M5 19 19 5"/></> : pricing === 'freemium' ? <><path d="M6 5a8 8 0 1 1-3 8"/><circle cx="10" cy="14" r="7"/><path d="M12 11H9a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3H8m2-7v8"/></> : <><path d="m12 2 9 5v10l-9 5-9-5V7Z"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/></>}
  </svg>;
}

export function ComicSites({onImport}:{onImport?:(url:string)=>Promise<void>}) {
  const contentTagLabels: Record<SourceSiteContentTag, string> = {
    manga: msg('日漫'), manhwa: msg('韩漫'), manhua: msg('国漫'), webtoon: msg('条漫'), doujin: msg('同人'), illustration: msg('插画'),
  };
  const accessTagLabels: Record<SourceSiteAccessTag, {label: string; description: string}> = {
    'login-required': {label: msg('需要登录'), description: msg('部分漫画或章节需要登录账号才能阅读')},
    'partial-web': {label: msg('网页只开放部分'), description: msg('网页仅开放部分章节，其余内容需在 App 阅读')},
  };
  const pricingLabels: Record<SourceSitePricing, {label: string; description: string}> = {
    free: {label: msg('免费'), description: msg('全站漫画免费阅读')},
    freemium: {label: msg('部分收费'), description: msg('部分漫画或章节需要付费阅读')},
    unknown: {label: msg('收费待确认'), description: msg('尚未确认全站收费规则，请以源站说明为准')},
  };
  const [filters, setFilters] = useState<SiteFilters>(emptyFilters);
  const [advanced, setAdvanced] = useState(false);
  const advancedCount = filters.raw.length + filters.access.length;
  const filteredSites = sites.filter(site => matchesSiteFilters(site, filters));
  const hasFilters = Object.values(filters).some(values => values.length > 0);
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
        <div className="nc-site-filters" role="group" aria-label={msg('筛选')}>
          <FilterGroup label={msg('收费类型')} options={Object.entries(pricingLabels).map(([value, entry]) => ({value: value as SourceSitePricing, label: entry.label, icon: <span className={'nc-site-pricing-color nc-site-pricing-' + value}><PricingIcon pricing={value as SourceSitePricing}/></span>}))} selected={filters.pricing} onChange={pricing => setFilters(previous => ({...previous, pricing}))}/>
          <FilterGroup label={msg('内容类型')} options={Object.entries(contentTagLabels).map(([value, label]) => ({value: value as SourceSiteContentTag, label}))} selected={filters.content} onChange={content => setFilters(previous => ({...previous, content}))}/>
          <div id="nc-site-advanced-filters" hidden={!advanced}>
            <FilterGroup label={msg('内容版本')} options={[{value: true, label: msg('生肉为主')}, {value: false, label: msg('非生肉为主')}]} selected={filters.raw} onChange={raw => setFilters(previous => ({...previous, raw}))}/>
            <FilterGroup label={msg('访问条件')} options={Object.entries(accessTagLabels).map(([value, entry]) => ({value: value as SourceSiteAccessTag, label: entry.label}))} selected={filters.access} onChange={access => setFilters(previous => ({...previous, access}))}/>
            <p className="nc-site-filter-help">{msg('同组多选匹配任一项，不同组同时满足。')}</p>
          </div>
          <div className="nc-site-filter-summary"><span role="status">{msg('显示 {0} / {1} 个网站', {'0': filteredSites.length, '1': sites.length})}</span><div className="nc-site-filter-actions"><button type="button" disabled={!hasFilters} onClick={() => setFilters(emptyFilters)}>{msg('清空筛选')}</button><button className="nc-site-filter-toggle" type="button" aria-expanded={advanced} aria-controls="nc-site-advanced-filters" onClick={() => setAdvanced(value => !value)}><Icon name="filter" size={16}/>{advanced ? msg('收起筛选') : msg('更多筛选')}{advancedCount > 0 && <b>{advancedCount}</b>}<Icon name="chevron" size={12}/></button></div></div>
        </div>
        {!filteredSites.length && <div className="nc-sites-empty"><Icon name="filter" size={28}/><p>{msg('没有符合条件的网站，请调整或清除筛选。')}</p></div>}
        <ul className="nc-sites-grid">{filteredSites.map(site => <li key={site.key}>
          <a className="nc-site-card" href={site.url} target="_blank" rel="noopener noreferrer" aria-label={`${site.name} · ${pricingLabels[site.pricing].label}${site.isRaw ? ' · ' + msg('生肉') : ''} · ${msg('在新标签页打开')}`}>
            <span className={'nc-site-pricing-badge nc-site-pricing-' + site.pricing} role="img" title={pricingLabels[site.pricing].description} aria-label={pricingLabels[site.pricing].description}><PricingIcon pricing={site.pricing}/></span>
            <div className="nc-site-card-top"><span className="nc-site-monogram" aria-hidden="true"><img src={site.icon} alt="" width={44} height={44} onError={event => { event.currentTarget.hidden = true; }}/><Icon name="globe" size={27}/></span><span className="nc-site-languages">{site.primaryLanguages.map(language => <span key={language} role="img" aria-label={languageLabel(language)} title={languageLabel(language)}><LanguageFlag language={language}/></span>)}</span></div>
            <h3>{site.name}</h3><span className="nc-site-domain">{new URL(site.url).hostname.replace(/^www\./, '')}</span>
            <div className="nc-site-tags">{site.isRaw && <span className="nc-site-raw" title={msg('以未翻译的日语或韩语原文内容为主')}>{msg('生肉')}</span>}{site.contentTags.map(tag=><span key={tag}>{contentTagLabels[tag]}</span>)}</div>
            <div className="nc-site-card-footer"><span className="nc-site-adapted">
              <span><span className="nc-site-supported"><Icon name="check" size={15}/>{msg('已适配')}</span>{site.accessTags?.map(tag => <span key={tag} className={'nc-site-access nc-site-access-' + tag} title={accessTagLabels[tag].description} aria-label={accessTagLabels[tag].description}>{accessTagLabels[tag].label}</span>)}</span>
              <time dateTime={site.adaptedOn} title={msg('适配日期')}>{formatDate(site.adaptedOn + 'T00:00:00')}</time>
            </span><Icon name="external" size={18}/></div>
          </a>
        </li>)}</ul>
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
