import {afterEach,describe,expect,it,vi} from 'vitest';
import {capturePlacement,imagePlacementValid,placementBox,projectImageRegion,RegionDisplay,type RegionBox} from '../src/region/display';

describe('selected image placement',()=>{
  const placement={box:{x:100,y:200,width:800,height:1000},offset:{x:60,y:80,width:320,height:200}};
  it('tracks current image geometry rather than a saved document scroll maximum',()=>{
    expect(projectImageRegion(placement,{x:40,y:-20,width:800,height:1000})).toEqual({x:100,y:60,width:320,height:200});
    expect(projectImageRegion(placement,{x:180,y:400,width:800,height:1000})).toEqual({x:240,y:480,width:320,height:200});
  });
  it('does not stretch a captured crop after responsive layout changes',()=>{
    expect(projectImageRegion(placement,{x:100,y:200,width:600,height:750})).toBeUndefined();
    expect(projectImageRegion(placement,{x:100,y:200,width:800,height:1001})).toBeUndefined();
  });
});

describe('selected image overlay placement',()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
  const identity2d='matrix(1, 0, 0, 1, 0, 0)',identity3d='matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)';
  function fixture(){
    interface NodeState{
      tag:string;parent:HTMLElement|null;bounds:RegionBox;css:Record<string,string>;connected:boolean;
      source:string;currentSource:string;naturalWidth:number;naturalHeight:number;complete:boolean;animations:string[];
    }
    const states=new WeakMap<object,NodeState>();
    function state(node:object):NodeState{
      let value=states.get(node);
      if(!value){
        value={tag:'div',parent:null,bounds:{x:0,y:0,width:1200,height:2000},connected:true,
          css:{transform:'none',translate:'none',rotate:'none',scale:'none',filter:'none',backdropFilter:'none',clipPath:'none',maskImage:'none',mixBlendMode:'normal',perspective:'none',opacity:'1',visibility:'visible',display:'block',objectFit:'fill',overflow:'visible',overflowX:'visible',overflowY:'visible'},
          source:'https://fixture.invalid/page.png',currentSource:'https://fixture.invalid/page.png',naturalWidth:1600,naturalHeight:2000,complete:true,animations:[]};
        states.set(node,value);
      }
      return value;
    }
    class FixtureElement{
      get localName(){return state(this).tag;}
      get parentElement(){return state(this).parent;}
      get isConnected(){return state(this).connected;}
      get shadowRoot(){return null;}
      get style(){return state(this).css;}
      getAnimations(){return state(this).animations.map(playState=>({playState}));}
      getBoundingClientRect(){const rect=state(this).bounds;return {...rect,left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height};}
      contains(element:object){for(let node:object|null=element;node;node=state(node).parent)if(node===this)return true;return false;}
      setAttribute=vi.fn();removeAttribute=vi.fn();replaceWith=vi.fn();remove=vi.fn();
    }
    class FixtureImage extends FixtureElement{
      constructor(){super();state(this).tag='img';}
      get src(){return state(this).source;}
      get currentSrc(){return state(this).currentSource;}
      get naturalWidth(){return state(this).naturalWidth;}
      get naturalHeight(){return state(this).naturalHeight;}
      get complete(){return state(this).complete;}
    }
    // Computed transforms are serialized matrices; model exact identity, not an epsilon.
    class FixtureMatrix{
      readonly isIdentity:boolean;
      constructor(value:string){
        const match=/^matrix(3d)?\(([^)]+)\)$/.exec(value);if(!match)throw Error('Invalid matrix');
        const coefficients=match[2].split(',').map(Number),identity=match[1]?[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]:[1,0,0,1,0,0];
        if(coefficients.length!==identity.length||coefficients.some(value=>!Number.isFinite(value)))throw Error('Invalid matrix');
        this.isIdentity=coefficients.every((value,index)=>value===identity[index]);
      }
    }
    vi.stubGlobal('Element',FixtureElement);vi.stubGlobal('HTMLElement',FixtureElement);vi.stubGlobal('HTMLImageElement',FixtureImage);vi.stubGlobal('DOMMatrixReadOnly',FixtureMatrix);
    const root=new HTMLElement(),body=new HTMLElement(),wrapper=new HTMLElement(),image=new HTMLImageElement(),host=new HTMLElement(),overlayChild=new HTMLElement(),blocker=new HTMLElement();
    state(root).tag='html';state(body).tag='body';state(body).parent=root;state(wrapper).parent=body;state(image).parent=wrapper;state(host).parent=root;state(overlayChild).parent=host;
    state(image).bounds={x:100,y:200,width:800,height:1000};
    let top:HTMLElement=image;
    const elementsFromPoint=vi.fn(()=>[host,overlayChild,top]);
    vi.stubGlobal('document',{documentElement:root,elementsFromPoint,querySelectorAll:()=>[]});
    vi.stubGlobal('getComputedStyle',(node:Element)=>state(node).css);vi.stubGlobal('innerWidth',1200);vi.stubGlobal('innerHeight',900);
    const selection={x:160,y:280,width:320,height:200};
    function capture(){const placement=capturePlacement(selection,host);if(placement.kind!=='image')throw Error('Expected a stable image anchor');return placement;}
    return {root,body,wrapper,image,host,blocker,state,selection,capture,elementsFromPoint,occlude(value:boolean){top=value?blocker:image;}};
  }
  it.each([identity2d,identity3d])('accepts an exact identity transform on the image and non-root ancestors: %s',transform=>{
    const f=fixture();
    for(const node of [f.image,f.wrapper,f.body])f.state(node).css.transform=transform;
    const placement=f.capture();
    expect(imagePlacementValid(placement)).toBe(true);expect(placementBox(placement,f.host)).toEqual(f.selection);
  });
  it.each([identity2d,identity3d])('rejects even an identity transform on the html root: %s',transform=>{
    const f=fixture(),placement=f.capture();f.state(f.root).css.transform=transform;
    expect(imagePlacementValid(placement)).toBe(false);expect(placementBox(placement,f.host)).toBeUndefined();
    expect(capturePlacement(f.selection,f.host).kind).toBe('preview');
  });
  it.each([
    'matrix(1, 0, 0, 1, 0.00001, 0)',
    'matrix(1.00001, 0, 0, 1, 0, 0)',
    'matrix(1, 0.00001, 0, 1, 0, 0)',
    'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.00001, 1)',
    'invalid-transform',
  ])('rejects non-identity or unreadable transforms without a loose tolerance: %s',transform=>{
    const f=fixture(),placement=f.capture();
    for(const node of [f.image,f.wrapper]){
      f.state(node).css.transform=transform;
      expect(imagePlacementValid(placement)).toBe(false);expect(placementBox(placement,f.host)).toBeUndefined();
      expect(capturePlacement(f.selection,f.host).kind).toBe('preview');
      f.state(node).css.transform='none';
    }
  });
  it('conservatively rejects a running image or ancestor animation despite a currently identity transform',()=>{
    const f=fixture(),placement=f.capture();
    for(const node of [f.image,f.wrapper]){
      f.state(node).css.transform=identity2d;f.state(node).animations=['running'];
      expect(imagePlacementValid(placement)).toBe(false);expect(capturePlacement(f.selection,f.host).kind).toBe('preview');
      f.state(node).animations=[];
    }
    expect(imagePlacementValid(placement)).toBe(true);
  });
  it.each(['normal','none',''])('accepts an image without CSS replacement content: %s',content=>{
    const f=fixture();f.state(f.image).css.content=content;
    const placement=f.capture();
    expect(imagePlacementValid(placement)).toBe(true);expect(placementBox(placement,f.host)).toEqual(f.selection);
  });
  it('rejects CSS content replacement even when the source and displayed size have not changed',()=>{
    const f=fixture(),placement=f.capture(),image=f.state(f.image),source=image.currentSource,bounds={...image.bounds};
    image.css.content='url("https://fixture.invalid/replacement.png")';
    expect(image.currentSource).toBe(source);expect(image.bounds).toEqual(bounds);
    expect(imagePlacementValid(placement)).toBe(false);expect(placementBox(placement,f.host)).toBeUndefined();
    expect(capturePlacement(f.selection,f.host).kind).toBe('preview');
  });
  it('invalidates changed source identity, intrinsic dimensions, readiness and unsupported image presentation',()=>{
    const f=fixture(),placement=f.capture(),image=f.state(f.image),original={...image,css:{...image.css}};
    const mutations:Array<()=>void>=[
      ()=>{image.currentSource='https://fixture.invalid/other.png';},
      ()=>{image.currentSource='';image.source='https://fixture.invalid/other.png';},
      ()=>{image.naturalWidth++;},()=>{image.naturalHeight++;},()=>{image.naturalWidth=0;},
      ()=>{image.complete=false;},()=>{image.connected=false;},
      ()=>{image.css.display='none';},()=>{image.css.visibility='hidden';},()=>{image.css.objectFit='contain';},
      ()=>{image.css.borderTopWidth='1px';},()=>{image.css.paddingLeft='1px';},()=>{image.css.borderTopLeftRadius='1px';},
    ];
    for(const mutate of mutations){
      mutate();expect(imagePlacementValid(placement)).toBe(false);expect(placementBox(placement,f.host)).toBeUndefined();
      Object.assign(image,original,{css:{...original.css}});expect(imagePlacementValid(placement)).toBe(true);
    }
  });
  it('uses a half-pixel display-size tolerance without resizing the frozen crop',()=>{
    const f=fixture(),placement=f.capture(),bounds=f.state(f.image).bounds;
    bounds.width+=.5;bounds.height-=.5;
    expect(imagePlacementValid(placement)).toBe(true);expect(placementBox(placement,f.host)).toEqual(f.selection);
    bounds.width+=.001;expect(imagePlacementValid(placement)).toBe(false);expect(placementBox(placement,f.host)).toBeUndefined();
    bounds.width=800;bounds.height=999.499;expect(imagePlacementValid(placement)).toBe(false);
  });
  it('hides an offscreen crop without invalidating its image anchor and follows it back after scrolling',()=>{
    const f=fixture(),placement=f.capture(),bounds=f.state(f.image).bounds;
    bounds.y=-1500;expect(imagePlacementValid(placement)).toBe(true);expect(placementBox(placement,f.host)).toBeUndefined();
    bounds.x=40;bounds.y=-20;
    expect(imagePlacementValid(placement)).toBe(true);expect(placementBox(placement,f.host)).toEqual({x:100,y:60,width:320,height:200});
  });
  it('hides a temporarily occluded crop without permanently invalidating the source',()=>{
    const f=fixture(),placement=f.capture();f.occlude(true);
    expect(imagePlacementValid(placement)).toBe(true);expect(placementBox(placement,f.host)).toBeUndefined();
    f.occlude(false);expect(imagePlacementValid(placement)).toBe(true);expect(placementBox(placement,f.host)).toEqual(f.selection);
  });
  it('recovers after temporary ancestor scroll clipping without rewriting the image or its DOM',()=>{
    const f=fixture(),placement=f.capture(),image=f.state(f.image),before={...image,css:{...image.css},bounds:{...image.bounds}},parent=f.state(f.wrapper);
    parent.css.overflow='hidden';parent.bounds={x:100,y:200,width:100,height:100};
    expect(imagePlacementValid(placement)).toBe(true);expect(placementBox(placement,f.host)).toBeUndefined();
    parent.bounds={x:100,y:200,width:800,height:1000};expect(placementBox(placement,f.host)).toEqual(f.selection);
    expect(f.state(f.image)).toEqual(before);
    for(const node of [f.image,f.wrapper,f.body,f.root]){
      expect(node.setAttribute).not.toHaveBeenCalled();expect(node.removeAttribute).not.toHaveBeenCalled();expect(node.replaceWith).not.toHaveBeenCalled();expect(node.remove).not.toHaveBeenCalled();
    }
  });
});

