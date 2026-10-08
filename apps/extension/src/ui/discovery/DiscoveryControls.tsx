import {useEffect, useRef, useState} from 'react';
import type {DiscoveryQuery, DiscoveryRanking} from '../../discovery/types';
import {defaultDiscoveryQuery} from '../../discovery/types';
import {msg} from '../../i18n/runtime';
import {Select, SelectOption} from '../Select';
import {formatLabels, genreLabel, rankingLabels, statusLabels} from './labels';
import {Icon} from '../../icons';

interface Props {
  query: DiscoveryQuery;
  genres: readonly string[];
  count: number;
  loading: boolean;
  refreshDisabled: boolean;
  onChange: (query: DiscoveryQuery) => void;
  onRefresh: () => void;
}
export function DiscoveryControls({query, genres, count, loading, refreshDisabled, onChange, onRefresh}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [filtering, setFiltering] = useState(false);
  const searching = draft !== null;
  const input = useRef<HTMLInputElement>(null), searchButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {if (searching) input.current?.focus({preventScroll: true});}, [searching]);
  const rankings = rankingLabels(), currentYear = new Date().getFullYear();
  const countries: Record<string, string> = {JP: msg('日本'), KR: msg('韩国'), CN: msg('中国'), TW: msg('台湾')};
  const fields: {key: 'genre' | 'status' | 'year' | 'country' | 'format'; label: string; values: Record<string, string>}[] = [
    {key: 'genre', label: msg('题材'), values: Object.fromEntries(genres.map(value => [value, genreLabel(value)]))},
    {key: 'status', label: msg('连载状态'), values: statusLabels()},
    {key: 'year', label: msg('年份'), values: Object.fromEntries(Array.from({length: currentYear - 1939}, (_, index) => {const year = String(currentYear - index); return [year, year];}))},
    {key: 'country', label: msg('地区'), values: countries},
    {key: 'format', label: msg('形式'), values: formatLabels()},
  ];
  const active = fields.filter(field => query[field.key]);
  const filter = (field: typeof fields[number]) => <label key={field.key} className="nc-discovery-filter">
    <span>{field.label}</span>
    <Select value={query[field.key]} aria-label={field.label} onChange={event => onChange({...query, [field.key]: event.target.value})}>
      <SelectOption value="">{msg('全部')}</SelectOption>
      {Object.entries(field.values).map(([value, label]) => <SelectOption value={value} key={value}>{label}</SelectOption>)}
    </Select>
  </label>;
  return <div className="nc-discovery-controls">
    <div className="nc-discovery-toolbar">
      <div className="nc-discovery-overview">
        <div className="nc-discovery-rankings" role="group" aria-label={msg('榜单')}>
          {(Object.keys(rankings) as DiscoveryRanking[]).map(key => <button key={key} type="button" aria-pressed={query.ranking === key} className={query.ranking === key ? 'active' : undefined} onClick={() => onChange({...query, ranking: key})}><Icon name={{trending:'bolt',popular:'chart',score:'crown',newest:'spark'}[key]} size={20}/>{rankings[key]}</button>)}
        </div>
        <div className="nc-discovery-count" role="status"><strong>{loading ? msg('加载中…') : msg('{0} 部作品', {'0': count})}</strong></div>
      </div>
      <div className="nc-discovery-tools">
        <div className="nc-discovery-search-slot">
          {draft !== null ? <form className="nc-discovery-search" onSubmit={event => {event.preventDefault(); onChange({...query, search: draft.trim()});}}>
            <Icon name="search" size={18}/>
            <input ref={input} value={draft} maxLength={120} enterKeyHint="search" aria-label={msg('搜索作品名称')} placeholder={msg('搜索作品名称')}
              onChange={event => setDraft(event.target.value)} onBlur={() => setDraft(null)}
              onKeyDown={event => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                setDraft(null);
                queueMicrotask(() => searchButton.current?.focus({preventScroll: true}));
              }}/>
          </form> : <button ref={searchButton} className="nc-discovery-tool" aria-label={msg('搜索作品名称')} onClick={() => setDraft(query.search)}><Icon name="search"/><span>{msg('搜索')}</span></button>}
        </div>
        <button className="nc-discovery-tool" aria-label={msg('更多筛选')} aria-expanded={filtering} onClick={() => setFiltering(value => !value)}><Icon name="filter"/>{active.length > 0 && <b>{active.length}</b>}</button>
        <button className="nc-discovery-tool" aria-label={msg('刷新')} title={msg('刷新')} disabled={refreshDisabled} onClick={onRefresh}><Icon name="refresh"/></button>
      </div>
    </div>
    {filtering && <div className="nc-discovery-filter-row">{fields.map(filter)}</div>}
    {(active.length > 0 || query.search) && <div className="nc-discovery-chips">
      {query.search && <button className="nc-discovery-chip" aria-label={msg('清除搜索')} onClick={() => onChange({...query, search: ''})}><Icon name="search" size={13}/>{query.search}<Icon name="close" size={13}/></button>}
      {active.map(field => <button className="nc-discovery-chip" key={field.key} onClick={() => onChange({...query, [field.key]: ''})} aria-label={msg('移除筛选：{0}', {'0': field.label})}>{field.values[query[field.key]]}<Icon name="close" size={13}/></button>)}
      {active.length > 0 && <button className="nc-search-text-button" onClick={() => onChange({...defaultDiscoveryQuery, ranking: query.ranking, search: query.search})}>{msg('清空筛选')}</button>}
    </div>}
  </div>;
}
