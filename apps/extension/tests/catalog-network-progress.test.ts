import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SourceCatalogSnapshot} from '../src/sources/contracts/source';
import type {SourceNetworkContext} from '../src/sources/contracts/network';
const fixture=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../src/sources/registry/networks',()=>({sourceNetworks:{mangacopy:{catalog:fixture.read}}}));
import {readNetworkCatalog} from '../src/sources/runtime/network';
const url='https://mangacopy.com/comic/network-progress';
const source:SourceCatalogSnapshot={id:'mangacopy:network-progress',sourceId:'mangacopy',url,title:'Progress fixture',
  complete:true,observedAt:1,note:'',entries:[],groups:[]};
beforeEach(()=>{fixture.read.mockReset();});
afterEach(()=>vi.unstubAllGlobals());

describe('network catalog progress validation',()=>{
  it('does not invoke an adapter for an already cancelled operation',async()=>{
    const controller=new AbortController();controller.abort();
    await expect(readNetworkCatalog(url,{signal:controller.signal})).rejects.toThrow();expect(fixture.read).not.toHaveBeenCalled();
  });
  it('awaits validated progress but returns only the final complete observation',async()=>{
    const observed=vi.fn(async(snapshot:SourceCatalogSnapshot)=>{expect(snapshot.complete).toBe(false);});
    fixture.read.mockImplementation(async(_url:string,context:SourceNetworkContext)=>{
      await context.onCatalogProgress?.({...source,complete:false});
      expect(observed).toHaveBeenCalledOnce();return source;
    });
    expect(await readNetworkCatalog(url,{onCatalogProgress:observed})).toEqual(source);
  });
  it.each(['foreign','complete'])('rejects a %s progress observation before consumers can save it',async mode=>{
    const observed=vi.fn();
    fixture.read.mockImplementation(async(_url:string,context:SourceNetworkContext)=>{
      await context.onCatalogProgress?.(mode==='foreign'?{...source,id:'mangacopy:foreign',url:url.replace('network-progress','foreign'),complete:false}:source);
      return source;
    });
    await expect(readNetworkCatalog(url,{onCatalogProgress:observed})).rejects.toThrow('SOURCE_CATALOG_CHANGED');
    expect(observed).not.toHaveBeenCalled();
  });
  it('rejects an incomplete final result even after valid progress',async()=>{
    const observed=vi.fn(async()=>{}),partial={...source,complete:false};
    fixture.read.mockImplementation(async(_url:string,context:SourceNetworkContext)=>{await context.onCatalogProgress?.(partial);return partial;});
    await expect(readNetworkCatalog(url,{onCatalogProgress:observed})).rejects.toThrow('SOURCE_CATALOG_CHANGED');
    expect(observed).toHaveBeenCalledOnce();
  });
  it('propagates callback failures and cancellation so adapters stop before another batch',async()=>{
    fixture.read.mockImplementation(async(_url:string,context:SourceNetworkContext)=>{await context.onCatalogProgress?.({...source,complete:false});return source;});
    await expect(readNetworkCatalog(url,{onCatalogProgress:async()=>{throw Error('consumer stopped');}})).rejects.toThrow('consumer stopped');
    const controller=new AbortController();
    await expect(readNetworkCatalog(url,{signal:controller.signal,onCatalogProgress:async()=>{controller.abort();}})).rejects.toThrow();
  });
});
