/** Header-only images for mocked encoders; browser fixtures exercise real decoding. */
export function pngWithSize(width:number,height:number):Blob {
  const bytes=new Uint8Array(24),view=new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10]);view.setUint32(8,13);bytes.set([73,72,68,82],12);
  view.setUint32(16,width);view.setUint32(20,height);return new Blob([bytes],{type:'image/png'});
}
export function jpegWithSize(width:number,height:number,padding=0):Blob {
  const frame=new Uint8Array([255,192,0,11,8,0,0,0,0,1,1,17,0]),view=new DataView(frame.buffer);
  view.setUint16(5,height);view.setUint16(7,width);
  return new Blob([new Uint8Array([255,216]),frame,new Uint8Array([255,218,0,2]),new Uint8Array(padding),new Uint8Array([255,217])],{type:'image/jpeg'});
}
