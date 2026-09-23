import {catalog} from '../repositories';
import type {SourceAccessChange, SourceSelection} from '../sources/contracts';
import {closeSourceAccess} from '../sources/runtime';
import {sourcePageCache} from '../../storage/source-pages';
import {sourceRangeCache} from '../../storage/source-ranges';
import {thumbnailCache} from '../../storage/thumbnails';

const automaticCaches = [sourcePageCache, sourceRangeCache, thumbnailCache];

export async function invalidateSourceAccess({connectionId, itemId}: SourceAccessChange) {
  await closeSourceAccess({connectionId, itemId});
  const connection = await catalog.get('connections', connectionId);
  if (!connection) return;
  if (itemId === undefined && connection.status !== 'disconnected') await catalog.patch('connections', connectionId, {status: 'disconnected', generation: connection.generation + 1, updatedAt: Date.now()});
  for (const binding of await catalog.list('bindings', {index: 'connectionId', range: connectionId, limit: 10000})) {
    if (itemId !== undefined && binding.providerItemId !== itemId) continue;
    const status = itemId !== undefined || binding.status === 'revoked' ? 'revoked' : 'disconnected';
    if (binding.status === status) continue;
    await catalog.patch('bindings', binding.id, {status, generation: binding.generation + 1, updatedAt: Date.now()});
    for (const document of await catalog.list('documents', {index: 'sourceBindingId', range: binding.id, limit: 10000})) {
      await catalog.patch('documents', document.id, {generation: document.generation + 1, error: itemId === undefined ? '来源连接已断开。' : '源文件访问已撤销，请重新授权。'});
      await Promise.all(automaticCaches.map(cache => cache.deleteOwner(document.id, true)));
    }
  }
  if (itemId === undefined) await Promise.all(automaticCaches.map(cache => cache.deleteConnection(connectionId)));
}

/** Consumes a provider-verified selection; authentication remains inside the source driver. */
export async function restoreSourceSelection(selection: SourceSelection) {
  const connection = await catalog.get('connections', selection.connection.id);
  if (!connection) return;
  if (connection.provider !== selection.connection.provider || connection.accountId !== selection.connection.accountId)
    throw Error('来源连接身份与所选来源不匹配。');
  if (connection.status !== 'connected') await catalog.patch('connections', connection.id, {status: 'connected', generation: connection.generation + 1, updatedAt: Date.now()});
  const selected = new Set(selection.files.map(file => file.id));
  for (const binding of await catalog.list('bindings', {index: 'connectionId', range: connection.id, limit: 10000})) {
    if (binding.status !== 'revoked' && binding.status !== 'disconnected') continue;
    if (binding.status === 'revoked' && !selected.has(binding.providerItemId)) continue;
    await catalog.patch('bindings', binding.id, {status: 'active', generation: binding.generation + 1, updatedAt: Date.now()});
    for (const document of await catalog.list('documents', {index: 'sourceBindingId', range: binding.id, limit: 10000})) {
      await catalog.patch('documents', document.id, {generation: document.generation + 1, error: undefined});
      await Promise.all(automaticCaches.map(cache => cache.allowOwner(document.id)));
    }
  }
}
