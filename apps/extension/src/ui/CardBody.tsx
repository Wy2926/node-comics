import type {ReactNode} from 'react';

/** Shared original card layout: fixed title space, optional metadata and one action row. */
export function CardBody({eyebrow,title,heading:Heading='h3',onTitle,metadata,children}:{eyebrow?:string;title:string;heading?:'h2'|'h3';onTitle?:()=>void;metadata?:readonly [ReactNode,ReactNode,...ReactNode[]];children:ReactNode}){
 return <div className="nc-library-card-body">
  {eyebrow!==undefined&&<span className="nc-card-kicker" title={eyebrow}>{eyebrow}</span>}
  <Heading className="nc-card-title" title={title}>{onTitle?<button onClick={onTitle}>{title}</button>:<span>{title}</span>}</Heading>
  {metadata&&<div className="nc-card-meta">{metadata.map((line,index)=><p key={index} title={typeof line==='string'&&line?line:undefined} aria-hidden={!line||undefined}>{line}</p>)}</div>}
  <div className="nc-library-card-actions">{children}</div>
 </div>;
}
