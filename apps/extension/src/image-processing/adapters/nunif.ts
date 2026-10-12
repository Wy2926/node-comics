import {msg} from '../../i18n/runtime';
import type {ProcessingAdapter} from '../contracts';

/** nunif waifu2x/web/server.py: POST /api, file + style/noise/scale/format. */
export function nunifAdapter(): ProcessingAdapter {
  const fields = [
    {key: 'style', label: msg('图像类型'), defaultValue: 'art', options: [
      {value: 'art', label: msg('插画')}, {value: 'art_scan', label: msg('扫描图')}, {value: 'photo', label: msg('照片')},
    ]},
    {key: 'scale', label: msg('放大倍率'), defaultValue: '2', options: [
      {value: '-1', label: '1×'}, {value: '1', label: '1.6×'}, {value: '2', label: '2×'},
    ]},
    {key: 'noise', label: msg('降噪'), defaultValue: '-1', options: [
      {value: '-1', label: msg('不降噪')}, ...['0', '1', '2', '3'].map(value => ({value, label: value})),
    ]},
  ];
  const normalize = (settings: Record<string, string>) => {
    let url: URL;
    try {url = new URL(settings.url?.trim());} catch {throw Error(msg('请输入有效的 HTTP 或 HTTPS 服务地址。'));}
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Error(msg('服务地址不能包含凭据、查询参数或片段。'));
    url.pathname = url.pathname.replace(/\/+$/, '') + '/';
    const values: Record<string, string> = {url: url.href};
    for (const field of fields) {
      const value = settings[field.key] ?? field.defaultValue;
      if (!field.options.some(option => option.value === value)) throw Error(msg('增强参数无效。'));
      values[field.key] = value;
    }
    return values;
  };
  return {
    id: 'nunif', label: 'nunif / waifu2x', guideUrl: 'https://github.com/nagadomi/nunif/blob/master/waifu2x/docs/web.md',
    fields, normalize,
    request(settings) {
      const {url, style, noise, scale} = normalize(settings);
      return {url: url + 'api', headers: {}, imageField: 'file', fields: {style, noise, scale, format: '0'}};
    },
  };
}
