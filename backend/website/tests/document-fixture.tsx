import { createRoot } from 'react-dom/client';
import DocumentWorkbench from '../src/components/DocumentWorkbench';
import { switchAccount, signOut } from './document-fixture-auth';
import type { Locale } from '../src/i18n/locales';
import '../src/styles/global.css';
import '../src/styles/controls.css';
import '../src/styles/public-site.css';
import '../src/styles/marketing.css';
if (location.port !== '5194') throw Error('Use isolated document fixture port 5194.');
const params = new URLSearchParams(location.search), locale = (params.get('locale') ?? 'zh-CN') as Locale;
document.documentElement.lang = locale;
if (params.get('theme') !== 'light') document.body.dataset.siteTheme = 'midnight';
function chooseSynthetic(bytes: number) {
  const input = document.getElementById('document-file') as HTMLInputElement | null;
  if (!input || input.disabled) return;
  const chunk = new Blob([new Uint8Array(1_000_000)]);
  const blob = new Blob(Array.from({ length: Math.ceil(bytes / chunk.size) }, () => chunk)).slice(0, bytes);
  const transfer = new DataTransfer(); transfer.items.add(new File([blob], `synthetic-${bytes / 1_000_000}MB.zip`, { type: 'application/zip' }));
  input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
}
createRoot(document.getElementById('root')!).render(<main>
  <aside style={{ margin: '24px auto', padding: 18, maxWidth: 880 }}><strong>隔离夹具：全部为模拟数据，不连接真实账户、R2 或模型。</strong><p>真实 Worker 增量哈希 + Blob 分片；文件内容不是可解析的压缩包。</p><div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
    <button className="button secondary" onClick={() => chooseSynthetic(34_000_000)}>选取 34 MB 合成文件</button><button className="button secondary" onClick={() => chooseSynthetic(200_000_000)}>选取 200 MB 合成文件</button>
    <button className="button secondary" onClick={switchAccount}>模拟切换账户</button><button className="button secondary" onClick={signOut}>模拟退出</button></div></aside>
  <DocumentWorkbench locale={locale}/><details style={{ maxWidth: 880, margin: '20px auto' }}><summary>模拟请求观测</summary><pre><output id="document-observation"/></pre></details>
</main>);
