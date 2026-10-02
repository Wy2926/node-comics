import {describe,expect,it,vi} from 'vitest';
import {cancelsRegionDrag,handleRegionKey} from '../src/region/content';

describe('region user gesture boundary',()=>{
  it.each(['Enter',' '])('leaves a trusted %s to the focused page or native button instead of initiating work globally',key=>{
    const event={key,isTrusted:true,preventDefault:vi.fn(),stopPropagation:vi.fn()},close=vi.fn();
    handleRegionKey(event,close);
    expect(close).not.toHaveBeenCalled();expect(event.preventDefault).not.toHaveBeenCalled();expect(event.stopPropagation).not.toHaveBeenCalled();
  });
  it('ignores an Escape synthesized by the source page',()=>{
    const event={key:'Escape',isTrusted:false,preventDefault:vi.fn(),stopPropagation:vi.fn()},close=vi.fn();
    handleRegionKey(event,close);
    expect(close).not.toHaveBeenCalled();expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it('closes only on the actual user Escape event',()=>{
    const event={key:'Escape',isTrusted:true,preventDefault:vi.fn(),stopPropagation:vi.fn()},close=vi.fn();
    handleRegionKey(event,close);
    expect(close).toHaveBeenCalledOnce();expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
  it('accepts right-button cancellation only from a real user during selection',()=>{
    expect(cancelsRegionDrag({button:2,isTrusted:true},true)).toBe(true);
    expect(cancelsRegionDrag({button:2,isTrusted:false},true)).toBe(false);
    expect(cancelsRegionDrag({button:0,isTrusted:true},true)).toBe(false);
    expect(cancelsRegionDrag({button:2,isTrusted:true},false)).toBe(false);
  });
  it('cancels on the secondary-button pointermove before either button is released',()=>{
    expect(cancelsRegionDrag({button:2,buttons:3,isTrusted:true},true)).toBe(true);
    expect(cancelsRegionDrag({button:-1,buttons:3,isTrusted:true},true)).toBe(true);
    expect(cancelsRegionDrag({button:-1,buttons:1,isTrusted:true},true)).toBe(false);
    expect(cancelsRegionDrag({button:-1,buttons:3,isTrusted:false},true)).toBe(false);
  });
});
