import {useId, useLayoutEffect, useRef, useState} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import type {SiteFilters} from '../../sources';
import type {SearchSiteState} from '../../comics/application/search/types';
import {SiteFilterControls} from '../SiteFilterControls';
import {menuPosition, visibleViewport} from '../visual-viewport';
import {SearchSiteIcon} from './SearchSiteIcon';

const COLLAPSED_SITE_COUNT = 10;

export function SearchScopeSettings({sites, totalCount, filters, onFiltersChange, onSelectionChange, disabled}: {
  sites: readonly SearchSiteState[];
  totalCount: number;
  filters: SiteFilters;
  onFiltersChange: (filters: SiteFilters) => void;
  onSelectionChange: (selection: Readonly<Record<string, boolean>>) => void;
  disabled: boolean;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), expand = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(false), [scopeExpanded, setScopeExpanded] = useState(false);
  const selectedCount = sites.filter(state => state.selected).length;
  const filterCount = Object.values(filters).reduce((count, values) => count + values.length, 0);
  const visibleSites = expanded ? sites : sites.slice(0, COLLAPSED_SITE_COUNT);
  const close = (restore = true) => {setOpen(false); if (restore) trigger.current?.focus({preventScroll: true});};
  useLayoutEffect(() => {
    const button = trigger.current, menu = panel.current;
    if (!open || !button || !menu) return;
    const native = typeof menu.showPopover === 'function';
    if (native) menu.showPopover();
    const position = () => {
      if (!button.getClientRects().length) {close(false); return;}
      const viewport = visibleViewport(), rect = button.getBoundingClientRect();
      menu.style.width = Math.max(0, Math.min(480, viewport.width - 16)) + 'px';
      const bounds = menuPosition(rect, viewport, 480, menu.scrollHeight + 4, 'left');
      for (const [key, value] of Object.entries(bounds)) menu.style[key as 'left' | 'top' | 'width' | 'maxHeight'] = value + 'px';
    };
    position();
    menu.focus({preventScroll: true});
    const observer = new ResizeObserver(position); observer.observe(button); observer.observe(menu);
    const scroll = (event: Event) => {if (event.target !== menu) position();};
    const dismiss = (event: PointerEvent) => {if (!menu.contains(event.target as Node) && !button.contains(event.target as Node)) close(false);};
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    document.addEventListener('scroll', scroll, true);
    if (!native) document.addEventListener('pointerdown', dismiss);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position); window.visualViewport?.removeEventListener('scroll', position);
      document.removeEventListener('scroll', scroll, true); document.removeEventListener('pointerdown', dismiss);
      if (native && menu.matches(':popover-open')) menu.hidePopover();
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!expanded && expand.current === document.activeElement) expand.current?.scrollIntoView({block: 'nearest'});
  }, [expanded]);
  return <section className="nc-search-scope" aria-labelledby={id + '-title'} data-expanded={scopeExpanded}>
    <div className="nc-search-scope-heading">
      <h2 id={id + '-title'}>{msg('搜索范围')}</h2><span role="status">{msg('已选 {0} 个网站', {'0': selectedCount})}</span>
      <button type="button" className="icon-button nc-search-scope-toggle" aria-label={msg('搜索范围')} aria-expanded={scopeExpanded} aria-controls={id + '-actions ' + id + '-body'} onClick={() => {setScopeExpanded(value => !value); setOpen(false);}}><Icon name="chevron" size={18}/></button>
      <div id={id + '-actions'} className="nc-search-selection-actions" role="group" aria-label={msg('搜索范围')}>
        <button type="button" className="button secondary small" disabled={disabled || !sites.length || selectedCount === sites.length} onClick={() => onSelectionChange(Object.fromEntries(sites.map(state => [state.site.key, true])))}>{msg('全选')}</button>
        <button type="button" className="button secondary small" disabled={disabled || !sites.length} onClick={() => onSelectionChange(Object.fromEntries(sites.map(state => [state.site.key, !state.selected])))}>{msg('反选')}</button>
        <button ref={trigger} type="button" className="button secondary small nc-search-scope-trigger" disabled={disabled}
          aria-haspopup="dialog" aria-expanded={open} aria-controls={id + '-filters'} data-filtered={filterCount > 0 || undefined}
          onClick={() => setOpen(value => !value)}><Icon name="filter" size={16}/>{msg('筛选')}{filterCount > 0 && <b>{filterCount}</b>}</button>
      </div>
    </div>
    <div className="nc-search-scope-body" id={id + '-body'}>
    <p className="nc-search-scope-help">{msg('仅搜索符合筛选条件且已勾选的网站，修改仅影响下次搜索。')}</p>
    <div ref={panel} id={id + '-filters'} popover="auto" role="dialog" tabIndex={-1} aria-label={msg('筛选')} className="nc-search-filter-popover" hidden={!open}
      data-popover-fallback-open={open && typeof HTMLElement.prototype.showPopover !== 'function' || undefined}
      onToggle={event => {if (event.newState === 'closed') setOpen(false);}}
      onKeyDown={event => {event.stopPropagation(); if (event.key === 'Escape') {event.preventDefault(); close();}}}
      onBlur={event => {if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close(false);}}>
      <div className="nc-drawer-title"><h2>{msg('筛选')}</h2><button type="button" className="icon-button" aria-label={msg('关闭面板')} onClick={() => close()}><Icon name="close"/></button></div>
      <SiteFilterControls filters={filters} onChange={onFiltersChange} visibleCount={sites.length} totalCount={totalCount}/>
      <p className="nc-search-scope-help">{msg('各网站仅按搜索名称查询，不按内容语言筛选。')}</p>
    </div>
    {!sites.length && <p className="nc-search-notice" role="status">{msg('没有符合条件的网站，请调整或清除筛选。')}</p>}
    <div className="nc-search-site-options" id={id + '-sites'}>{visibleSites.map(state => <label className="nc-search-site-option" key={state.site.key}><input type="checkbox" checked={state.selected} disabled={disabled} onChange={event => onSelectionChange({[state.site.key]: event.target.checked})}/><SearchSiteIcon icon={state.site.icon}/><b title={state.site.name}>{state.site.name}</b></label>)}</div>
    <div className="nc-search-scope-summary"><span>{msg('显示 {0} / {1} 个网站', {'0': visibleSites.length, '1': sites.length})}</span>{sites.length > COLLAPSED_SITE_COUNT && <button ref={expand} type="button" className="nc-search-text-button nc-search-scope-expand" aria-expanded={expanded} aria-controls={id + '-sites'} onClick={() => setExpanded(value => !value)}>{expanded ? msg('收起网站') : msg('展开全部 {0} 个网站', {'0': sites.length})}<Icon name="chevron" size={14}/></button>}</div>
    </div>
  </section>;
}