describe('selected crop display resources',()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
  function fixture(decode:()=>Promise<void>=async()=>{}){
    const images:Array<{src:string;style:Record<string,string>;dataset:Record<string,string>;decode:ReturnType<typeof vi.fn>;remove:ReturnType<typeof vi.fn>;removeAttribute:ReturnType<typeof vi.fn>}>=[];
    class Preview{
      src='';alt='';style:Record<string,string>={};dataset:Record<string,string>={};
      decode=vi.fn(decode);remove=vi.fn();setAttribute=vi.fn();removeAttribute=vi.fn();
      constructor(){images.push(this);}
    }
    vi.stubGlobal('Image',Preview);
    let sequence=0;
    const create=vi.spyOn(URL,'createObjectURL').mockImplementation(()=>'blob:region-fixture-'+ ++sequence),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
    const surface={prepend:vi.fn()},display=new RegionDisplay(surface as unknown as HTMLElement);
    return {images,create,revoke,surface,display};
  }
  it('does not attach an asynchronously decoded crop after its selection was invalidated',async()=>{
    const {display,surface,revoke}=fixture();
    await display.show(new Blob(['crop']),'old-result',()=>false);
    expect(surface.prepend).not.toHaveBeenCalled();expect(display.key).toBeUndefined();expect(revoke).toHaveBeenCalledOnce();
  });
  it('paints only the selected box without taking page pointer events, then releases it',async()=>{
    const {display,images,surface,revoke}=fixture();
    await display.show(new Blob(['crop']),'result',()=>true);
    display.paint({x:17,y:29,width:120,height:80});
    expect(surface.prepend).toHaveBeenCalledExactlyOnceWith(images[0]);
    expect(images[0].style).toMatchObject({display:'block',left:'17px',top:'29px',width:'120px',height:'80px'});
    expect(images[0].style.cssText).toContain('pointer-events:none');
    display.paint(undefined);expect(images[0].style.display).toBe('none');
    display.clear();expect(images[0].remove).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledOnce();expect(display.key).toBeUndefined();
  });
  it('releases the old decoded crop when a different result replaces it',async()=>{
    const {display,images,revoke}=fixture();
    await display.show(new Blob(['first']),'first',()=>true);await display.show(new Blob(['second']),'second',()=>true);
    expect(images[0].remove).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledOnce();expect(display.key).toBe('second');
  });
  it('immediately releases a pending decode when its selection closes',async()=>{
    let finish!:()=>void;const {display,images,surface,revoke}=fixture(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=display.show(new Blob(['crop']),'result',()=>true);
    display.clear();expect(images[0].removeAttribute).toHaveBeenCalledExactlyOnceWith('src');expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:region-fixture-1');
    finish();await pending;
    expect(surface.prepend).not.toHaveBeenCalled();expect(revoke).toHaveBeenCalledOnce();expect(display.key).toBeUndefined();
  });
  it.each(['resolve','reject'])('does not let a superseded decode %s or revoke the new crop',async outcome=>{
    let resolveOld!:()=>void,rejectOld!:(error:Error)=>void,resolveNew!:()=>void;
    const decode=vi.fn<()=>Promise<void>>().mockImplementationOnce(()=>new Promise((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;})).mockImplementationOnce(()=>new Promise(resolve=>{resolveNew=resolve;}));
    const {display,images,surface,revoke}=fixture(decode);
    const old=display.show(new Blob(['old']),'old',()=>true),latest=display.show(new Blob(['new']),'new',()=>true);
    if(outcome==='resolve')resolveOld();else rejectOld(Error('cancelled old decode'));
    await old;expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:region-fixture-1');expect(surface.prepend).not.toHaveBeenCalled();
    resolveNew();await latest;
    expect(display.key).toBe('new');expect(surface.prepend).toHaveBeenCalledExactlyOnceWith(images[1]);expect(revoke).toHaveBeenCalledOnce();
    display.clear();expect(revoke).toHaveBeenLastCalledWith('blob:region-fixture-2');
  });
  it('keeps the animated processing frame pointer-transparent, relocatable and disposable',()=>{
    const {display,surface}=fixture();
    class Element{
      className='';style:Record<string,string>={};dataset:Record<string,string>={};textContent='';firstElementChild?:Element;
      append(child:Element){this.firstElementChild=child;}
      setAttribute=vi.fn();remove=vi.fn();
    }
    const nodes:Element[]=[];vi.stubGlobal('document',{createElement:()=>{const element=new Element();nodes.push(element);return element;}});
    display.paintLoading({x:10,y:20,width:300,height:160});
    expect(nodes[0].dataset.ncRegionLoading).toBe('');expect(nodes[0].style).toMatchObject({display:'block',pointerEvents:'none',left:'10px',top:'20px',width:'300px',height:'160px'});
    display.paintLoading({x:15,y:-10,width:300,height:160});expect(nodes[0].style.top).toBe('-10px');expect(surface.prepend).toHaveBeenCalledOnce();
    display.paintLoading(undefined);expect(nodes[0].style.display).toBe('none');
    display.clear();expect(nodes[0].remove).toHaveBeenCalledOnce();
  });
});
