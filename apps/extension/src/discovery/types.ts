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
  id: string;
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
  detail(id: string, signal: AbortSignal): Promise<DiscoveryDetail>;
}
export interface WorkRef {providerId: string; workId: string}
export interface WorkReview {
  id: string;
  author: string;
  summary: string;
  body: string;
  bodyFormat?: 'html' | 'text';
  score?: number;
  votes?: {liked: number; total: number};
  postedAt?: number;
  url: string;
}
export interface WorkReviewPage {
  work: Pick<DiscoveryWork, 'title' | 'url'>;
  reviews: WorkReview[];
  hasMore: boolean;
}
/** Metadata identities belong to the provider; browsing and reviews are independent capabilities. */
export interface WorkProvider {
  readonly id: string;
  readonly label: string;
  readonly catalog?: DiscoveryProvider;
  search(input: string, signal: AbortSignal): Promise<DiscoveryWork[]>;
  reviews?(workId: string, page: number, signal: AbortSignal): Promise<WorkReviewPage>;
}
export class DiscoveryError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid' | 'rate-limit', readonly retryAt?: number) {
    super(kind);
  }
}
