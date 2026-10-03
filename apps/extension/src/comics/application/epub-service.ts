import {catalog} from '../repositories';
import {openFileSource} from '../sources/runtime';
import {openEpub} from '../formats/epub';
import {entrySource} from './entry-source';
import {epubImageDescriptor, epubImageId} from '../domain/epub-images';
import {loadPageViews} from './library-service';

/** Only the bounded on-screen image window is converted into translation page views. */
export async function loadEpubImagePages(entryId:string,contentId:string,hrefs:readonly string[],scopeKey?:string,signal?:AbortSignal) {
  const binding=await entrySource(entryId,contentId,signal);
  const entry=binding.entry;
  if(entry.format!=='epub')throw Error('电子书索引缺失，请重新打开。');
  const descriptors=[...new Set(hrefs)].slice(0,4).flatMap(href=>{
    const descriptor=epubImageDescriptor(entry.document,contentId,epubImageId(href));
    return descriptor?[descriptor]:[];
  });
  const pages=await loadPageViews(entry,descriptors,scopeKey);
  await binding.assertCurrent();
  signal?.throwIfAborted();
  return pages;
}

/** Owns the source/format lifetime. The EPUB engine never reads the shelf or provider credentials. */
export async function openEpubEntry(entryId:string,contentId?:string,signal?:AbortSignal) {
  const lifetime=new AbortController();
  const combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
  const binding=await entrySource(entryId,contentId,combined);
  if(binding.entry.format!=='epub'||!binding.entry.document)throw Error('电子书索引缺失，请重新打开。');
  const source=await openFileSource(binding.context);
  let sourceClosing:Promise<void>|undefined;
  const closeSource=()=>sourceClosing??=Promise.resolve(source.close());
  let unsubscribe=()=>{};
  try {
    const session=await openEpub(source,combined);
    let closed=false;
    const close=async()=>{
      if(closed)return;closed=true;unsubscribe();lifetime.abort();
      try{await session.close();}finally{await closeSource();}
    };
    combined.addEventListener('abort',()=>void close(),{once:true});
    await binding.assertCurrent();
    // Enrich older text-only indexes without changing content identity or the saved CFI.
    if(!binding.entry.document.images&&session.index.images) {
      await catalog.mutate(['entries'],async tx=>{
        const entry=await tx.get('entries',entryId);
        if(entry?.contentId===binding.entry.contentId&&entry.generation===binding.entry.generation&&entry.document&&!entry.document.images)
          await tx.put('entries',{...entry,document:{...entry.document,images:session.index.images}});
      });
    }
    unsubscribe=catalog.subscribe(change=>{
      if((change.table==='entries'&&change.ids.includes(entryId))||(change.table==='comics'&&change.ids.includes(binding.comic.id))||(change.table==='connections'&&change.ids.includes(binding.connection.id)))
        void binding.assertCurrent().catch(error=>lifetime.abort(error));
    });
    // Subscription is established before the final check so revocation cannot fall into a gap.
    await binding.assertCurrent();
    return {...session,signal:combined,close};
  }catch(error){unsubscribe();lifetime.abort(error);await closeSource();throw error;}
}
