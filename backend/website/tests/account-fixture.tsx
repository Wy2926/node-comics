import {createRoot} from 'react-dom/client';
import Account from '../src/components/Account';
import '../src/styles/global.css';
if(location.port!=='5193')throw Error('Use isolated port 5193.');
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1000,margin:'32px auto',padding:24}}><h1>账户周期卡片隔离验收</h1><p>模拟账户和报价；提交仅显示报价编号，不创建支付。</p><Account/></main>);
