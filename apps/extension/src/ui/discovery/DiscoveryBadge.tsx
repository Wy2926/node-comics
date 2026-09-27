import type {ReactNode} from 'react';
import {Icon} from '../../icons';

const illustratedGenres = new Set(['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller']);

export function DiscoveryGenreBadge({genre}: {genre: string}) {
  const icon = illustratedGenres.has(genre) ? `genre-${genre.toLowerCase().replaceAll(' ', '-')}` : 'bookmark';
  return <DiscoveryBadge kind="genre" icon={icon}>{genre}</DiscoveryBadge>;
}

/** Stretch the paper, not its outline or the readable text. */
export function DiscoveryBadge({kind, icon, children, className = ''}: {
  kind: 'status' | 'format' | 'genre' | 'alias';
  icon: string;
  children: ReactNode;
  className?: string;
}) {
  const outline = kind === 'alias'
    ? 'M3 3 116 2 116 31 22 32 14 38 14 32 3 32Z'
    : 'M8 2 116 3 114 34 3 35 3 9Z';
  return <span className={`nc-discovery-badge is-${kind} ${className}`}>
    <svg className="nc-discovery-badge-paper" viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path className="nc-discovery-badge-shadow" d={outline} transform="translate(2 2)"/>
      <path className="nc-discovery-badge-outline" d={outline} vectorEffect="non-scaling-stroke"/>
    </svg>
    <Icon name={icon} size={kind === 'genre' ? 22 : 18}/><span>{children}</span>
  </span>;
}
