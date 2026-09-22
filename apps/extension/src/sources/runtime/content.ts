import { connectContentLocale } from '../../i18n/content';
import { msg } from '../../i18n/runtime';
import { validatePages } from '../core/pages';
import { validateSourceCatalog } from '../index';
import { PageImageRegistry, sourceDocument } from '../page';
import { sourceFailure } from './diagnostics';
import { mountSourceImportButton } from './import-button';
export function installSourceContent() {
  const state = globalThis as typeof globalThis & { __nodeComics?: boolean };
  if (state.__nodeComics) return;
  state.__nodeComics = true;
  connectContentLocale();
  let revision = 0,
    cleanupButton: (() => void) | undefined;
  let discovering: Promise<unknown> | undefined;
  const pageImages = new PageImageRegistry();
  const lifecycle = sourceDocument(document);
  let mountedAnchor: Element | null = null;
  let mountedId = '';
  const current = () => {
    const page = lifecycle.current();
    if (mountedId !== page.navigationId) {
      mountedId = page.navigationId;
      revision = 0;
    }
    return page;
  };
  lifecycle.subscribe({
    invalidated() {
      pageImages.clear();
      discovering = undefined;
      cleanupButton?.();
      cleanupButton = undefined;
      mountedAnchor = null;
    },
    changed() {
      const anchor = current().session.importAnchor?.() ?? null;
      if (anchor !== mountedAnchor) {
        cleanupButton?.();
        cleanupButton = undefined;
        mountedAnchor = anchor;
      }
      if (anchor && !cleanupButton) cleanupButton = mountSourceImportButton(anchor);
    },
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (!['NC_NAVIGATION', 'NC_CATALOG_SNAPSHOT', 'NC_PAGE_IMAGE', 'NC_DISCOVER'].includes(message?.type))
      return;
    const page = current(),
      { navigationId, session, controller } = page;
    if (message?.type === 'NC_NAVIGATION') {
      respond({ navigationId, url: location.href });
      return;
    }
    if (message?.type === 'NC_CATALOG_SNAPSHOT') {
      try {
        const result = session.discoverCatalog?.();
        if (!result || result.status === 'unsupported' || result.status === 'error')
          throw Error(result?.code ?? 'UNSUPPORTED_CATALOG');
        const value = result.status === 'ready' ? result.value : result.partial;
        if (!value) throw Error('SOURCE_NOT_READY');
        respond(validateSourceCatalog(value));
      } catch (error) {
        respond(sourceFailure(error));
      }
      return;
    }
    if (message?.type === 'NC_PAGE_IMAGE') {
      if (message.navigationId !== navigationId || message.url !== location.href) {
        respond({ error: msg('图片来源已变化，请重新发现。') });
        return;
      }
      void pageImages
        .read(
          message.imageUrl,
          location.href,
          message.pageId,
          () => (current() === page ? session.inlineTargets() : []),
          controller.signal,
        )
        .then((data) => respond({ data }))
        .catch((error) => respond(sourceFailure(error)));
      return true;
    }
    if (message?.type !== 'NC_DISCOVER') return;
    if (!discovering) {
      const pending = session.discoverPages().then(async (result) => {
        if (current() !== page) throw Error('SOURCE_SESSION_EXPIRED');
        controller.signal.throwIfAborted();
        if (result.status === 'error' || result.status === 'unsupported') throw Error(result.code);
        const snapshot = result.status === 'ready' ? result.value : result.partial;
        if (!snapshot) throw Error('SOURCE_NOT_READY');
        const registered = await pageImages.register(
          validatePages(snapshot, page.location),
          session.inlineTargets(),
        );
        if (current() !== page) throw Error('SOURCE_SESSION_EXPIRED');
        return { ...registered, navigationId, revision: ++revision };
      });
      discovering = pending;
      void pending
        .finally(() => {
          if (discovering === pending) discovering = undefined;
        })
        .catch(() => {});
    }
    void discovering.then(respond).catch((error) => respond(sourceFailure(error)));
    return true;
  });
}
