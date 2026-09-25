import {msg} from '../../../../i18n/runtime';
import {loadResultBlob} from '../../../../storage/translations/results';
import {fallbackLanguages, type Capabilities} from '../../../../types';
import type {ChannelDefinition, ChannelField} from '../../contracts';
import {startImageTransfer} from '../../transport/client';
import {DirectImageRuntime} from '../../transport/runtime';
import {languages, login, safeError, serviceBase, translationRequest} from './protocol';

function capabilities(): Capabilities {
  return {modes: [{id: 'classic', label: msg('常规翻译'), enabled: true, languages: Object.keys(languages)}],
    languages: fallbackLanguages.filter(language => language.id in languages),
    limits: {max_bytes: 32 * 1024 * 1024, max_pixels: 40_000_000, max_dimension: 30000, max_translation_ids: 4},
    entitlements: null, retention_days: 0};
}

export const definition: ChannelDefinition = {
  id: 'manga-translator-ui', label: 'manga-translator-ui', configurable: true,
  get fields(): readonly ChannelField[] {return [
    {key: 'baseUrl', label: msg('服务地址'), type: 'url', required: true, placeholder: 'http://127.0.0.1:8000'},
    {key: 'username', label: msg('用户名'), type: 'text', required: true},
    {key: 'password', label: msg('密码'), type: 'password', required: true},
  ];},
  permissionOrigins(input) {return [new URL(serviceBase(input.settings.baseUrl ?? '')).origin + '/*'];},
  async connect(input) {
    const baseUrl = serviceBase(input.settings.baseUrl ?? ''), username = (input.settings.username ?? '').trim();
    const password = input.secrets.password ?? '';
    if (!username || !password) throw Error(msg('请输入翻译服务的用户名和密码。'));
    const token = await login(baseUrl, username, password, input.signal);
    return {settings: {baseUrl, username}, secrets: {token}};
  },
  async open(profile, secrets, isCurrent) {
    const base = serviceBase(profile.settings.baseUrl ?? ''), token = secrets.token ?? '';
    const scope = {key: JSON.stringify([profile.id, profile.revision])};
    let disposed = false;
    const current = () => !disposed && isCurrent();
    return {
      key: scope.key, scope, label: profile.name, capabilities: capabilities(), available: !!token,
      unavailable: token ? undefined : {kind: 'error', message: msg('请在渠道设置中连接翻译服务。'), retryable: false},
      requiresInternet: false, allowsFeedback: false, isCurrent: current,
      createRuntime: options => new DirectImageRuntime(scope, {...options, isCurrent: () => current() && options.isCurrent()}, {
        start: (id, blob, mode, language) => startImageTransfer(id, scope.key, blob, translationRequest(base, token, mode, language)),
        errorMessage: safeError,
      }),
      readResult: (job, signal) => {signal?.throwIfAborted(); return loadResultBlob({scope, job, isCurrent: current});},
      dispose() {disposed = true;},
    };
  },
};
