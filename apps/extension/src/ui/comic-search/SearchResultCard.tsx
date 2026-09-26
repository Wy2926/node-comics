import {Icon} from '../../icons';
import {msg} from '../../i18n/runtime';
import {languageLabel} from '../../types';
import type {SearchCandidate} from '../../comics/application/search/types';
import {LanguageFlag} from '../LanguageFlag';
import {SearchResultCover} from './SearchResultCover';
import {SearchSiteIcon} from './SearchSiteIcon';

export function SearchResultCard({hit,site,cache,current,existing,importing,error,onImport}:{
  hit:SearchCandidate;site?:{name:string;icon:string};cache:Map<string,string>;
  current:boolean;existing?:boolean;importing?:string;error?:string;onImport:()=>void;
}){
  return <article className="nc-search-result">
    <SearchResultCover hit={hit.coverHit??hit} cache={cache}/>
    <div className="nc-search-result-main">
      <div className="nc-search-result-top">
        <h3 title={hit.title}>{hit.title}</h3>
        <span className="nc-search-result-source" title={site?.name??hit.sourceId}><SearchSiteIcon icon={site?.icon}/><span>{site?.name??hit.sourceId}</span></span>
      </div>
      <p className="nc-search-result-author">{hit.authors?.length?msg('作者：{0}',{'0':hit.authors.join(' / ')}):msg('作者待确认')}</p>
      <div className="nc-search-result-tags">
        {!!hit.contentLanguages?.length&&<div className="nc-search-result-languages">{hit.contentLanguages.map(language=><span key={language} role="img" aria-label={languageLabel(language)} title={languageLabel(language)}><LanguageFlag language={language}/></span>)}</div>}
        {current?<span className="nc-search-library-tag">{msg('当前漫画')}</span>:existing?<span className="nc-search-library-tag">{msg('已在书架')}</span>:null}
      </div>
      <p className="nc-search-result-chapter">{hit.latestLabel??msg('章节信息以来源网站为准')}</p>
      <div className="nc-search-result-bottom">
        <a href={hit.catalogUrl} target="_blank" rel="noopener noreferrer">{msg('打开来源')}<Icon name="external" size={14}/></a>
        <button className="button primary small" disabled={current||!!importing} onClick={onImport}>{importing===hit.key?msg('正在打开…'):current?msg('当前漫画'):existing?msg('继续阅读'):msg('导入并阅读')}<Icon name="arrow" size={16}/></button>
      </div>
      {error&&<p className="nc-search-inline-error" role="alert">{error}</p>}
    </div>
  </article>;
}
