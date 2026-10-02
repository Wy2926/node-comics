/** Synthetic local UI only; this fixture never imports files or starts authentication. */
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Modal} from '../src/ui/components';
import {Scrollbars} from '../src/ui/Scrollbars';
import {LocalImport} from '../src/ui/LocalImport';
import {Login} from '../src/ui/Login';
import {Select} from '../src/ui/Select';
import type {useLogin} from '../src/auth/useLogin';
import type {ImportSnapshot, LocalImportQueue} from '../src/comics/application/import-queue';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if (location.hostname !== '127.0.0.1' || location.port !== '5181') throw Error('Use the isolated 127.0.0.1:5181 fixture origin.');
const snapshot: ImportSnapshot = {running: false, pauseRequested: false, phase: 'done', items: Array.from({length: 30}, (_, index) => ({
  id: `modal-fixture-${index}`, title: `隔离导入样本 ${index + 1} · 较长的文件名.cbz`, file: new File([], 'synthetic.cbz'), bytes: 0,
  status: index % 3 === 0 ? 'failed' : 'created', message: index % 3 === 0 ? '模拟失败：可以重试，夹具不实际导入。' : '可以开始阅读',
}))};
const queue = {getSnapshot: () => snapshot, subscribe: () => () => {}, clear: () => {}, retry: async () => {}} as unknown as LocalImportQueue;

function Fixture() {
  const [kind, setKind] = useState<'long' | 'import' | 'login'>(), [guarded, setGuarded] = useState(false), [attempts, setAttempts] = useState(0), [value, setValue] = useState('1');
  const close = () => {setAttempts(count => count + 1); if (!guarded) setKind(undefined);};
  const login = {open: kind === 'login', setOpen: (open: boolean) => setKind(open ? 'login' : undefined), state: {kind: 'idle'},
    development: false, configLoading: false, configError: '', username: '', setUsername: () => {}, authenticate: async () => {}, reloadConfig: () => {},
  } as unknown as ReturnType<typeof useLogin>;
  return <div className="nc-app" style={{minHeight: 2600, padding: 24}}><Scrollbars/>
    <h1>通用弹窗隔离夹具</h1><p>仅检查布局、键盘与焦点；不连接真实服务。</p>
    <section style={{marginTop: 800, display: 'flex', flexWrap: 'wrap', gap: 16}}>
      <button id="open-long" className="button" onClick={() => {setGuarded(false);setKind('long');}}>打开长弹窗</button>
      <button id="open-guarded" className="button" onClick={() => {setGuarded(true);setKind('long');}}>打开受控弹窗</button>
      <button id="open-import" className="button" onClick={() => setKind('import')}>打开导入弹窗</button>
      <button id="open-login" className="button" onClick={() => setKind('login')}>打开独立登录弹窗</button>
      <output id="close-attempts">{attempts}</output>
    </section>
    {kind === 'long' && <Modal title="长内容弹窗：标题也应可以滚动，不挤走关闭按钮" subtitle={'较长的描述，用于验证大字体和短窗口。'.repeat(8)} onClose={close}>
      <label className="field">选项<Select aria-label="夹具选项" value={value} onChange={event => setValue(event.target.value)}><option value="1">第一个选项</option><option value="2">第二个选项</option></Select></label>
      {guarded && <button className="button" onClick={() => setGuarded(false)}>允许关闭</button>}
      <label className="field">输入内容<textarea aria-label="夹具输入" defaultValue={'隔离反馈内容\n'.repeat(100)} style={{width: '100%', height: 100}}/></label>
      {Array.from({length: 28}, (_, index) => <p key={index} className="modal-copy">正文 {index + 1}：这是合成的长内容，用于检查滚轮、键盘和滚动条，不发送任何网络请求。</p>)}
      <button id="modal-end" className="button primary" onClick={() => setValue('done')}>正文末尾操作</button>
    </Modal>}
    {kind === 'import' && <LocalImport queue={queue} expanded onExpand={() => {}} onCollapse={() => setKind(undefined)} onOpen={() => {}}/>}
    <Login login={login}/>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
