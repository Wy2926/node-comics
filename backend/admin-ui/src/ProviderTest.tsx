import {useState} from 'react';
import {Alert, Button, Descriptions, Tag} from 'antd';
import {BillingDialog} from './BillingShared';
import {ApiError, authError, errorText, request} from './api';
import type {TranslationProvider} from './types';

type Result = {ok: boolean; response?: string; error_code?: string; message?: string; elapsed_ms: number; model: string;
  usage: {input_tokens: number; output_tokens: number} | null};
export function ProviderTest({provider, onClose, onUnauthorized}: {provider: TranslationProvider; onClose: () => void; onUnauthorized: (message: string) => void}) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<Result>(), [error, setError] = useState('');
  return <BillingDialog title={`测试 ${provider.name}`} onClose={onClose} busy={busy}>
    <Descriptions column={1} items={[{key: 'model', label: '模型', children: provider.config.model},
      {key: 'protocol', label: '协议', children: provider.config.protocol === 'responses' ? 'Responses' : 'Chat Completions'},
      {key: 'input', label: '测试文本', children: 'Hello, world! → 简体中文'}]}/>
    <p className="muted">使用当前已保存的配置和密钥发送一次真实请求，最多等待 30 秒。不扣用户页数；供应商可能计费，每个供应商 30 秒内可测试一次。</p>
    <Button type="primary" loading={busy} disabled={busy} onClick={async () => {
      setBusy(true); setError(''); setResult(undefined);
      try {setResult(await request<Result>(`/v1/admin/translation-providers/${encodeURIComponent(provider.id)}/test`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({revision_id: provider.revision_id})}));}
      catch (failure) {if (authError(failure)) onUnauthorized(errorText(failure)); else {
        const uncertain = !(failure instanceof ApiError) || failure.status >= 500;
        setError(errorText(failure) + (uncertain ? ' 请求结果可能未知，不会自动重试。' : ''));
      }}
      finally {setBusy(false);}
    }}>发送测试请求</Button>
    {error && <Alert type="error" title={error} showIcon/>}
    {result && <div className="provider-test-result" role="status"><Alert showIcon type={result.ok ? 'success' : 'error'} title={result.ok ? '测试成功' : '测试失败'}
      description={result.ok ? result.response : `${result.message} (${result.error_code})`}/>
      <div className="test-metrics"><Tag>{result.elapsed_ms} ms</Tag><Tag>输入 {result.usage?.input_tokens ?? '未知'} tokens</Tag><Tag>输出 {result.usage?.output_tokens ?? '未知'} tokens</Tag></div></div>}
  </BillingDialog>;
}
