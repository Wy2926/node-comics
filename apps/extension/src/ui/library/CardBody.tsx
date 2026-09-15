import type {ReactNode} from 'react';

/** Reserve every text row and action slot, even when a value is missing. */
export function CardBody({eyebrow,title,heading:Heading='h3',onTitle,metadata,children}:{eyebrow:string;title:string;heading?:'h2'|'h3';onTitle?:()=>void;metadata:readonly [string,string,...string[]];children:ReactNode}){
 return <div className="nc-library-card-body">
  <span className="nc-card-kicker" title={eyebrow}>{eyebrow}</span>
  <Heading className="nc-card-title" title={title}>{onTitle?<button onClick={onTitle}>{title}</button>:<span>{title}</span>}</Heading>
  <div className="nc-card-meta">{metadata.map((line,index)=><p key={index} title={line||undefined} aria-hidden={!line||undefined}>{line}</p>)}</div>
  <div className="nc-library-card-actions">{children}</div>
 </div>;
}
