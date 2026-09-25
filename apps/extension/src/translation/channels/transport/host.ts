import {HOST_MESSAGE} from './client';
import {executeImageTransfer, validateTransferRequest} from './execute';
import {readTransferReceipt} from './receipts';

/** No content-script callers, externally_connectable surface, or endpoint supplied by a web page. */
export function trustedHostSender(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.url) return sender.url.startsWith(chrome.runtime.getURL('/'));
  return sender.tab === undefined; // Extension service workers may omit sender.url.
}
export function registerImageTransferHost(onBusy: (busy: boolean) => void) {
  let pending = 0, idle: ReturnType<typeof setTimeout> | undefined;
  const scheduleClose = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (pending) return;
      void chrome.tabs.getCurrent().then(tab => tab?.id === undefined ? undefined : chrome.tabs.remove(tab.id));
    }, 10_000);
  };
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== HOST_MESSAGE || !trustedHostSender(sender)) return;
    if (message.action === 'ping') {if (!pending) scheduleClose(); reply({ready: true}); return;}
    if (message.action !== 'start' || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)
      || !validateTransferRequest(message.request)) {reply({accepted: false}); return;}
    clearTimeout(idle);
    void readTransferReceipt(message.id).then(receipt => {
      if (!receipt) {reply({accepted: false}); if (!pending) scheduleClose(); return;}
      clearTimeout(idle); pending++; onBusy(true);
      let acknowledged = false;
      const acknowledge = (accepted: boolean) => {
        if (acknowledged) return;
        acknowledged = true;
        // A closed sender does not revoke work already accepted by this page.
        try {reply({accepted});} catch {}
      };
      const execution = executeImageTransfer(message.id, message.request, () => acknowledge(true));
      void execution.finally(() => {
        // Missing receipts and failures before lock acquisition must also settle the caller.
        acknowledge(false); pending--; onBusy(pending > 0); if (!pending) scheduleClose();
      }).catch(() => {});
    }).catch(() => {reply({accepted: false}); if (!pending) scheduleClose();});
    return true;
  });
  scheduleClose();
}
