import {msg} from '../i18n/runtime';

export function AnalyticsDisclosure({id}: {id?: string}) {
  return <>
    <p id={id}>{msg('允许发送功能使用、阅读时长和错误类别至 NodeLane 与 Google Analytics 4。使用随机标识，不包含漫画内容、标题、搜索词、文件名或网页地址。')}</p>
    <p>{msg('默认关闭；关闭后停止发送并清除本机分析标识和待发送数据。')} <a className="text-link" href="https://comics.nodelane.net/privacy/" target="_blank" rel="noopener noreferrer">{msg('隐私政策')}</a></p>
  </>;
}
