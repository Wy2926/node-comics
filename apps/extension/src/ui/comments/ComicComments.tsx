import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {linkedWorkId} from '../../comics/application/work-links';
import type {Comic} from '../../comics/domain';
import {workProviders} from '../../discovery/registry';
import type {WorkProvider} from '../../discovery/types';
import {msg} from '../../i18n/runtime';
import {chapterDiscussion} from '../../sources';
import {Icon} from '../../icons';
import type {ReadingEntry} from '../../types';
import {WorkProviderSelect} from '../discovery/WorkProviderSelect';
import {WorkReviews} from './WorkReviews';
import {CommentFeed} from './CommentFeed';
import {ChapterCommentCard} from './CommentCards';
import {WorkLinkEditor} from './WorkLinkEditor';

function WorkLinkPanel({comic, provider, linked}: {comic: Comic; provider: WorkProvider; linked?: string | null}) {
  const [editing, setEditing] = useState<string>();
  const showEditor = !linked || editing === linked;
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const previous = useRef({showEditor, linked});
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = {showEditor, linked};
    if (from.linked !== linked) setEditing(undefined);
    if ((from.showEditor !== showEditor || from.linked !== linked) && document.activeElement === document.body)
      (showEditor ? input.current : trigger.current)?.focus({preventScroll:true});
  }, [showEditor, linked]);
  if (showEditor) return <WorkLinkEditor key={linked ?? ''} comic={comic} provider={provider} linked={linked} inputRef={input} onCancel={() => setEditing(undefined)}/>;
  const edit = <button ref={trigger} className="text-link" onClick={() => setEditing(linked)}>{msg('更换关联')}</button>;
  return provider.reviews ? <WorkReviews provider={provider} workId={linked}>{edit}</WorkReviews> : <>
    <div className="nc-comment-meta"><b>{provider.label}</b>{edit}</div><p className="nc-comment-scroll nc-comment-empty">{msg('暂无公开评论')}</p>
  </>;
}

export function ComicComments({comic, chapter}: {comic: Comic; chapter?: Pick<ReadingEntry,'sourceUrl'|'sourceEntryId'|'title'>}) {
  const [selected, select] = useState(() => (workProviders.find(provider => linkedWorkId(comic, provider.id)) ?? workProviders[0]).id);
  const provider = workProviders.find(value => value.id === selected)!;
  const linked = linkedWorkId(comic, provider.id);
  const discussion = useMemo(() => chapter?.sourceUrl && chapter.sourceEntryId && comic.source.status === 'active'
    ? chapterDiscussion(chapter.sourceUrl, chapter.sourceEntryId, comic.source.providerItemId) : undefined,
    [chapter?.sourceUrl, chapter?.sourceEntryId, comic.source.status, comic.source.providerItemId]);
  const [scope, setScope] = useState<'chapter'|'work'>('chapter');
  return <>
    {discussion && <div className="nc-comment-scopes" role="group" aria-label={msg('评论')}>
      <button aria-pressed={scope === 'chapter'} onClick={() => setScope('chapter')}>{msg('本章评论')}</button>
      <button aria-pressed={scope === 'work'} onClick={() => setScope('work')}>{msg('作品评论')}</button>
    </div>}
    {discussion && scope === 'chapter' ? <>
      <div className="nc-comment-meta"><a href={discussion.url} target="_blank" rel="noopener noreferrer">{discussion.label} <Icon name="external" size={12}/></a>
        <span title={chapter?.title}>{chapter?.title}</span></div>
      <CommentFeed key={discussion.key} provider={discussion.label} read={discussion.read}>{item => <ChapterCommentCard item={item}/>}</CommentFeed>
    </> : <>
      <WorkProviderSelect providers={workProviders} value={selected} onChange={select}/>
      <WorkLinkPanel key={JSON.stringify([comic.id, selected])} provider={provider} comic={comic} linked={linked}/>
    </>}
  </>;
}
