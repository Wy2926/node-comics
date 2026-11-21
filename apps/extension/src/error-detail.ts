/** Append protocol identifiers, never a response body, stack or request URL. */
export function errorDetail(message:string,code?:unknown,status?:number):string {
  const id=typeof code==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)&&code!=='REQUEST_FAILED'?code.replace(/^(?:\w+_)?HTTP_([45]\d\d)$/,'HTTP $1'):'';
  const detail=[status?`HTTP ${status}`:'',id].filter(Boolean).join(' · ');
  return detail?`${message} (${detail})`:message;
}
