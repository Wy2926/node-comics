import { createRoot } from 'react-dom/client';
import CheckoutButton from '../src/components/CheckoutButton';
import '../src/styles/global.css';
import '../src/styles/controls.css';
if (location.port !== '5193') throw Error('Use isolated port 5193.');
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:800,margin:'40px auto',padding:24}}>
  <h1>定价直接结账 · 隔离验收</h1><p>不连接真实身份或支付服务。响应丢失后不自动重发。</p>
  <CheckoutButton priceId="fixture-year" accountHref="/ar/account/" label="开通 Lite 年付" copy={{busy:'正在前往支付…',error:'结账未完成，请重试。',before:'继续前请阅读',refund:'订阅与退款说明',renewal:'，了解自动续费规则。'}}/>
  <p id="checkout-observation" role="status">等待操作</p>
</main>);
