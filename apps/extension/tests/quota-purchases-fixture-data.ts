import type {QuotaPurchase} from '../src/types';

// Synthetic purchase history only; product prices and balances are not live quotes.
const base:QuotaPurchase={id:'permanent-pack',order_id:'synthetic-order',product_name:'永久额度包 · 3,500 页',
  kind:'classic_purchase',mode:'classic',source:'purchase',granted:3500,used:300,reserved:5,available:3195,
  starts_at:'2026-10-08T08:30:00Z',expires_at:null,grants_access:true,note:'',
  service_plan:'plus',hourly_image_limit:null,revoked_at:null,state:'active'};

export const purchaseFixtures:QuotaPurchase[]=[
  base,
  {...base,id:'dated-pack',product_name:'限期额度包 · 1,000 页',granted:1000,used:240,reserved:10,available:750,starts_at:'2026-10-01T03:00:00Z',expires_at:'2026-10-31T03:00:00Z'},
  {...base,id:'exhausted-pack',product_name:'已用完额度包',used:3500,reserved:0,available:0,state:'exhausted',starts_at:'2026-09-20T03:00:00Z'},
  {...base,id:'expired-pack',product_name:'已到期额度包',available:0,reserved:0,state:'expired',starts_at:'2026-09-01T03:00:00Z',expires_at:'2026-10-01T03:00:00Z'},
  {...base,id:'revoked-pack',product_name:'已撤销额度包',available:0,reserved:0,state:'revoked',starts_at:'2026-08-20T03:00:00Z',revoked_at:'2026-09-01T03:00:00Z'},
  ...Array.from({length:16},(_,index)=>({...base,id:`history-${index}`,product_name:`历史额度包 ${index+1}`,used:3500,reserved:0,available:0,state:'exhausted' as const,starts_at:new Date(Date.UTC(2026,7,20-index)).toISOString()})),
];
