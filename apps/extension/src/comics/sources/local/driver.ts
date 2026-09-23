import {openContainer} from './index';
import type {FileSourceDriver} from '../contracts';
import {msg} from '../../../i18n/runtime';

export const localSourceDriver: FileSourceDriver = {
  id: 'local', get label(){return msg('本地文件');}, cachePages: false, cacheRanges: false,
  async open({containerId, signal}) {
    signal?.throwIfAborted();
    const id = containerId;
    if (!id) throw Error('本地源文件缺失，请重新导入。');
    return openContainer(id);
  },
};
