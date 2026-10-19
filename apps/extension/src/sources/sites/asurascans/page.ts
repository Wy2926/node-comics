import type {DescribeSourceWork} from '../../contracts/page';
import {asuraLocation, catalogKey} from './definition';
import {chapterNumber, componentPath, location, parseProps, prop, text} from './html';

/** Work metadata only; no extra HTTP request or custom image-discovery session. */
export const describeWork: DescribeSourceWork = ({document, location: source, signal}) => {
  signal.throwIfAborted();
  const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
  try {
    const loc = asuraLocation(new URL(source.url));
    if (!loc || source.sourceId !== 'asurascans') return unavailable;
    const links = document.querySelectorAll('link[rel="canonical"]');
    if (links.length > 1 || loc.chapter === undefined && links.length !== 1) return unavailable;
    const canonical = links.length ? location(links[0].getAttribute('href') ?? '') : loc;
    if (canonical.work !== loc.work || canonical.chapter !== loc.chapter) return unavailable;
    const component = loc.chapter === undefined ? 'DescriptionModal' : 'ChapterReader';
    const elements = [...document.querySelectorAll('astro-island[component-url]')]
      .filter(element => componentPath(component, element.getAttribute('component-url')));
    if (elements.length !== 1) return unavailable;
    const props = parseProps(elements[0].getAttribute('props'));
    const owner = loc.chapter === undefined ? canonical : location('/comics/' + text(prop(props, 'seriesSlug')));
    if (loc.chapter !== undefined && (owner.work !== loc.work || owner.chapter !== undefined ||
        chapterNumber(prop(props, 'chapterNumber')) !== loc.chapter)) return unavailable;
    return {status: 'ready', value: {title: text(prop(props, loc.chapter === undefined ? 'title' : 'seriesName')),
      catalogId: catalogKey(loc.work), catalogUrl: owner.catalogUrl}};
  } catch {return unavailable;}
};
