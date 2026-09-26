/** Discovery metadata is not a readable source or a library identity. */
export type DiscoveryRanking = 'trending' | 'popular' | 'score' | 'newest';
export type PublicationStatus = 'releasing' | 'finished' | 'upcoming' | 'hiatus' | 'cancelled';
export type DiscoveryFormat = 'manga' | 'oneshot';
export interface DiscoveryQuery {
  search: string;
  ranking: DiscoveryRanking;
  genre: string;
  status: PublicationStatus | '';
  year: string;
  country: string;
  format: DiscoveryFormat | '';
}
export const defaultDiscoveryQuery: DiscoveryQuery = {
  search: '', ranking: 'trending', genre: '', status: '', year: '', country: '', format: '',
};
export interface DiscoveryWork {
  id: number;
  title: string;
  titles: string[];
  cover?: string;
  year?: number;
  status?: PublicationStatus;
  format?: DiscoveryFormat;
  score?: number;
  genres: string[];
  url: string;
}
export interface DiscoveryDetail extends DiscoveryWork {
  description: string;
  contributors: {name: string; role: string}[];
}
export interface DiscoveryPageResult {
  works: DiscoveryWork[];
  hasMore: boolean;
}
export interface DiscoveryProvider {
  readonly genres: readonly string[];
  list(query: DiscoveryQuery, page: number, signal: AbortSignal): Promise<DiscoveryPageResult>;
  detail(id: number, signal: AbortSignal): Promise<DiscoveryDetail>;
}
export class DiscoveryError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid' | 'rate-limit', readonly retryAt?: number) {
    super(kind);
  }
}
