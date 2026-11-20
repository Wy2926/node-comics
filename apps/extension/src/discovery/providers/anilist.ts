import {
  DiscoveryError, type DiscoveryDetail, type DiscoveryQuery, type WorkProvider, type WorkReview,
  type DiscoveryRanking, type DiscoveryWork, type PublicationStatus,
} from '../types';

const endpoint = 'https://graphql.anilist.co';
const siteOrigin = 'https://anilist.co';
const sorts: Record<DiscoveryRanking, string> = {
  trending: 'TRENDING_DESC', popular: 'POPULARITY_DESC', score: 'SCORE_DESC', newest: 'START_DATE_DESC',
};
const statuses: Record<PublicationStatus, string> = {
  releasing: 'RELEASING', finished: 'FINISHED', upcoming: 'NOT_YET_RELEASED', hiatus: 'HIATUS', cancelled: 'CANCELLED',
};
const summaryFields = `id title { native english romaji }
  startDate { year } status format averageScore genres`;
const listQuery = `query DiscoverManga($page: Int!, $search: String, $sort: [MediaSort],
  $genre: String, $status: MediaStatus, $year: String, $country: CountryCode, $formats: [MediaFormat], $before: FuzzyDateInt) {
  Page(page: $page, perPage: 24) {
    pageInfo { hasNextPage }
    media(type: MANGA, isAdult: false, search: $search, sort: $sort, genre: $genre,
      status: $status, startDate_like: $year, countryOfOrigin: $country, format_in: $formats,
      startDate_lesser: $before) { ${summaryFields} coverImage { large } }
  }
}`;
const detailQuery = `query DiscoverMangaDetail($id: Int!) {
  Media(id: $id, type: MANGA, isAdult: false, format_in: [MANGA, ONE_SHOT]) {
    ${summaryFields} coverImage { extraLarge } synonyms description(asHtml: false)
    staff(perPage: 12) { edges { role node { name { full } } } }
  }
}`;
const matchQuery = `query MatchManga($id: Int, $search: String, $sort: [MediaSort]) {
  Page(page: 1, perPage: 12) {
    media(id: $id, search: $search, sort: $sort, type: MANGA, isAdult: false, format_in: [MANGA, ONE_SHOT]) {
      ${summaryFields} coverImage { large } synonyms
    }
  }
}`;
const reviewsQuery = `query MangaReviews($id: Int!, $page: Int!) {
  Media(id: $id, type: MANGA, isAdult: false, format_in: [MANGA, ONE_SHOT]) {
    id title { native english romaji }
    reviews(page: $page, perPage: 5, sort: [CREATED_AT_DESC, ID_DESC]) {
      pageInfo { hasNextPage }
      nodes { id mediaId private summary body(asHtml: true) score rating ratingAmount createdAt user { name } }
    }
  }
}`;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown, limit = 300): string => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.slice(0, 40).map(item => text(item)).filter(Boolean) : [];
const validId = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const mediaId = (id: string) => {
  if (!/^[1-9]\d{0,9}$/.test(id) || !validId(Number(id))) throw new DiscoveryError('invalid');
  return Number(id);
};

function work(value: unknown): DiscoveryWork {
  const raw = object(value), names = object(raw.title);
  const titles = [names.native, names.english, names.romaji].map(value => text(value)).filter(Boolean);
  if (!validId(raw.id) || !titles.length) throw new DiscoveryError('invalid');
  const id = String(raw.id), cover = text(object(raw.coverImage).extraLarge ?? object(raw.coverImage).large, 2048), year = object(raw.startDate).year;
  const status = (Object.keys(statuses) as PublicationStatus[]).find(key => statuses[key] === raw.status);
  return {
    id, title: titles[0], titles: [...new Set([...titles, ...strings(raw.synonyms)])], url: `${siteOrigin}/manga/${id}`,
    cover: /^https:\/\/(?:[a-z0-9-]+\.)?anilist\.co\//i.test(cover) ? cover : undefined,
    year: typeof year === 'number' && year > 0 ? year : undefined,
    score: typeof raw.averageScore === 'number' && raw.averageScore > 0 && raw.averageScore <= 100 ? raw.averageScore : undefined,
    status, format: raw.format === 'MANGA' ? 'manga' : raw.format === 'ONE_SHOT' ? 'oneshot' : undefined,
    genres: strings(raw.genres),
  };
}

