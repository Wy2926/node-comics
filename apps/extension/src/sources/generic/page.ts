import type { CreateSourcePage } from '../contracts/page';
import { imageDiscovery, renderedImages } from '../shared/dom-images';
import { comicImageRect } from '../shared/geometry';
import { imageSession } from '../shared/session';
import { canvasTargets } from './canvases';

const imageSelector = 'img:not([data-nc-canvas-translation])';
export const createPage: CreateSourcePage = (context) => {
  const canvases = canvasTargets(context);
  const session = imageSession(context, {
    snapshot: imageDiscovery(context.document, context.location.url, {id: context.location.sourceId, selector: imageSelector, singlePage: false}),
    targets() {
      const images = renderedImages(context.document, context.location.url, imageSelector, context.signal)
        .filter(({ element }) => comicImageRect(element));
      const targets = new Map([...images, ...canvases.targets()].map(image => [image.element, image]));
      return [...context.document.querySelectorAll<HTMLImageElement | HTMLCanvasElement>('img,canvas')]
        .flatMap(element => targets.has(element) ? [targets.get(element)!] : []);
    },
  });
  return {
    ...session,
    observe(changed) {
      const stopImages = session.observe!(changed), stopCanvases = canvases.observe(changed);
      return () => { stopImages(); stopCanvases(); };
    },
    dispose() { canvases.dispose(); session.dispose(); },
  };
};
