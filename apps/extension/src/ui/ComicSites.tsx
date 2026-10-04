import { formatDate, msg } from '../i18n/runtime';
import { Icon } from '../icons';
import { listSupportedSites, type SourceSiteAccessTag, type SourceSiteContentTag } from '../sources';
import { SupportRequestForm } from './SupportRequestForm';
import { LanguageFlag } from './LanguageFlag';
import { languageLabel } from '../types';
import './comic-sites.css';
import {useEffect, useRef, useState} from 'react';

const sites = listSupportedSites();

export function ComicSites({onImport}:{onImport?:(url:string)=>Promise<void>}) {
  const contentTagLabels: Record<SourceSiteContentTag, string> = {
    manga: msg('日漫'), manhwa: msg('韩漫'), manhua: msg('国漫'), webtoon: msg('条漫'), doujin: msg('同人'),
  };
  const accessTagLabels: Record<SourceSiteAccessTag, {label: string; description: string}> = {
    'login-required': {label: msg('需要登录'), description: msg('部分漫画或章节需要登录账号才能阅读')},
    'partial-web': {label: msg('网页只开放部分'), description: msg('网页仅开放部分章节，其余内容需在 App 阅读')},
    'paid-content': {label: msg('部分收费'), description: msg('部分漫画或章节需要付费阅读')},
  };
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
        requestSection.current?.scrollIntoView({block:'center'});
        requestSection.current?.querySelector<HTMLInputElement>('.nc-support-form fieldset input')?.focus({preventScroll:true});
      });
    };
    locateRequest();
    window.addEventListener('hashchange',locateRequest);
    return()=>{cancelAnimationFrame(frame);window.removeEventListener('hashchange',locateRequest);};
  },[]);
  return <div className="nc-sites-page">
    <div className="nc-page-heading"><div><span className="nc-eyebrow">{msg('DISCOVER YOUR NEXT STORY')}</span><h1>{msg('漫画网站')}</h1><p>{msg('打开已适配的网站，把喜欢的故事带回书架。')}</p></div><span className="nc-sites-heading-icon" aria-hidden="true"><Icon name="globe" size={42}/><Icon name="spark" size={20}/></span></div>
    {onImport&&<form className="nc-site-link-import" onSubmit={event=>{event.preventDefault();if(busy)return;setError('');setBusy(true);void onImport(url.trim()).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>
      <label htmlFor="nc-site-url">{msg('通过链接添加漫画')}</label>
      <div><input id="nc-site-url" type="url" required value={url} onChange={event=>setUrl(event.target.value)} placeholder={msg('粘贴漫画详情页或章节链接')} disabled={busy}/><button className="button primary" disabled={busy}><Icon name="plus"/>{busy?msg('正在获取全部章节…'):msg('添加到书架')}</button></div>
      <p>{msg('粘贴已适配网站的漫画详情页或章节链接，读取目录后即可开始阅读。')}</p>
      {error&&<p role="alert">{error}</p>}
    </form>}
    <div className="nc-sites-layout">
      <section aria-labelledby="nc-sites-title">
        <div className="nc-section-heading nc-sites-section-heading"><h2 id="nc-sites-title">{msg('已适配 {0} 个网站', { '0': sites.length })}</h2><span className="nc-muted"><Icon name="external" size={15}/>{msg('在新标签页打开')}</span></div>
        <ul className="nc-sites-grid">{sites.map(site => <li key={site.key}>
          <a className="nc-site-card" href={site.url} target="_blank" rel="noopener noreferrer" aria-label={`${site.name} · ${msg('在新标签页打开')}`}>
            <div className="nc-site-card-top"><span className="nc-site-monogram" aria-hidden="true"><img src={site.icon} alt="" width={44} height={44} onError={event => { event.currentTarget.hidden = true; }}/><Icon name="globe" size={27}/></span><span className="nc-site-languages">{site.primaryLanguages.map(language => <span key={language} role="img" aria-label={languageLabel(language)} title={languageLabel(language)}><LanguageFlag language={language}/></span>)}</span></div>
            <h3>{site.name}</h3><span className="nc-site-domain">{new URL(site.url).hostname.replace(/^www\./, '')}</span>
            <div className="nc-site-tags">{site.contentTags.map(tag=><span key={tag}>{contentTagLabels[tag]}</span>)}</div>
            <div className="nc-site-card-footer"><span className="nc-site-adapted">
              <span><span className="nc-site-supported"><Icon name="check" size={15}/>{msg('已适配')}</span>{site.isFree === true&&<span className="nc-site-free" title={msg('全站漫画免费阅读')} aria-label={msg('全站漫画免费阅读')}>{msg('免费')}</span>}{site.accessTags?.map(tag => <span key={tag} className={'nc-site-access nc-site-access-' + tag} title={accessTagLabels[tag].description} aria-label={accessTagLabels[tag].description}>{accessTagLabels[tag].label}</span>)}</span>
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
