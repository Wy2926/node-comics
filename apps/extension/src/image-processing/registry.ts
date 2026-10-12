import {nunifAdapter} from './adapters/nunif';
import {msg} from '../i18n/runtime';

/** The only concrete adapter assembly point. Models are service parameters, not channels. */
export const processingAdapters = () => [nunifAdapter()];
export function processingAdapter(id: string) {
  const adapter = processingAdapters().find(item => item.id === id);
  if (!adapter) throw Error(msg('增强渠道不可用，请检查设置。'));
  return adapter;
}
