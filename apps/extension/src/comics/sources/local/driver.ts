import {openContainer} from './index';
import type {FileSourceDriver} from '../contracts';

export const localSourceDriver: FileSourceDriver = {
  id: 'local', label: '本地文件', cachePages: false, cacheRanges: false,
  async open({revision, containerId, signal}) {
    signal?.throwIfAborted();
    const id = containerId ?? revision.containerId;
    if (!id) throw Error('本地源文件缺失，请重新导入。');
    return openContainer(id);
  },
};
