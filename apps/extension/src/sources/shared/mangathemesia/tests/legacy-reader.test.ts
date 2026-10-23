import {afterEach, describe, expect, it, vi} from 'vitest';
import {createMangaThemesiaNetwork} from '../network';
import {canonical, catalogHtml, chapter, legacyReaderHtml, minimalReaderHtml, pageUrl, readerHtml, sites, work} from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('verified minimal MangaThemesia reader', () => {
  const minimal = createMangaThemesiaNetwork({...sites[0], reader: 'minimal'});
  const url = sites[0].chapterUrl(chapter, work), html = minimalReaderHtml(sites[0]);
  it('requires opt-in, modern access flags and matching HTML/JSON without duplicating pages', () => {
    expect(minimal.parsePages(html, url)).toMatchObject({discoveryComplete: true, knownTotal: 2});
    expect(() => createMangaThemesiaNetwork(sites[0]).parsePages(html, url)).toThrow();
    expect(() => minimal.parsePages(readerHtml(sites[0]), url)).toThrow();
    expect(() => minimal.parsePages(legacyReaderHtml(sites[0]), url)).toThrow();
    for (const changed of [
      html.replace('"protected":false', '"protected":true'),
      html.replace('"protected":false,', ''),
      html.replace('"unlock_token":null', '"unlock_token":"locked"'),
      html.replace('"contentmode":"minimal"', '"contentmode":"unknown"'),
      html.replace('"defaultSource":"Server 1"', '"defaultSource":"Other"'),
      html.replace(/<img\b[^>]*>/, ''),
      html.replace('src="', 'src="https://foreign.invalid/'),
    ]) expect(() => minimal.parsePages(changed, url)).toThrow();
  });
});

const site = {...sites[0], reader: 'legacy-ready' as const}, engine = createMangaThemesiaNetwork(site);
const url = site.chapterUrl(chapter, work), html = () => legacyReaderHtml(site);

