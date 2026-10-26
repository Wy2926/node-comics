import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {compactReaderQuery, ReaderPosition} from '../src/reader/ReaderChrome';

it('exposes the committed page without another input or tab stop', () => {
  const html = renderToStaticMarkup(<ReaderPosition label="Page 12 of 120" value={12} total={120}/>);
  expect(html).toContain('aria-label="Page 12 of 120"');
  expect(html).toContain('data-value="12"');
  expect(html).not.toMatch(/<input|tabindex/);
});
it('includes document progress alongside the chapter count', () => {
  const html = renderToStaticMarkup(<ReaderPosition label="Chapter 2 of 5 · 30%" value={2} total={5} progress={30}/>);
  expect(html).toContain('30%');
  expect(html).toContain('data-value="2"');
});

it('keeps compact reader CSS and directory behavior aligned for short no-hover screens', () => {
  const css = readFileSync(new URL('../src/reader/mobile.css', import.meta.url), 'utf8');
  const media = [...css.matchAll(/@media\s*([^{]+)\{/g)].map(match => match[1].trim());
  expect(media[0]).toBe(compactReaderQuery);
  expect(compactReaderQuery.split(', ')).toEqual([
    '(max-width: 700px)',
    '(max-width: 1000px) and (max-height: 500px) and (pointer: coarse)',
    '(max-width: 1000px) and (max-height: 500px) and (hover: none)',
  ]);
  expect(media.at(-1)).toBe(compactReaderQuery.split(', ').slice(1)
    .map(query => ('(min-width: 520px) and ' + query).replace(' and (pointer:', ' and (orientation: landscape) and (pointer:')
      .replace(' and (hover:', ' and (orientation: landscape) and (hover:')).join(', '));
});
