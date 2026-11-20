import {useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {WorkReview} from '../../discovery/types';
import type {ChapterCommentPage} from '../../sources';
import {formatDate, getLocale, msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {ReviewImage, reviewMarkup} from './review-markup';

function Byline({author, postedAt}: {author: string; postedAt?: number}) {
  const name = author || msg('匿名读者');
  return <div className="nc-comment-byline">
    <span className="nc-comment-initial" aria-hidden="true">{[...name.trim()][0]}</span>
    <div><strong dir="auto">{name}</strong>
      {postedAt !== undefined && <time dateTime={new Date(postedAt).toISOString()}>{formatDate(postedAt)}</time>}</div>
  </div>;
}

export function ChapterCommentCard({item}: {item: ChapterCommentPage['items'][number]}) {
  const [open, setOpen] = useState(false), id = useId();
  const long = item.body.length > 220 || item.body.split('\n', 4).length > 3;
  return <article className="nc-chapter-post">
    <Byline author={item.author} postedAt={item.postedAt}/>
    <div id={id}>{(!item.spoiler || open) && <p dir="auto" className={long && !open ? 'is-preview' : undefined}>{item.body}</p>}</div>
    {(item.spoiler || long) && <button className="nc-comment-fold" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {item.spoiler ? open ? msg('隐藏剧透') : msg('显示剧透') : open ? msg('收起全文') : msg('展开全文')}<Icon name="chevron" size={13}/></button>}
  </article>;
}

function Score({score}: {score: number}) {
  return <div className="nc-review-score" role="meter" aria-label={msg('作者评分')} aria-valuenow={score} aria-valuemin={0} aria-valuemax={100}>
    <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20"/><circle cx="24" cy="24" r="20" pathLength="100" strokeDasharray={`${score} 100`}/></svg>
    <b>{score}<i>/100</i></b><small>{msg('作者评分')}</small>
  </div>;
}

function Votes({liked, total}: NonNullable<WorkReview['votes']>) {
  const ratio = total ? liked / total : 0, locale = getLocale();
  return <div className="nc-review-votes">
    <div><Icon name="genre-romance" size={15}/><span>{total ? msg('{total} 位读者中有 {liked} 位喜欢这篇书评', {
      total:total.toLocaleString(locale), liked:liked.toLocaleString(locale),
    }) : msg('暂无读者投票')}</span>{total > 0 && <b aria-hidden="true">{ratio.toLocaleString(locale, {style:'percent'})}</b>}</div>
    {total > 0 && <div className="nc-review-tally" aria-hidden="true"><i style={{width:`${ratio * 100}%`}}/></div>}
  </div>;
}

export function WorkReviewCard({review}: {review: WorkReview}) {
  const content = useMemo(() => reviewMarkup(review), [review.body, review.bodyFormat, review.url]);
  const [open, setOpen] = useState(false), id = useId();
  const prose = review.bodyFormat === 'html' ? 'nc-review-prose' : 'nc-review-prose is-plain';
  const card = useRef<HTMLElement>(null), actions = useRef<HTMLElement>(null), toggled = useRef(false);
  useLayoutEffect(() => {
    if (!toggled.current) return;
    const list = card.current?.closest<HTMLElement>('.nc-comment-scroll');
    if (!list || !card.current || !actions.current) return;
    const bounds = list.getBoundingClientRect(), target = (open ? actions.current : card.current).getBoundingClientRect();
    if (open ? target.bottom > bounds.top + bounds.height * .5 : target.top < bounds.top)
      list.scrollTop += target.top - bounds.top - 6;
  }, [open]);
  return <article ref={card} className="nc-review-card" data-open={open || undefined}>
    <header><Byline author={review.author} postedAt={review.postedAt}/>{review.score !== undefined && <Score score={review.score}/>}</header>
    <div className="nc-review-lead">
      {!open && content.cover && <div className="nc-review-cover"><ReviewImage {...content.cover}/></div>}
      <div>{review.summary && <h3 dir="auto">{review.summary}</h3>}
        {!open && content.more && <div className="nc-review-excerpt" dir="auto">{content.preview}</div>}
        {!content.more && <div className={prose} dir="auto">{content.full}</div>}
      </div>
    </div>
    {review.votes && <Votes {...review.votes}/>}
    <footer ref={actions} className="nc-review-actions">
      {content.more && <button type="button" className="nc-comment-fold" aria-expanded={open} aria-controls={id}
        onClick={() => {toggled.current = true; setOpen(!open);}}>{open ? msg('收起全文') : msg('展开全文')}<Icon name="chevron" size={14}/></button>}
      {open && <span className="nc-review-running-title" dir="auto" aria-hidden="true">{review.summary}</span>}
      <a href={review.url} target="_blank" rel="noopener noreferrer">{msg('查看原文')}<Icon name="external" size={13}/></a>
    </footer>
    {content.more && <div id={id} className={prose} dir="auto" hidden={!open}>{open && content.full}</div>}
  </article>;
}