describe('verified legacy MangaThemesia public reader', () => {
  it('requires explicit opt-in and matching HTML/JSON; repeated URLs remain separate page slots', () => {
    const parsed = engine.parsePages(html(), url);
    expect(parsed).toMatchObject({discoveryComplete: true, knownTotal: 2});
    expect(parsed.items.map(item => item.id)).toEqual(['page-0', 'page-1']);
    expect(parsed.items.map(item => item.resource)).toEqual(Array(2).fill({kind: 'http', url: pageUrl(site)}));
    expect(() => createMangaThemesiaNetwork(sites[0]).parsePages(html(), url)).toThrow();
    expect(() => engine.parsePages(readerHtml(site), url)).toThrow();
  });

  it('never executes initialization, history, image hooks or view-count code', async () => {
    const never = vi.fn(() => {throw Error('must not execute');});
    for (const name of ['jQuery', 'Hooks', 'HISTORY', 'loadChList', 'eval', 'fetch']) vi.stubGlobal(name, never);
    const request = vi.fn(async () => html());
    await engine.network.pages(url, {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(site.chapterUrl(chapter));
    expect(never).not.toHaveBeenCalled();
  });

  it('accepts identical canonical duplicates but rejects missing, conflicting or empty evidence', () => {
    const catalogUrl = site.catalogUrl(work);
    for (const [original, target, parse] of [[catalogHtml(site), catalogUrl, engine.parseCatalog], [html(), url, engine.parsePages]] as const) {
      const href = target.split('#')[0];
      expect(() => parse(original.replace('</head>', canonical(href) + '</head>'), target)).not.toThrow();
      for (const extra of [canonical(site.catalogUrl('other')), '<link rel="canonical">', canonical('')]) {
        expect(() => parse(original.replace('</head>', extra + '</head>'), target)).toThrow();
      }
      expect(() => parse(original.replace(canonical(href), ''), target)).toThrow();
    }
  });

  it.each(['missing-dom', 'extra-dom', 'wrong-dom', 'reordered-dom', 'empty-json', 'two-sources', 'single-mode',
    'protected', 'token', 'novel', 'new-access-schema', 'missing-default', 'missing-source', 'iframe', 'truncated'] as const)('rejects %s without falling back to another list', kind => {
    const images = [pageUrl(site, 0), pageUrl(site, 1)];
    let value = legacyReaderHtml(site, images);
    if (kind === 'missing-dom') value = value.replace(/<img\b[^>]*>/, '');
    if (kind === 'extra-dom') value = value.replace('</p>', `<img src="${images[0]}"></p>`);
    if (kind === 'wrong-dom') value = value.replace(`src="${images[0]}"`, `src="${pageUrl(site, 9)}"`);
    if (kind === 'reordered-dom') value = value.replace(`src="${images[0]}"`, 'src="temporary"').replace(`src="${images[1]}"`, `src="${images[0]}"`).replace('src="temporary"', `src="${images[1]}"`);
    if (kind === 'empty-json') value = value.replace(JSON.stringify(images), '[]');
    if (kind === 'two-sources') value = value.replace('"sources":[', '"sources":[{"source":"Other","images":[]},');
    if (kind === 'single-mode') value = value.replace('"mode":"full"', '"mode":"single"');
    if (kind === 'protected') value = value.replace('"mode":"full"', '"protected":true,"mode":"full"');
    if (kind === 'token') value = value.replace('"mode":"full"', '"unlock_token":"restricted","mode":"full"');
    if (kind === 'novel') value = value.replace('"mode":"full"', '"is_novel":true,"mode":"full"');
    if (kind === 'new-access-schema') value = value.replace('"mode":"full"', '"protected":false,"mode":"full"');
    if (kind === 'missing-default') value = value.replace('"defaultSource":"Server 1",', '');
    if (kind === 'missing-source') value = value.replace('"source":"Server 2",', '');
    if (kind === 'iframe') value = value.replace('</p>', '<iframe></iframe></p>');
    if (kind === 'truncated') value = value.slice(0, -7);
    expect(() => engine.parsePages(value, url)).toThrow();
  });

  it.each(['string', 'template', 'comment', 'nested', 'conditional', 'expression', 'duplicate', 'bad-json', 'external', 'inert-type',
    'inert-html', 'bad-wrapper', 'unterminated-string', 'unbalanced', 'regex'] as const)('rejects %s call instead of extracting arbitrary image arrays', kind => {
    let value = html();
    const call = /ts_reader\.run\(\{[^\n]*\}\);/.exec(value)![0];
    let replacement = call;
    if (kind === 'string') replacement = 'var text = ' + JSON.stringify(call) + ';';
    if (kind === 'template') replacement = 'var text = `' + call + '`;';
    if (kind === 'comment') replacement = '/*' + call + '*/';
    if (kind === 'nested') replacement = 'function later(){' + call + '}';
    if (kind === 'conditional') replacement = 'if (false) ' + call;
    if (kind === 'expression') replacement = call.replace('run(', 'run(globalThis.value = ');
    if (kind === 'duplicate') replacement = call + call;
    if (kind === 'bad-json') replacement = call.replace('"mode"', 'mode');
    if (kind === 'external') value = value.replace('<script>', '<script src="">');
    if (kind === 'inert-type') value = value.replace('<script>', '<script type="application/json">');
    if (kind === 'inert-html') value = value.replace('<script>', '<noscript><script>').replace('</script>', '</script></noscript>');
    if (kind === 'bad-wrapper') value = value.replace('jQuery(document).ready', 'unknown');
    if (kind === 'unterminated-string') replacement = '"' + call;
    if (kind === 'unbalanced') replacement = ']' + call;
    if (kind === 'regex') replacement = '/ignored/;' + call;
    expect(() => engine.parsePages(value.replace(call, replacement), url)).toThrow();
  });

  it('ignores unrelated scripts and string/comment decoys without ever running them', () => {
    const value = html().replace('var post_id = 42;', '/* ts_reader.run({"ignored":true}); */ var text="ts_reader.run({})"; var post_id = 42;')
      .replace('</body>', '<script>jQuery(document).ready(function ($) {unrelated();});</script></body>');
    expect(engine.parsePages(value, url).knownTotal).toBe(2);
  });
});
