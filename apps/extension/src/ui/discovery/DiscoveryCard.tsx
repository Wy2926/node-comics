import {useState} from 'react';
import type {DiscoveryWork} from '../../discovery/types';
import {Icon} from '../../icons';
import {msg} from '../../i18n/runtime';
import {statusLabels} from './labels';

export function DiscoveryCover({work}: {work: DiscoveryWork}) {
  const [failed, setFailed] = useState<string>();
  return <div className="nc-discovery-cover">
    {work.cover && work.cover !== failed ? <img src={work.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(work.cover)}/> : <Icon name="book" size={40}/>}
  </div>;
}
export function DiscoveryCard({work, onOpen}: {work: DiscoveryWork; onOpen: () => void}) {
  return <button className="nc-discovery-card" onClick={onOpen} aria-label={work.title}>
    <div className="nc-discovery-poster">
      <DiscoveryCover work={work}/>
      <div className="nc-discovery-poster-top">
        {work.score !== undefined && <span className="nc-discovery-score" aria-label={msg('AniList 评分 {0}/100', {'0': work.score})} title={msg('AniList 评分 {0}/100', {'0': work.score})}><Icon name="spark" size={13}/><b>{work.score}</b><small>/100</small></span>}
        {work.status && <span className="nc-discovery-status">{statusLabels()[work.status]}</span>}
      </div>
      <div className="nc-discovery-poster-bottom">
        {work.year && <span className="nc-discovery-year">{work.year}</span>}
        <span className="nc-discovery-genres">{work.genres.slice(0, 2).join(' / ')}</span>
      </div>
    </div>
    <h2 title={work.title}>{work.title}</h2>
  </button>;
}
