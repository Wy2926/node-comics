// Public protocol tables observed in Comix secure-tlrpwb-M_-Wx-pz.js on 2026-09-23.
// These are byte permutations, not account credentials. No downloaded code is executed.
const stages = [
  {
    "table": "gbicCvAMzfcXEtGAyjvvhmb2yCWzWhjqcxXZ7ZhpzANOzoQLo3nuPZ2vK9dkb9hJExC0Vni/hdQBceI+mw611gkhQFjBuf4bJg1TxYqM+SL4YDqtwjxiGSdeH7so7Fn1HiRo37Z+RNvl44twXWVhomtMjw+8bemfmv9XEXr7mS82MxaCOJZRR0oHd9PLI5O+gyBGT6hcLoduNa7yCObVVCk3bFWsoD+xcqTrBcP6dNJN/NB1Br2QGhSN2snHAqeRNKVFQiyeAFLPSKGwY8aq9EPgsi17qd4ywPMxiH8w6N1qX1tLKtzhOeemHWeJQfFQ5H23q7qSlJUcjgTEl3x2/Q==",
    "key": "rafYl4oSAKQX+GYoic9oW4iGwiYpZzs0",
    "seed": 189
  },
  {
    "table": "2lQehmgyYFAoWUi0haazZqHy5zZ34NN+VzlfsoB2Y1yY0IuMLjgVcV2xt8t4moH+AP0NMJ5qekW7DFIHEWKkOgIBIMhDdA8lbM6iHKjDlq6IChpb3CnA9NmsvQW/afdt1SfJjTdwcvpKqunCJLxBFmXX9hecm6tGb+HRxD7BC3njoxPxgnX5pdKP1IMSkd4/O3NRfZSE6DVLG2s9uexaipA05cpJzE8Qkv/z5jzHAwlEWOLd3yxA+0cvVbpOoJPFGc8f1lb4vu2HUxjuuEwEQk0GsPCVnyKvfOoh9TG2YYmZLV4I67UU2NsrrakqZ47k/O+ne25/DjPGZCMdnZcmzQ==",
    "key": "2USAq+VTo5ht4bQn+K9DUcpUQRTtrB56",
    "seed": 133
  },
  {
    "table": "+mhJSFwzaV+PQPDyKp2scO/S9SdFsy/7e56UWT8XHbK3E2+19nEPwfwOgE9uVCaDtOAWTobCZX+cBCXlIbBqyDyQB1beKLspW6kGPhBCV9x0jf0KUeFhHjmlMf7qMFIB41PfDFprZ3bJiK4YxrZDv+K6dcwJmggVO8f5ktrXTM0cZL4fer0SpnkbvNajPbHxfuTz5lVEBarOI4rdc+2V6zTsjpfQYjgN1MMr6EvA6eehN6dQ1bgUogt9rZOBbQBeNnLYY00uZqSoJBnFi5gthCJsWF33ykosn9v/9KB8udMCz0YRYImrA4VHr5mMgpH4xDXLeEHRd5vZOiAalofuMg==",
    "key": "yNHlokVEnuecesDrB/lDhVuUNiheWc3a47VtkwZ2ENg=",
    "seed": 32
  }
];
const bytes=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export function encodeRequest(text:string){
 let data=new TextEncoder().encode(text);
 for(const stage of stages){const table=bytes(stage.table),key=bytes(stage.key);let previous=stage.seed;data=data.map((value,i)=>previous=table[value^key[i%key.length]^previous]);}
 return btoa(String.fromCharCode(...data)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function decodeResponse(text:string){
 let data=bytes(text);
 for(const stage of [...stages].reverse()){const table=bytes(stage.table),key=bytes(stage.key),inverse=new Uint8Array(256);table.forEach((value,i)=>inverse[value]=i);let previous=stage.seed;data=data.map((value,i)=>{const result=inverse[value]^key[i%key.length]^previous;previous=value;return result;});}
 return new TextDecoder('utf-8',{fatal:true}).decode(data);
}
