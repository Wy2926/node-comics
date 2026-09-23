(() => {
  'use strict';
  const config = globalThis.NODE_COMICS_DRIVE_CONFIG;
  const connect = document.getElementById('connect');
  const reconnect = document.getElementById('reconnect');
  const status = document.getElementById('status');
  const connectionInfo = document.getElementById('connection-info');
  const nonce = new URLSearchParams(location.hash.slice(1)).get('state');
  const scope = 'https://www.googleapis.com/auth/drive.file';
  let bridgeReady = false, bridgeInitialized = false, sdkReady = false, busy = false, token, picker, onlyConnect = false;
  let authMode = 'web', autoPickerOpened = false, chooseFiles;
  const validToken = () => token && token.expiresAt > Date.now() + 30_000;
  const expiredText = () => authMode === 'chrome'
    ? '此页面的 Chrome 连接已过期，请返回插件重新打开 Google Drive。'
    : 'Google Drive 授权已过期，请重新连接后选择文件。';
  const update = () => {
    connect.disabled = reconnect.disabled = !(bridgeReady && sdkReady) || busy;
    connect.textContent = validToken() ? '选择 Google Drive 文件' : authMode === 'chrome' ? '返回插件重新打开 Google Drive' : '连接账户并选择文件';
    connectionInfo.textContent = authMode === 'chrome'
      ? '当前连接由 Chrome 管理。在此页切换或重新连接账户，将使用临时网页授权。'
      : '网页连接仅在授权有效期内复用；切换或重新连接账户会打开 Google 授权窗口。';
  };
  const connectedText = () => `已连接${token?.displayName ? ' ' + token.displayName : ' Google Drive'}`;
  const readyText = () => validToken() ? `${connectedText()}，可直接选择文件。` : authMode === 'chrome'
    ? '此页面没有可用的 Chrome 连接，请返回插件重新打开 Google Drive。'
    : '此页面没有可复用的连接。点击连接以选择 Google Drive 文件。';
  const fail = text => { token = undefined; busy = false; status.textContent = text; update(); };
  const openExistingSession = () => {
    if (!bridgeReady || !sdkReady || busy || autoPickerOpened || !validToken()) return;
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
      const session = event.data.session;
      if (typeof session?.accessToken === 'string' && session.accessToken.length >= 10 && session.accessToken.length <= 8192 && !/\s/.test(session.accessToken) && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now() + 30_000)
        token = {accessToken: session.accessToken, expiresAt: session.expiresAt, displayName: typeof session.displayName === 'string' ? session.displayName : undefined};
      if (sdkReady) status.textContent = readyText();
      update();
      openExistingSession();
    }
    if (event.data.type === 'NC_DRIVE_ACK') {
      token = undefined; bridgeReady = false; update();
      status.textContent = event.data.ok ? '连接已完成。请返回 NodeLane Comics 插件继续。' : '核验未完成。请返回插件查看原因，并重新发起连接。';
    }
  });
  window.addEventListener('pagehide', () => { token = undefined; bridgeReady = false; picker?.dispose(); update(); });
  if (location.protocol !== 'https:' || !nonce || !/^[a-f0-9-]{72}$/.test(nonce)) {
    status.textContent = '请通过 NodeLane Comics 插件的 Google Drive 入口打开此页面。'; return;
  }
  if (!config?.clientId || !config?.apiKey || !/^\d+$/.test(config?.appId ?? '')) {
    status.textContent = 'Google Drive 尚未配置。管理员需先填写此授权站点的 OAuth client ID、API key 和 Cloud project number。'; return;
  }
  const script = src => new Promise((resolve, reject) => {
    const element = document.createElement('script'); element.src = src; element.async = true;
    element.onload = resolve; element.onerror = reject; document.head.appendChild(element);
  });
  Promise.all([script('https://accounts.google.com/gsi/client'), script('https://apis.google.com/js/api.js')])
    .then(() => new Promise((resolve, reject) => gapi.load('picker', {callback: resolve, onerror: reject})))
    .then(() => {
      chooseFiles = () => {
        if (!validToken()) { fail(expiredText()); return; }
        busy = true; update(); status.textContent = `${connectedText()}，请在 Google Drive 中选择漫画文件。`;
        const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(false).setSelectFolderEnabled(false);
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
      const client = google.accounts.oauth2.initTokenClient({client_id: config.clientId, scope, include_granted_scopes: false,
        error_callback: () => fail('授权窗口已关闭或无法打开，请再次点击连接。'),
        callback: response => {
          if (!bridgeReady) return;
          if (response.error || !google.accounts.oauth2.hasGrantedAllScopes(response, scope)) { fail('未获得所选文件的访问授权。'); return; }
          const expiresIn = Number(response.expires_in);
          if (typeof response.access_token !== 'string' || !Number.isFinite(expiresIn) || expiresIn <= 30 || expiresIn > 86_400) { fail('Google Drive 授权无效，请重新连接。'); return; }
          authMode = 'web';
          token = {accessToken: response.access_token, expiresAt: Date.now() + expiresIn * 1000};
          update();
          if (onlyConnect) { deliver([]); return; }
          chooseFiles();
        }});
      const authorize = reconnectOnly => {
        if (!bridgeReady || !sdkReady || busy) return;
        onlyConnect = reconnectOnly;
        if (!reconnectOnly && validToken()) { chooseFiles(); return; }
        if (!reconnectOnly && authMode === 'chrome') { fail(expiredText()); return; }
        token = undefined; busy = true; update(); status.textContent = authMode === 'chrome'
          ? '请在 Google 窗口中选择账户并授权。本次将建立临时网页连接。'
          : '请在 Google 窗口中选择账户并授权。';
        client.requestAccessToken({prompt: 'select_account'});
      };
      connect.addEventListener('click', () => authorize(false));
      reconnect.addEventListener('click', () => authorize(true));
      sdkReady = true; status.textContent = bridgeReady ? readyText() : '等待插件建立安全连接…'; update();
      openExistingSession();
    }).catch(() => fail('无法加载 Google 授权服务，请检查网络并从插件重新连接。'));
})();
