import {parseHTML} from 'linkedom';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {reviewMarkup} from '../src/ui/comments/review-markup';

it('rebuilds formatted reviews with public images; hidden spoilers and foreign attributes cannot leak into the preview or the page', () => {
  vi.stubGlobal('document', parseHTML('<html></html>').document);
  try {
    const url = 'https://example.org/review/23', body = `<p><em>Opening</em> <a href="/notes" style="color:red">notes</a></p>
      <span class="markdown_spoiler"><span>Ending<img src="https://example.org/ending.jpg"></span></span>
      <figure><img src="/panel.jpg" srcset="/unapproved.jpg 2x" alt="A panel"></figure>
      <blockquote>Quote</blockquote><form>Form contents</form><svg><text>Foreign contents</text></svg>
      <a href="file:///unapproved">label</a><img src="https://user@example.org/unapproved.jpg">`;
    const result = reviewMarkup({url, body, bodyFormat:'html'});
    expect(result.cover).toEqual({src:'https://example.org/panel.jpg',alt:'A panel'});
    expect(result.more).toBe(true);
    const preview = renderToStaticMarkup(<>{result.preview}</>), full = renderToStaticMarkup(<>{result.full}</>);
    expect(preview).toContain('<em>Opening</em>');
    expect(full).toContain('<blockquote>Quote</blockquote>'); expect(full).toContain('href="https://example.org/notes"');
    expect(full).toContain('src="https://example.org/panel.jpg"'); expect(full).toContain('referrerPolicy="no-referrer"');
    expect(full + preview).not.toMatch(/Ending|ending\.jpg|unapproved|color:red|Form contents|Foreign contents/);
    expect(renderToStaticMarkup(<>{reviewMarkup({url, body:'<em>literal</em>'}).full}</>)).toBe('&lt;em&gt;literal&lt;/em&gt;');
  } finally {vi.unstubAllGlobals();}
});
