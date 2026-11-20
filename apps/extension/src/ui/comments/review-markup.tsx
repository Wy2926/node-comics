import {createElement, useState, type ReactNode} from 'react';
import type {WorkReview} from '../../discovery/types';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {safeImageUrl} from '../../sources/shared/urls';

type Picture = {src: string; alt: string; width?: number; height?: number};
export function ReviewImage({src, alt, width, height}: Picture) {
  const [failed, setFailed] = useState<string>();
  return failed === src ? <span className="nc-review-image-fallback"><Icon name="image" size={16}/>{alt || msg('书评配图')} · {msg('图片暂不可用')}</span>
    : <img src={src} alt={alt || msg('书评配图')} width={width} height={height} loading="lazy" decoding="async" crossOrigin="anonymous" referrerPolicy="no-referrer" onError={() => setFailed(src)}/>;
}

function Spoiler({inline, children}: {inline: boolean; children: ReactNode}) {
  const [open, setOpen] = useState(false), Tag = inline ? 'span' : 'div';
  return <Tag className="nc-review-spoiler"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
    {open ? msg('隐藏剧透') : msg('显示剧透')}</button>{open && children}</Tag>;
}

const tags = new Set('p div section article span center h1 h2 h3 h4 h5 h6 br hr strong b em i u s del mark small sup sub a img figure figcaption picture blockquote ul ol li pre code details summary table thead tbody tfoot tr th td'.split(' '));
const breaks = new Set('p div section article center h1 h2 h3 h4 h5 h6 br hr li blockquote pre figcaption tr'.split(' '));
const limit = 185;
const dimension = (value: string | null) => value && /^[1-9]\d{0,3}$/.test(value) ? Number(value) : undefined;

/** Parse in an inert template; only reconstructed elements and validated URLs reach the extension page. */
export function reviewMarkup({body, bodyFormat, url}: Pick<WorkReview, 'body'|'bodyFormat'|'url'>) {
  if (bodyFormat !== 'html') return {full: body, preview: body.length > limit ? body.slice(0, limit) + '…' : body,
    more: body.length > limit || body.split('\n', 4).length > 3, cover: undefined};

  const template = document.createElement('template');
  template.innerHTML = body;
  const preview: ReactNode[] = [];
  let length = 0, blocks = 0, hasSpoiler = false, paragraphComplete = false, clipped = false, cover: Picture | undefined;
  function collect(text: string, mark?: string) {
    const run = text.replace(/\s+/g, ' ');
    if (!paragraphComplete) {
      const part = run.slice(0, Math.max(0, limit - length));
      if (part) preview.push(mark ? createElement(mark, {key:preview.length}, part) : part);
      if (part.length < run.length) clipped = true;
    }
    length += run.length;
  }
  function render(parent: ParentNode, depth: number, hidden = false, mark?: string): ReactNode[] {
    if (depth > 48) return [];
    return Array.from(parent.childNodes, (node, key) => {
      if (node.nodeType === 3) {
        const text = node.textContent ?? '';
        if (!hidden) collect(text, mark);
        return text;
      }
      if (node.nodeType !== 1) return null;
      const el = node as Element, tag = el.localName;
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !tags.has(tag)) return null;
      if (tag === 'details' || el.classList.contains('markdown_spoiler') || el.classList.contains('spoiler')) {
        hasSpoiler = true;
        return <Spoiler key={key} inline={tag === 'span'}>{render(el, depth + 1, true)}</Spoiler>;
      }
      if (tag === 'img') {
        const src = safeImageUrl(el.getAttribute('src') ?? '', url);
        if (!src?.startsWith('https://')) return null;
        const picture = {src, alt:(el.getAttribute('alt') ?? '').slice(0, 300), width:dimension(el.getAttribute('width')), height:dimension(el.getAttribute('height'))};
        if (!hidden) cover ??= picture;
        return <ReviewImage key={key} {...picture}/>;
      }
      if (!hidden && breaks.has(tag)) {blocks++; collect(' ');}
      if (tag === 'br' || tag === 'hr') return createElement(tag, {key});
      const children = render(el, depth + 1, hidden, /^(?:strong|b|em|i|code)$/.test(tag) ? tag : mark);
      if (!hidden && tag === 'p' && length >= 32) paragraphComplete = true;
      if (tag === 'a') {
        const href = safeImageUrl(el.getAttribute('href') ?? '', url);
        return href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span key={key}>{children}</span>;
      }
      const safeTag = /^h[1-6]$/.test(tag) ? `h${Math.min(6, Number(tag[1]) + 3)}` :
        ['center','section','article'].includes(tag) ? 'div' : ['summary','picture'].includes(tag) ? 'span' : tag;
      return createElement(safeTag, {key}, children);
    });
  }
  const full = render(template.content, 0);
  if (clipped) preview.push('…');
  return {full, preview, cover, more: !!cover || hasSpoiler || blocks > 3 || length > limit};
}
