export type OpdsErrorCode = 'invalid-catalog'|'authentication-required'|'unsupported-auth'|'scope-blocked'|'network'|'rate-limit'|'too-large'|'unsupported'|'source-changed'|'disconnected'|'range-unsupported';
/** Never include a transport URL, response body, username or native fetch error in messages. */
export class OpdsError extends Error {
  constructor(readonly code:OpdsErrorCode, message:string,readonly details:{status?:number;retryAfter?:number}={}) {
    super(message);this.name='OpdsError';
    // Existing acquisition retry classification recognizes a transport TypeError cause.
    if(code==='network'&&details.status===undefined)this.cause=new TypeError('OPDS transport unavailable');
  }
}
export const invalidCatalog = () => new OpdsError('invalid-catalog','OPDS 目录格式无效或超出支持范围。');
