import {afterEach, describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ComicSites, type SiteDirectoryView} from '../src/ui/ComicSites';
import {SearchScopeSettings} from '../src/ui/comic-search/SearchScopeSettings';
import {emptySiteFilters} from '../src/ui/SiteFilterControls';
import {listSupportedSites} from '../src/sources/registry/sites';
import {listSearchSites} from '../src/sources';
import {installDictionary} from '../src/i18n/runtime';
import english from '../src/i18n/dictionaries/en.json';

vi.mock('../src/ui/SupportRequestForm', () => ({SupportRequestForm: () => null}));
afterEach(() => {vi.unstubAllGlobals(); installDictionary('zh-CN', {});});

describe('comic website directory presentation', () => {
  it('keeps only the nonmodal filters closed and disables bulk actions for no matching sites', () => {
    const html = renderToStaticMarkup(<SearchScopeSettings sites={[]} totalCount={10} filters={emptySiteFilters} onFiltersChange={()=>{}} onSelectionChange={()=>{}} disabled={false}/>);
    expect(html).toContain('aria-haspopup="dialog" aria-expanded="false"');
    expect(html).toContain('class="nc-search-filter-popover" hidden=""');
    expect(html).toContain('popover="auto"');
    expect(html).not.toContain('<dialog');
    expect(html.match(/class="nc-site-filter-group"/g)).toHaveLength(4);
    expect(html).toContain('显示 0 / 10 个网站');
    expect(html).toContain('没有符合条件的网站，请调整或清除筛选。');
    expect(html).toContain('disabled="">全选');
    expect(html).toContain('disabled="">反选');
  });
  it('shows ten inline sites by default while counts and batch actions cover every matching site', () => {
    const sites=listSearchSites().map(site=>({site,selected:true,status:'idle' as const,resultCount:0,resultKeys:[]}));
    expect(sites.length).toBeGreaterThan(10);
    const html=renderToStaticMarkup(<SearchScopeSettings sites={sites} totalCount={sites.length} filters={emptySiteFilters} onFiltersChange={()=>{}} onSelectionChange={()=>{}} disabled={false}/>);
    expect(html.match(/class="nc-search-site-option"/g)).toHaveLength(10);
    expect(html).toContain(`已选 ${sites.length} 个网站`);
    expect(html).toContain(`显示 10 / ${sites.length} 个网站`);
    expect(html).toContain(`展开全部 ${sites.length} 个网站`);
    expect(html).toContain('disabled="">全选');
    expect(html).not.toContain('disabled="">反选');
  });
  const render = (view?: SiteDirectoryView) => {
    vi.stubGlobal('location', new URL('https://fixture.test/#sites'));
    return renderToStaticMarkup(<ComicSites view={view ? {current: view} : undefined}/>);
  };
  it('defaults to two visible groups with advanced filters collapsed and a disabled reset', () => {
    const html = render();
    expect(html.match(/class="nc-site-filter-group"/g)).toHaveLength(4);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(14 + listSupportedSites().length);
    expect(html).toContain(`显示 ${listSupportedSites().length} / ${listSupportedSites().length} 个网站`);
    expect(html).toContain('disabled="">清空筛选');
    expect(html).toContain('同组多选匹配任一项，不同组同时满足。');
    const advancedId = html.match(/aria-expanded="false" aria-controls="([^"]+)"/)?.[1];
    expect(advancedId).toBeTruthy();
    expect(html).toContain(`id="${advancedId}" hidden=""`);
    expect(html).toContain('更多筛选');
    expect(html).not.toContain('DISCOVER YOUR NEXT STORY');
    expect(html).not.toContain('nc-page-heading');
  });
  it('uses labeled SVG payment overlays on every card, not payment text chips', () => {
    const html = render(), sites = listSupportedSites();
    expect(html.match(/class="nc-site-pricing-badge /g)).toHaveLength(sites.length);
    expect(html).toContain('role="img" title="全站漫画免费阅读" aria-label="全站漫画免费阅读"><svg');
    expect(html).toContain('role="img" title="部分漫画或章节需要付费阅读"');
    expect(html).not.toContain('class="nc-site-pricing-badge nc-site-pricing-unknown"');
    expect(html).not.toContain('nc-site-free');
    expect(html).not.toContain('nc-site-access-paid-content');
    expect(html.match(/class="nc-site-raw"/g)).toHaveLength(sites.filter(site => site.isRaw).length);
    expect(html.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(sites.length);
  });
  it('localizes filters, status and raw labels without translating source names', () => {
    installDictionary('en', english);
    const html = render();
    expect(html).toContain('Pricing unconfirmed');
    expect(html).toContain('Mostly raw');
    expect(html).toContain('Western comics');
    expect(html).toContain('Clear filters');
    expect(html).toContain('RawOtaku');
    expect(html).not.toContain('收费待确认');
    expect(html).toContain('Favorite website');
    expect(html).toContain('Search website names or domains');
  });
  it.each([
    ['  ＳＥＡＳＯＮＳ   .COM  ', ['Seasons']],
    ['COMIC-SEASONS.COM', ['Seasons']],
    ['となりのヤングジャンプ', ['となりのヤングジャンプ']],
    ['seasons .org', []],
    ['no-such-fixture-site', []],
  ])('restores and matches a local name/domain query %j', (query, names) => {
    const html = render({query, filters: emptySiteFilters, advanced: true, scrollTop: 250});
    const expected = listSupportedSites().filter(site => names.includes(site.name)).map(site => site.key);
    expect([...html.matchAll(/data-site-key="([^"]+)"/g)].map(match => match[1])).toEqual(expected);
    expect(html).toContain(`显示 ${expected.length} / ${listSupportedSites().length} 个网站`);
    expect(html).toContain('收起筛选');
    expect(html).toContain('清除搜索');
    if (!expected.length) expect(html).toContain('没有符合条件的网站，请调整或清除筛选。');
  });
  it('combines the restored query and grouped filters without exempting favorites', () => {
    const site = listSupportedSites().find(site => site.name === 'Seasons')!;
    vi.stubGlobal('localStorage', {getItem: (key: string) => key === 'nc-site-favorites' ? JSON.stringify([site.key]) : null});
    const html = render({query: 'seasons', filters: {...emptySiteFilters, pricing: ['freemium']}, advanced: false, scrollTop: 0});
    expect(html).not.toContain('data-site-key=');
    expect(html).toContain(`显示 0 / ${listSupportedSites().length} 个网站`);
    expect(html).toContain('aria-pressed="true"');
  });
  it('restores favorite sites at the top with a separate accessible toggle, not a nested link button', () => {
    const site = listSupportedSites().at(-1)!;
    vi.stubGlobal('localStorage', {getItem: (key: string) => key === 'nc-site-favorites' ? JSON.stringify([site.key]) : null});
    const html = render();
    expect(html.match(/data-site-key="([^"]+)"/)?.[1]).toBe(site.key);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('title="取消收藏网站"');
    expect(html).toContain('</a><div class="nc-site-card-footer">');
    expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<button/);
  });
});
