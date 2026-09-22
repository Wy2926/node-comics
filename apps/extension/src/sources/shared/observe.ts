/** Sites add relevant containers and attributes without widening every scan. */
export function observeImages(
  doc: Document,
  changed: () => void,
  extra: readonly string[] = [],
  containers?: string,
) {
  const selector = ['img', 'canvas', 'picture', 'source', containers].filter(Boolean).join(',');
  const relevant = (node: Node) =>
    node instanceof Element && (node.matches(selector) || !!node.querySelector(selector));
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === 'attributes'
          ? relevant(record.target)
          : [...record.addedNodes, ...record.removedNodes].some(relevant),
      )
    )
      changed();
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'sizes', 'style', 'class', 'hidden', 'width', 'height', ...extra],
  });
  const loaded = (event: Event) => {
    if (event.target instanceof Node && relevant(event.target)) changed();
  };
  doc.addEventListener('load', loaded, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener('load', loaded, true);
  };
}
