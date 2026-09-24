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
  let bridgeReady = false, bridgeInitialized = false, sdkReady = false, busy = false, token, picker, onlyConnect = false;
  let authMode = 'web', autoPickerOpened = false, chooseFiles, oauthRedirect = false;
  const validToken = () => token && token.expiresAt > Date.now() + 30_000;
  const expiredText = () => authMode === 'chrome'
    ? '此页面的 Chrome 连接已过期，请返回插件重新打开 Google Drive。'
    : 'Google Drive 授权已过期，请重新连接后选择文件。';
  const update = () => {
    connect.disabled = reconnect.disabled = !(bridgeReady && sdkReady) || busy;
    connect.textContent = authMode === 'web' ? '前往 Google 授权并选择文件' : validToken() ? '选择 Google Drive 文件' : '返回插件重新打开 Google Drive';
    connectionInfo.textContent = authMode === 'chrome'
      ? '当前连接由 Chrome 管理。在此页切换或重新连接账户，将使用临时网页授权。'
      : '将在 Google 页面完成授权和选文件，然后自动返回插件。网页连接在授权有效期内可用于阅读。';
  };
  const connectedText = () => `已连接${token?.displayName ? ' ' + token.displayName : ' Google Drive'}`;
  const readyText = () => validToken() ? `${connectedText()}，可直接选择文件。` : authMode === 'chrome'
    ? '此页面没有可用的 Chrome 连接，请返回插件重新打开 Google Drive。'
    : '点击下方按钮，前往 Google 选择要导入的文件。';
  const fail = text => { token = undefined; busy = false; status.textContent = text; update(); };
  const openExistingSession = () => {
    if (authMode !== 'chrome' || !bridgeReady || !sdkReady || busy || autoPickerOpened || !validToken()) return;
    autoPickerOpened = true;
    chooseFiles();
  };
  const deliver = files => {
    if (!bridgeReady) return;
    if (!validToken()) { fail(expiredText()); return; }
    connect.disabled = reconnect.disabled = true;
    status.textContent = '正在核验账户和所选文件的读取权限…';
    window.postMessage({type: 'NC_DRIVE_SELECTION', nonce, accessToken: token.accessToken,
      expiresIn: Math.floor((token.expiresAt - Date.now()) / 1000), files}, location.origin);
    token = undefined;
    picker?.dispose(); picker = undefined;
  };
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || !nonce || event.data?.nonce !== nonce) return;
    if (event.data.type === 'NC_DRIVE_READY' && !bridgeInitialized) {
      bridgeReady = bridgeInitialized = true;
      authMode = event.data.authMode === 'chrome' ? 'chrome' : 'web';
      oauthRedirect = event.data.oauthRedirect === true;
      if (authMode === 'web' && !oauthRedirect) {
        bridgeReady = false; status.textContent = '请更新 NodeLane Comics 插件后重新连接 Google Drive。'; update(); return;
      }
      const session = event.data.session;
      if (authMode === 'chrome' && typeof session?.accessToken === 'string' && session.accessToken.length >= 10 && session.accessToken.length <= 8192 && !/\s/.test(session.accessToken) && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now() + 30_000)
        token = {accessToken: session.accessToken, expiresAt: session.expiresAt, displayName: typeof session.displayName === 'string' ? session.displayName : undefined};
      if (returned) {
        const result = returned; returned = undefined;
        if (result.expiresAt <= Date.now() + 30_000) { fail(expiredText()); return; }
        busy = true; update(); status.textContent = '正在核验账户和所选文件的读取权限…';
        window.postMessage({type: 'NC_DRIVE_SELECTION', nonce, accessToken: result.accessToken,
          expiresIn: Math.floor((result.expiresAt - Date.now()) / 1000), files: result.files, oauthState: result.oauthState}, location.origin);
        return;
      }
      if (authMode === 'web') sdkReady = true;
      else loadPicker();
      if (sdkReady) status.textContent = returnError || readyText();
      update();
      openExistingSession();
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
      token = undefined; bridgeReady = false; update();
      status.textContent = event.data.ok ? '连接已完成。请返回 NodeLane Comics 插件继续。' : '核验未完成。请返回插件查看原因，并重新发起连接。';
    }
  });
  window.addEventListener('pagehide', () => { token = returned = undefined; bridgeReady = false; bridgeInitialized = true; picker?.dispose(); update(); });
  if (location.protocol !== 'https:' || !nonce || !/^[a-f0-9-]{72}$/.test(nonce)) {
    status.textContent = returnError || '请通过 NodeLane Comics 插件的 Google Drive 入口打开此页面。'; return;
  }
  if (!/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(config?.clientId ?? '')) {
    status.textContent = 'Google Drive 尚未配置。管理员需先填写此授权站点的 Web OAuth client ID。'; return;
  }
  const script = src => new Promise((resolve, reject) => {
    const element = document.createElement('script'); element.src = src; element.async = true;
    element.onload = resolve; element.onerror = reject; document.head.appendChild(element);
  });
  const loadPicker = () => Promise.all([script('https://apis.google.com/js/api.js')])
    .then(() => new Promise((resolve, reject) => gapi.load('picker', {callback: resolve, onerror: reject})))
    .then(() => {
      chooseFiles = () => {
        if (!validToken()) { fail(expiredText()); return; }
        busy = true; update(); status.textContent = `${connectedText()}，请在 Google Drive 中选择漫画文件。`;
        // Allow folder navigation and unknown MIME types (including MOBI uploads).
        // The extension verifies file metadata and container bytes before import.
        const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
        picker = new google.picker.PickerBuilder().setDeveloperKey(config.apiKey).setAppId(config.appId)
          .setOAuthToken(token.accessToken).setOrigin(location.origin)
          .enableFeature(google.picker.Feature.MULTISELECT_ENABLED).addView(view)
          .setCallback(data => {
            if (data.action === google.picker.Action.CANCEL) {
              picker?.dispose(); picker = undefined; busy = false;
              status.textContent = validToken() ? `${connectedText()}。已取消选择，未导入文件。可再次选择文件。` : expiredText(); update();
            }
            if (data.action === google.picker.Action.PICKED) {
              const docs = data[google.picker.Response.DOCUMENTS] ?? [];
              if (docs.length > 100) { picker?.dispose(); picker = undefined; busy = false; status.textContent = '每次最多选择 100 个文件。'; update(); return; }
              deliver(docs.map(doc => ({fileId: doc[google.picker.Document.ID], ...(doc.resourceKey ? {resourceKey: doc.resourceKey} : {})})));
            }
          }).build();
        picker.setVisible(true);
      };
      sdkReady = true; status.textContent = bridgeReady ? readyText() : '等待插件建立安全连接…'; update();
      openExistingSession();
    }).catch(() => fail('无法加载 Google 授权服务，请检查网络并从插件重新连接。'));
  const authorize = reconnectOnly => {
    if (!bridgeReady || !sdkReady || busy) return;
    onlyConnect = reconnectOnly;
    if (!reconnectOnly && authMode === 'chrome' && validToken()) { chooseFiles(); return; }
    if (!reconnectOnly && authMode === 'chrome') { fail(expiredText()); return; }
    if (!oauthRedirect) { fail('请更新 NodeLane Comics 插件后重新连接 Google Drive。'); return; }
    token = undefined; busy = true; update(); status.textContent = authMode === 'chrome'
      ? '请在 Google 窗口中选择账户并授权。本次将建立临时网页连接。'
      : '请在 Google 窗口中选择账户并授权。';
    window.postMessage({type: 'NC_DRIVE_OAUTH_START', nonce, clientId: config.clientId}, location.origin);
  };
  connect.addEventListener('click', () => authorize(false));
  reconnect.addEventListener('click', () => authorize(true));
})();
