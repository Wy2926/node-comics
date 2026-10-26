import {useId, useState, type ReactNode} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import type {SiteFilters, SourceSiteAccessTag, SourceSiteContentTag, SourceSitePricing} from '../sources';
import './site-filters.css';

export const emptySiteFilters: SiteFilters = {content: [], pricing: [], raw: [], access: []};

export function siteLabels() {
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
  return {contentTagLabels, accessTagLabels, pricingLabels};
}

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

export function PricingIcon({pricing}: {pricing: SourceSitePricing}) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {pricing === 'free' ? <><circle cx="12" cy="12" r="9"/><path d="M9 9V8h5M10 12h4v4H9m3-10v2m0 8v2M5 19 19 5"/></> : pricing === 'freemium' ? <><path d="M6 5a8 8 0 1 1-3 8"/><circle cx="10" cy="14" r="7"/><path d="M12 11H9a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3H8m2-7v8"/></> : <><path d="m12 2 9 5v10l-9 5-9-5V7Z"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/></>}
  </svg>;
}

export function SiteFilterControls({filters, onChange, visibleCount, totalCount, expanded, onExpandedChange}: {
  filters: SiteFilters; onChange: (filters: SiteFilters) => void; visibleCount: number; totalCount: number;
  expanded?: boolean; onExpandedChange?: (expanded: boolean) => void;
}) {
  const {contentTagLabels, accessTagLabels, pricingLabels} = siteLabels();
  const [localAdvanced, setLocalAdvanced] = useState(false), advancedId = useId();
  const advanced = expanded ?? localAdvanced, setAdvanced = onExpandedChange ?? setLocalAdvanced;
  const advancedCount = filters.raw.length + filters.access.length;
  const hasFilters = Object.values(filters).some(values => values.length > 0);
  return <div className="nc-site-filters" role="group" aria-label={msg('筛选')}>
    <FilterGroup label={msg('收费类型')} options={Object.entries(pricingLabels).map(([value, entry]) => ({value: value as SourceSitePricing, label: entry.label, icon: <span className={'nc-site-pricing-color nc-site-pricing-' + value}><PricingIcon pricing={value as SourceSitePricing}/></span>}))} selected={filters.pricing} onChange={pricing => onChange({...filters, pricing})}/>
    <FilterGroup label={msg('内容类型')} options={Object.entries(contentTagLabels).map(([value, label]) => ({value: value as SourceSiteContentTag, label}))} selected={filters.content} onChange={content => onChange({...filters, content})}/>
    <div id={advancedId} hidden={!advanced}>
      <FilterGroup label={msg('内容版本')} options={[{value: true, label: msg('生肉为主')}, {value: false, label: msg('非生肉为主')}]} selected={filters.raw} onChange={raw => onChange({...filters, raw})}/>
      <FilterGroup label={msg('访问条件')} options={Object.entries(accessTagLabels).map(([value, entry]) => ({value: value as SourceSiteAccessTag, label: entry.label}))} selected={filters.access} onChange={access => onChange({...filters, access})}/>
      <p className="nc-site-filter-help">{msg('同组多选匹配任一项，不同组同时满足。')}</p>
    </div>
    <div className="nc-site-filter-summary"><span role="status">{msg('显示 {0} / {1} 个网站', {'0': visibleCount, '1': totalCount})}</span><div className="nc-site-filter-actions"><button type="button" disabled={!hasFilters} onClick={() => onChange(emptySiteFilters)}>{msg('清空筛选')}</button><button className="nc-site-filter-toggle" type="button" aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced(!advanced)}><Icon name="filter" size={16}/>{advanced ? msg('收起筛选') : msg('更多筛选')}{advancedCount > 0 && <b>{advancedCount}</b>}<Icon name="chevron" size={12}/></button></div></div>
  </div>;
}
