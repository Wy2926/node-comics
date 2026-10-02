import {useEffect, useRef, useState} from 'react';
import type {DiscoveryWork} from '../../discovery/types';
import {Icon} from '../../icons';
import {msg} from '../../i18n/runtime';
import {genreLabel, statusLabels} from './labels';
import type {TextTranslationSession} from '../../text-translation';
import {useTextTranslation} from './useTextTranslation';
import {TextTranslationStatus} from './TextTranslationStatus';

export function DiscoveryCover({work}: {work: DiscoveryWork}) {
  const [failed, setFailed] = useState<string>();
  return <div className="nc-discovery-cover">
    {work.cover && work.cover !== failed ? <img src={work.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(work.cover)}/> : <Icon name="book" size={40}/>}
  </div>;
}
export function DiscoveryCard({work, onOpen, translator, language, translate}: {
  work: DiscoveryWork; onOpen: () => void; translator: TextTranslationSession; language: string; translate: boolean;
}) {
  const element = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false), [original, setOriginal] = useState(false);
  useEffect(() => {
    if (!translate || !element.current) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    observer.observe(element.current);
    return () => {observer.disconnect(); setVisible(false);};
  }, [translate]);
  useEffect(() => setOriginal(false), [language]);
  const result = useTextTranslation(translator, work.title, language, translate && visible);
  const title = !original && translate && result.text ? result.text : work.title;
  return <div ref={element} className="nc-discovery-card-entry"><button className="nc-discovery-card" onClick={onOpen} aria-label={title}>
    <div className="nc-discovery-poster">
      <DiscoveryCover work={work}/>
      <div className="nc-discovery-poster-top">
        {work.score !== undefined && <span className="nc-discovery-score" aria-label={msg('AniList 评分 {0}/100', {'0': work.score})} title={msg('AniList 评分 {0}/100', {'0': work.score})}><Icon name="spark" size={13}/><b>{work.score}</b><small>/100</small></span>}
        {work.status && <span className="nc-discovery-status">{statusLabels()[work.status]}</span>}
      </div>
      <div className="nc-discovery-poster-bottom">
        {work.year && <span className="nc-discovery-year">{work.year}</span>}
        <span className="nc-discovery-genres">{work.genres.slice(0, 2).map(genreLabel).join(' / ')}</span>
      </div>
    </div>
    <h2 title={title}>{title}</h2>
  </button>
    {translate && <TextTranslationStatus pending={result.pending} error={result.error} translated={!!result.text} original={original} onOriginal={() => setOriginal(value => !value)} onRetry={result.retry}/>}
  </div>;
}
