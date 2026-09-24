(() => {
  'use strict';
  const config = globalThis.NODE_COMICS_DRIVE_CONFIG;
  const connect = document.getElementById('connect');
  const reconnect = document.getElementById('reconnect');
  const status = document.getElementById('status');
  const connectionInfo = document.getElementById('connection-info');
  const params = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const oauthKey = 'nc-drive-oauth-pending';
  let nonce = params.get('state'), returned, returnError;
  const isReturn = ['access_token', 'error', 'code', 'picked_file_ids'].some(key => params.has(key) || query.has(key));
  if (isReturn) {
    // OAuth uses the fragment: never send credentials to our server, store them,
    // load Google SDKs, or keep them in the browser's current history entry.
    history.replaceState(null, '', location.pathname);
    try {
      const pending = JSON.parse(sessionStorage.getItem(oauthKey) || 'null');
      sessionStorage.removeItem(oauthKey);
      if (!pending || params.getAll('state').length !== 1 || params.get('state') !== pending.state ||
          !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now() || !/^[a-f0-9-]{72}$/.test(pending.nonce)) throw Error();
      nonce = pending.nonce;
      history.replaceState(null, '', location.pathname + '#state=' + nonce);
      if (params.has('error') || query.has('error')) {
        returnError = 'Google 授权或选文件已取消。可重新连接。';
      } else {
        const accessToken = params.get('access_token'), expiresIn = Number(params.get('expires_in'));
        const selections = [...params.getAll('picked_file_ids'), ...query.getAll('picked_file_ids')];
        const ids = selections.length === 1 && selections[0] ? selections[0].split(',') : [];
        if (query.has('access_token') || query.has('code') || params.has('code') ||
            ['access_token', 'token_type', 'expires_in', 'scope'].some(key => params.getAll(key).length !== 1) ||
            !accessToken || accessToken.length < 10 || accessToken.length > 8192 || /\s/.test(accessToken) ||
            params.get('token_type')?.toLowerCase() !== 'bearer' || !Number.isFinite(expiresIn) || expiresIn <= 30 || expiresIn > 86_400 ||
            params.get('scope')?.trim() !== 'https://www.googleapis.com/auth/drive.file' ||
            selections.length !== 1 || ids.length === 0 || ids.length > 100 || ids.some(id => !/^[a-zA-Z0-9_-]{1,256}$/.test(id))) throw Error();
        returned = {accessToken, expiresAt: Date.now() + expiresIn * 1000, oauthState: pending.state,
          files: pending.onlyConnect ? [] : [...new Set(ids)].map(fileId => ({fileId}))};
      }
    } catch { nonce = undefined; returnError = 'Google 授权返回无效或已过期，请关闭此窗口并从插件重新连接。'; }
  }
  let bridgeReady = false, bridgeInitialized = false, busy = false, onlyConnect = false;
  const configured = location.protocol === 'https:' && /^[a-f0-9-]{72}$/.test(nonce ?? '') &&
    /^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(config?.clientId ?? '');
  const update = () => {
    connect.disabled = reconnect.disabled = !bridgeReady || busy;
    connect.textContent = '前往 Google 授权并选择文件';
    connectionInfo.textContent = '已连接过的账户再次进入时会自动前往 Google。授权和选文件均在 Google 页面完成。';
  };
  const fail = text => { busy = false; status.textContent = text; update(); };
  const authorize = reconnectOnly => {
    if (!bridgeReady || busy) return;
    onlyConnect = reconnectOnly;
    busy = true; update(); status.textContent = '正在前往 Google，请在 Google 页面完成账户授权和文件选择。';
    window.postMessage({type: 'NC_DRIVE_OAUTH_START', nonce, clientId: config.clientId, switchAccount: reconnectOnly}, location.origin);
  };
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || !nonce || event.data?.nonce !== nonce) return;
    if (event.data.type === 'NC_DRIVE_READY' && !bridgeInitialized) {
      bridgeInitialized = true;
      if (!configured) return;
      if (event.data.oauthRedirect !== true) {
        status.textContent = '请更新 NodeLane Comics 插件后重新连接 Google Drive。'; return;
      }
      bridgeReady = true;
      if (returned) {
        const result = returned; returned = undefined;
        if (result.expiresAt <= Date.now() + 30_000) { fail('Google Drive 授权已过期，请重新连接后选择文件。'); return; }
        busy = true; update(); status.textContent = '正在核验账户和所选文件的读取权限…';
        window.postMessage({type: 'NC_DRIVE_SELECTION', nonce, accessToken: result.accessToken,
          expiresIn: Math.floor((result.expiresAt - Date.now()) / 1000), files: result.files, oauthState: result.oauthState}, location.origin);
        return;
      }
      status.textContent = returnError || '点击下方按钮，前往 Google 选择要导入的文件。';
      update();
      // Auto-forward only a fresh, user-opened connection. A cancelled callback
      // stays here for an explicit retry instead of creating a redirect loop.
      if (!isReturn && event.data.autoRedirect === true) authorize(false);
    }
    if (event.data.type === 'NC_DRIVE_OAUTH_STARTED' && bridgeReady && busy) {
      const result = event.data.result;
      try {
        if (!result?.ok || !/^[a-f0-9-]{72}$/.test(result.state) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw Error();
        const url = new URL(result.url);
        if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.searchParams.get('state') !== result.state) throw Error();
        sessionStorage.setItem(oauthKey, JSON.stringify({state: result.state, nonce, expiresAt: result.expiresAt, onlyConnect}));
        location.assign(url.href);
      } catch { fail('无法开始 Google 授权，请关闭此窗口并从插件重新连接。'); }
    }
    if (event.data.type === 'NC_DRIVE_ACK') {
      bridgeReady = false; update();
      status.textContent = event.data.ok ? '连接已完成。请返回 NodeLane Comics 插件继续。' : '核验未完成。请返回插件查看原因，并重新发起连接。';
    }
  });
  window.addEventListener('pagehide', () => { returned = undefined; bridgeReady = false; bridgeInitialized = true; update(); });
  if (location.protocol !== 'https:' || !nonce || !/^[a-f0-9-]{72}$/.test(nonce)) {
    status.textContent = returnError || '请通过 NodeLane Comics 插件的 Google Drive 入口打开此页面。'; return;
  }
  if (!/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(config?.clientId ?? '')) {
    status.textContent = 'Google Drive 尚未配置。管理员需先填写此授权站点的 Web OAuth client ID。'; return;
  }
  connect.addEventListener('click', () => authorize(false));
  reconnect.addEventListener('click', () => authorize(true));
})();
