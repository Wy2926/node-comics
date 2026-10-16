import type {InlineRequest} from './protocol';

/** Shared control-request retry policy; display recovery may run before remote work resumes. */
export class InlineBackoff {
  private until=0;
  private failures=0;
  get delay(){return Math.max(0,this.until-performance.now());}
  get reason():InlineRequest['deferRemote']{return this.delay?'backoff':navigator.onLine===false?'offline':undefined;}
  postpone(delay:number){if(Number.isFinite(delay)&&delay>0)this.until=Math.max(this.until,performance.now()+delay);}
  fail(delay?:number){
    if(delay!==undefined&&Number.isFinite(delay)&&delay>0)this.postpone(delay);
    else if(!this.delay)this.postpone(Math.min(30000,1000*2**this.failures++));
    return this.delay;
  }
  succeeded(){this.failures=0;}
  reset(){this.until=0;this.succeeded();}
  afterTick(schedule:(delay:number)=>void,reason:InlineRequest['deferRemote'],requiresInternet=true){
    if(!reason||reason==='offline'&&!requiresInternet)this.succeeded();
    // A window change can replace the retry timer with local-only recovery. Restore its wakeup,
    // including when that recovery finishes after the original deadline.
    const delay=this.delay;
    if(delay||reason==='backoff')schedule(delay);
  }
}
