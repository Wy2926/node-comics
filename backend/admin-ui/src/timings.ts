import type {TaskDetail} from './types';

export function taskTimingRows(timings: TaskDetail['timings']) {
  return [
    ...Object.entries(timings?.node ?? {}).map(([key, seconds]) => ({key, seconds, source: '节点'})),
    ...Object.entries(timings?.delivery ?? {}).map(([key, seconds]) => ({key, seconds, source: '中心'}))
  ].filter(({key}) => key !== 'protocol');
}
