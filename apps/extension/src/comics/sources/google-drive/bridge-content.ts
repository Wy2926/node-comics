/** Runs only after background injects this bundled script into its recorded HTTPS authorization tab. */
export async function installDriveBridge() {
  if (window !== window.top) return;
  const ready = await chrome.runtime.sendMessage({type: 'NC_DRIVE_BRIDGE_INIT'}).catch(() => undefined);
  if (!ready?.ok || typeof ready.nonce !== 'string' || typeof ready.expiresAt !== 'number') return;
  const origin = location.origin;
  let delivered = false;
  const listener = (event: MessageEvent) => {
    if (delivered || event.source !== window || event.origin !== origin || event.data?.type !== 'NC_DRIVE_SELECTION' || event.data?.nonce !== ready.nonce) return;
    delivered = true;
    window.removeEventListener('message', listener);
    clearTimeout(timeout);
    void chrome.runtime.sendMessage({type: 'NC_DRIVE_BRIDGE_RESULT', payload: event.data})
      .then(result => window.postMessage({type: 'NC_DRIVE_ACK', nonce: ready.nonce, ok: !!result?.ok}, origin))
      .catch(() => window.postMessage({type: 'NC_DRIVE_ACK', nonce: ready.nonce, ok: false}, origin));
  };
  window.addEventListener('message', listener);
  const timeout = setTimeout(() => window.removeEventListener('message', listener), Math.max(0, ready.expiresAt - Date.now()));
  window.postMessage({type: 'NC_DRIVE_READY', nonce: ready.nonce, ...(ready.authMode === 'chrome' ? {authMode: 'chrome'} : {}), ...(ready.session ? {session: ready.session} : {})}, origin);
}
