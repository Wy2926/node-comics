// A test-only UI entry. Feed/image/file bodies come from the real public server unchanged.
// Blocks product APIs and does not register any mock source or synthetic catalog.
const request=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(input,init)=>{
  const resource=new Request(input,init),url=new URL(resource.url);
  if(url.origin==='https://demo.komga.org')return request('/__opds_live?url='+encodeURIComponent(url.href),{
    method:resource.method,headers:resource.headers,signal:resource.signal,cache:'no-store',credentials:'omit',
    body:['GET','HEAD'].includes(resource.method)?undefined:await resource.arrayBuffer(),
  });
  if(url.origin===location.origin||['blob:','data:'].includes(url.protocol))return request(input,init);
  throw new TypeError('Unrelated network request blocked by live OPDS UI test');
};
void import('../src/main');
