/** Header-only JPEG for mocked encoders; browser fixtures exercise real decoding. */
export function jpegWithSize(width:number,height:number,padding=0):Blob {
  const frame=new Uint8Array([255,192,0,11,8,0,0,0,0,1,1,17,0]),view=new DataView(frame.buffer);
  view.setUint16(5,height);view.setUint16(7,width);
  return new Blob([new Uint8Array([255,216]),frame,new Uint8Array([255,218,0,2]),new Uint8Array(padding),new Uint8Array([255,217])],{type:'image/jpeg'});
}
