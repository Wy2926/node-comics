import type {SourcePageContext, SourcePageSession} from '../../contracts/page';
import {gigaViewerPage} from './page';
import {json, text, type GigaViewerSerialProtocol} from './serial-protocol';

/** Work metadata and inline pages share the same episode/series ownership checks. */
export function gigaViewerSerialPage(context: SourcePageContext, protocol: GigaViewerSerialProtocol): SourcePageSession {
  const session = gigaViewerPage(context, protocol.parsePages);
  return {...session,
    describeWork() {
      session.snapshot();
      const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
      if (context.location.sourceId !== protocol.sourceId || context.location.kind === 'other') return unavailable;
      try {
        const canonical = context.document.querySelectorAll('link[rel="canonical"]');
        const data = context.document.querySelectorAll('#episode-json');
        if (canonical.length !== 1 || data.length !== 1) return unavailable;
        const reader = protocol.parseReaderData(json(text(data[0].getAttribute('data-value'), 4_000_000)),
          text(canonical[0].getAttribute('href'), 8192), context.location.url);
        const title = reader.title.replace(/\s+/gu, ' ').trim();
        if (Array.from(title).length > 2000 || /[\u0000-\u001f\u007f]/u.test(title)) return unavailable;
        return {status: 'ready', value: {title, catalogId: protocol.seriesKey(reader.series), catalogUrl: protocol.catalogUrl(reader.series)}};
      } catch {return unavailable;}
    },
  };
}
