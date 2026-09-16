(() => {
  const status = document.querySelector('#status'), open = document.querySelector('#checkout'), refresh = document.querySelector('#refresh');
  const token = location.hash.slice(1) || sessionStorage.getItem('nc-checkout-token');
  const paymentTransaction = new URLSearchParams(location.search).get('_ptxn');
  const paymentLink = /^txn_[a-z0-9]{26}$/.test(paymentTransaction || '');
  if (location.hash) {sessionStorage.setItem('nc-checkout-token', token); history.replaceState(null, '', location.pathname + location.search);}
  let session, polling, busy = false;
  async function read(sync = false) {
    const response = await fetch('/v1/billing/checkout-session', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token, refresh:sync})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '读取结账状态失败');
    session = data;
    if (session.status === 'completed') {status.textContent='已确认订阅，会员权益已自动更新。请返回插件查看。'; open.disabled=true; clearInterval(polling);}
    return data;
  }
  async function check() {
    if (busy) return;
    busy=true; refresh.disabled=true;
    try {await read(true); if(session.status!=='completed') status.textContent='尚未确认订阅，请完成结账后再刷新。';}
    catch(e) {status.textContent=e.message;}
    finally {busy=false; refresh.disabled=false;}
  }
  open.onclick=()=>{if(session) window.Paddle.Checkout.open({transactionId:session.transaction_id,
    settings:{displayMode:'overlay',allowedPaymentMethods:['card'],allowLogout:false}});};
  refresh.onclick=check;
  (async()=>{
    try {
      // Paddle payment/update links use _ptxn without our account handoff token.
      // They may collect payment; only the backend can bind it or grant access.
      if(paymentLink) {
        const response=await fetch('/v1/billing/checkout-config');
        if(!response.ok||!window.Paddle) throw new Error('支付组件暂时不可用，请返回插件重试。');
        session=await response.json();session.transaction_id=paymentTransaction;
        document.querySelector('#environment').textContent=session.environment==='sandbox'?'沙盒测试 · 不产生真实付款':'';
        document.querySelector('#terms').textContent='请核对 Paddle 显示的交易、订阅周期和最终金额。';
        if(session.environment==='sandbox') window.Paddle.Environment.set('sandbox');
        window.Paddle.Initialize({token:session.client_token,eventCallback:event=>{
          if(event.name==='checkout.completed') status.textContent='Paddle 已受理，请返回插件刷新订阅与权益。';
        }});
        open.disabled=false;status.textContent='请在安全结账窗口完成付款或更新付款方式。';
        return;
      }
      if(!token) throw new Error('请从插件账户页打开结账链接。');
      await read();
      document.querySelector('#environment').textContent=session.environment==='sandbox'?'沙盒测试 · 使用 Paddle 测试银行卡，不产生真实付款':'';
      document.querySelector('#terms').textContent=session.trial?'绑定银行卡，免费试用 7 天，含常规翻译不限量与 30 页 AI 重绘。试用结束后每月自动扣 US$9.99，提前取消可避免首次扣款。':'此账户已领取过试用。本次订阅立即付款，之后每月自动续费 US$9.99。';
      if(!window.Paddle) throw new Error('支付组件加载失败，请刷新页面。');
      if(session.environment==='sandbox') window.Paddle.Environment.set('sandbox');
      window.Paddle.Initialize({token:session.client_token,eventCallback:event=>{
        if(event.name==='checkout.completed'){status.textContent='结账已完成，服务器正在确认权益…';void check();}
        if(event.name==='checkout.error') status.textContent='结账未完成，请重试或联系管理员。';
      }});
      open.disabled=session.status==='completed'; refresh.disabled=false;
      if(session.status!=='completed') {status.textContent='结账已就绪，请点击打开安全结账。'; polling=setInterval(()=>{if(!busy) void read().catch(()=>{});},3000);}
    } catch(e) {status.textContent=e.message;}
  })();
})();
