import {afterEach, describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ComicSites} from '../src/ui/ComicSites';
import {listSupportedSites} from '../src/sources/registry/sites';
import {installDictionary} from '../src/i18n/runtime';
import english from '../src/i18n/dictionaries/en.json';

vi.mock('../src/ui/SupportRequestForm', () => ({SupportRequestForm: () => null}));
afterEach(() => {vi.unstubAllGlobals(); installDictionary('zh-CN', {});});

describe('comic website directory presentation', () => {
  const render = () => {
    vi.stubGlobal('location', new URL('https://fixture.test/#sites'));
    return renderToStaticMarkup(<ComicSites/>);
  };
  it('defaults to two visible groups with advanced filters collapsed and a disabled reset', () => {
    const html = render();
    expect(html.match(/class="nc-site-filter-group"/g)).toHaveLength(4);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(13);
    expect(html).toContain(`显示 ${listSupportedSites().length} / ${listSupportedSites().length} 个网站`);
    expect(html).toContain('disabled="">清空筛选');
    expect(html).toContain('同组多选匹配任一项，不同组同时满足。');
    expect(html).toContain('id="nc-site-advanced-filters" hidden=""');
    expect(html).toContain('aria-expanded="false" aria-controls="nc-site-advanced-filters"');
    expect(html).toContain('更多筛选');
    expect(html).not.toContain('DISCOVER YOUR NEXT STORY');
    expect(html).not.toContain('nc-page-heading');
  });
  it('uses labeled SVG payment overlays on every card, not payment text chips', () => {
    const html = render(), sites = listSupportedSites();
    expect(html.match(/class="nc-site-pricing-badge /g)).toHaveLength(sites.length);
    expect(html).toContain('role="img" title="全站漫画免费阅读" aria-label="全站漫画免费阅读"><svg');
    expect(html).toContain('role="img" title="部分漫画或章节需要付费阅读"');
    expect(html).toContain('role="img" title="尚未确认全站收费规则，请以源站说明为准"');
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
    expect(html).toContain('Clear filters');
    expect(html).toContain('RawOtaku');
    expect(html).not.toContain('收费待确认');
  });
});
