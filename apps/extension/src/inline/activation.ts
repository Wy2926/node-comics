export interface InlineActivation {
  url: string;
  navigationId: string;
  documentId?: string;
  automatic?: boolean;
}

export const activationKey = (tabId: number) => 'nc-inline:' + tabId;

/** Firefox before 153 has no documentId; the activated navigation remains mandatory. */
export async function currentInlineActivation(sender: chrome.runtime.MessageSender, navigationId: unknown) {
  if (sender.id !== chrome.runtime.id || sender.tab?.id == null || sender.frameId !== 0 || typeof navigationId !== 'string') return;
  const saved = await chrome.storage.session.get(activationKey(sender.tab.id));
  const activation = saved[activationKey(sender.tab.id)] as InlineActivation | undefined;
  if (!activation || activation.navigationId !== navigationId || activation.documentId && activation.documentId !== sender.documentId) return;
  const tab = await chrome.tabs.get(sender.tab.id);
  // sender.url may lag behind SPA navigation, so use the browser's current tab URL.
  if (tab.url !== activation.url) return;
  try {
    if (new URL(sender.url ?? '').origin !== new URL(activation.url).origin) return;
  } catch {
    return;
  }
  return {activation, tab};
}