/** Public, credential-free metadata only. No source cookies, library writes or title translation. */
export function createAniListProvider(fetcher: typeof fetch = fetch, now = Date.now) {
  let retryAt = 0;
  async function request(query: string, variables: ObjectValue, signal: AbortSignal): Promise<ObjectValue> {
    if (retryAt > now()) throw new DiscoveryError('rate-limit', retryAt);
    try {
      const response = await fetcher(endpoint, {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({query, variables}), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (response.status === 429) {
        const header = response.headers.get('Retry-After');
        const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : undefined;
        const date = header ? Date.parse(header) : NaN;
        retryAt = Math.max(now() + 1000, seconds !== undefined ? now() + seconds * 1000 : Number.isFinite(date) ? date : now() + 60_000);
        throw new DiscoveryError('rate-limit', retryAt);
      }
      if (!response.ok) throw new DiscoveryError('unavailable');
      const payload = object(await response.json());
      if (Array.isArray(payload.errors) && payload.errors.length) throw new DiscoveryError('unavailable');
      if (!payload.data) throw new DiscoveryError('invalid');
      return object(payload.data);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof DiscoveryError ? error : new DiscoveryError('unavailable');
    }
  }
  const catalog = {
    genres: ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'],
    async list(query: DiscoveryQuery, page, signal) {
      const date = new Date(now());
      date.setDate(date.getDate() + 1);
      const data = await request(listQuery, {
        page, search: query.search || undefined, sort: [sorts[query.ranking], 'ID_DESC'],
        genre: query.genre || undefined, status: query.status ? statuses[query.status] : undefined,
        year: query.year ? `${query.year}%` : undefined, country: query.country || undefined,
        formats: query.format ? [query.format === 'oneshot' ? 'ONE_SHOT' : 'MANGA'] : ['MANGA', 'ONE_SHOT'],
        // "New releases" excludes future publications; the explicit upcoming filter can override it.
        before: query.ranking === 'newest' && query.status !== 'upcoming'
          ? date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate() : undefined,
      }, signal);
      const result = object(data.Page), pageInfo = object(result.pageInfo);
      if (!Array.isArray(result.media) || result.media.length > 24 || typeof pageInfo.hasNextPage !== 'boolean') throw new DiscoveryError('invalid');
      return {works: result.media.map(work), hasMore: result.media.length > 0 && pageInfo.hasNextPage};
    },
    async detail(id, signal): Promise<DiscoveryDetail> {
      const data = await request(detailQuery, {id: mediaId(id)}, signal), raw = object(data.Media), summary = work(raw);
      if (summary.id !== id) throw new DiscoveryError('invalid');
      const edges = object(raw.staff).edges;
      return {
        ...summary,
        // Render as text only. Never insert provider HTML into the extension DOM.
        description: text(raw.description, 16_000).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''),
        contributors: Array.isArray(edges) ? edges.slice(0, 12).flatMap(edge => {
          const item = object(edge), name = text(object(object(item.node).name).full), role = text(item.role);
          return name && /^(?:Story(?: & Art)?|Art|Original (?:Creator|Story))$/i.test(role) ? [{name, role}] : [];
        }) : [],
      };
    },
  } satisfies NonNullable<WorkProvider['catalog']>;
  return {
    id: 'anilist', label: 'AniList', catalog,
    async search(input, signal) {
      const query = input.trim();
      if (!query) return [];
      let id: number | undefined;
      if (/^id:/i.test(query)) {
        id = Number(/^id:\s*([1-9]\d*)$/i.exec(query)?.[1]);
      } else if (/^(?:[a-z][\w+.-]*:\/\/|\/\/|(?:https?|file|data|javascript|mailto):)/i.test(query)) {
        // Never forward an unrecognized URL (or its query string) as a title.
        if (!URL.canParse(query)) return [];
        const url = new URL(query);
        if (url.origin !== siteOrigin || url.username || url.password) return [];
        id = Number(/^\/manga\/([1-9]\d*)(?:\/|$)/.exec(url.pathname)?.[1]);
      }
      if (id !== undefined && !validId(id)) return [];
      const data = await request(matchQuery, id ? {id} : {search: query.slice(0, 300), sort: ['SEARCH_MATCH']}, signal);
      const rows = object(data.Page).media;
      if (!Array.isArray(rows) || rows.length > 12 || id && rows.some(row => object(row).id !== id)) throw new DiscoveryError('invalid');
      return rows.map(work);
    },
    async reviews(workId, page, signal) {
      if (!validId(page)) throw new DiscoveryError('invalid');
      const data = await request(reviewsQuery, {id: mediaId(workId), page}, signal);
      const raw = object(data.Media), summary = work(raw), connection = object(raw.reviews);
      const {nodes} = connection, {hasNextPage} = object(connection.pageInfo);
      if (summary.id !== workId || !Array.isArray(nodes) || nodes.length > 5 || typeof hasNextPage !== 'boolean') throw new DiscoveryError('invalid');
      const reviews = nodes.map<WorkReview>(value => {
        const r = object(value);
        if (!validId(r.id) || r.mediaId !== raw.id || r.private !== false) throw new DiscoveryError('invalid');
        const liked = r.rating, total = r.ratingAmount;
        return {
          id: String(r.id), author: text(object(r.user).name), summary: text(r.summary, 1000),
          body: typeof r.body === 'string' && r.body.length <= 256_000 ? r.body.trim() : '', bodyFormat: 'html',
          score: typeof r.score === 'number' && r.score >= 0 && r.score <= 100 ? r.score : undefined,
          votes: typeof liked === 'number' && typeof total === 'number' && Number.isSafeInteger(liked) && Number.isSafeInteger(total) &&
            liked >= 0 && liked <= total ? {liked, total} : undefined,
          postedAt: validId(r.createdAt) ? r.createdAt * 1000 : undefined,
          url: `${siteOrigin}/review/${r.id}`,
        };
      });
      return {work: {title: summary.title, url: summary.url}, reviews, hasMore: nodes.length > 0 && hasNextPage};
    },
  } satisfies WorkProvider;
}

export const provider = createAniListProvider();
