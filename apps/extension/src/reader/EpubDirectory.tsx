import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {EpubIndex} from '../comics/formats/contracts';
import {flattenEpubToc} from '../comics/formats/epub/navigation';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import './directory.css';

export function EpubDirectory({title, index, href, select}: {
  title: string;
  index: EpubIndex;
  href?: string;
  select(href: string): void;
}) {
  const [search, setSearch] = useState('');
  const [descending, setDescending] = useState(false);
  const [limit, setLimit] = useState(200);
  const list = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const items = useMemo(() => flattenEpubToc(index.toc.length ? index.toc : index.chapters), [index]);
  const current = href?.replace(/^\//, '');
  const active = items.find(item => item.href === current) ?? items.find(item => item.href.split('#')[0] === current?.split('#')[0]);
  const visible = useMemo(() => {
    const found = items.filter(item => item.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    return descending ? found.reverse() : found;
  }, [items, search, descending]);
  const count = Math.max(limit, Math.ceil((visible.indexOf(active!) + 1) / 200) * 200);
  useLayoutEffect(() => {
    const container = list.current;
    const current = container?.querySelector<HTMLElement>('[aria-current="true"]');
    if (container && current) container.scrollTop += current.getBoundingClientRect().top - container.getBoundingClientRect().top - (container.clientHeight - current.clientHeight) / 2;
  }, [active, search, descending]);
  useEffect(() => {
    if (!list.current || !more.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {observer.disconnect(); setLimit(count + 200);}
    }, {root: list.current, rootMargin: '200px 0px'});
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [count, visible.length]);
  return <>
    <div className="nc-comic-directory-heading"><h3>{title}</h3></div>
    <div className="nc-directory-search">
      <input type="search" aria-label={msg('搜索目录')} placeholder={msg('搜索目录')} value={search}
        onChange={event => {setSearch(event.target.value); setLimit(200);}}/>
      <button className="text-link" onClick={() => setDescending(value => !value)}><Icon name={descending ? 'sort-desc' : 'sort-asc'} size={16}/>{descending ? msg('倒序') : msg('正序')}</button>
    </div>
    <div ref={list} className="nc-chapter-list" aria-label={msg('目录')}>
      {visible.slice(0, count).map((item, i) => <div key={`${item.href}:${i}`} className="nc-directory-chapter" data-current={item === active || undefined}
        style={{marginInlineStart: `${Math.min(item.depth, 6)}em`}}>
        <div className="nc-directory-chapter-main"><button className="nc-chapter-entry" aria-current={item === active ? 'true' : undefined} onClick={() => select(item.href)}>
          <span className="nc-chapter-info"><b>{item.label}</b>{item === active && <span className="nc-chapter-meta"><span className="nc-chapter-state current"><Icon name="bookmark" size={16}/><span>{msg('阅读中')}</span></span></span>}</span>
        </button></div>
      </div>)}
      {!visible.length && <p className="nc-directory-empty">{msg('没有匹配的内容')}</p>}
      {visible.length > count && <div ref={more} className="nc-directory-more" aria-hidden="true"/>}
    </div>
  </>;
}
