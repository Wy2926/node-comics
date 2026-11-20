import {useCallback, type ReactNode} from 'react';
import {readReviewPage} from '../../discovery/reviews';
import type {WorkProvider} from '../../discovery/types';
import {CommentFeed} from './CommentFeed';
import {WorkReviewCard} from './CommentCards';

export function WorkReviews({provider, workId, children}: {provider: WorkProvider; workId: string; children?: ReactNode}) {
  const read = useCallback(async (cursor: string | undefined, signal: AbortSignal) => {
    const page = Number(cursor ?? 1), result = await readReviewPage(provider, workId, page, signal);
    return {items: result.reviews, source: result.work, next: result.hasMore ? String(page + 1) : undefined};
  }, [provider, workId]);
  return <CommentFeed key={JSON.stringify([provider.id,workId])} provider={provider.label} read={read} action={children}>{item => <WorkReviewCard review={item}/>}</CommentFeed>;
}
