import {hashFile} from './hash';

export const TILES_MIME = 'application/vnd.nodelane.overlay-tiles';
export const TILE_WIDTH = 2048;
export const TILE_HEIGHT = 4096;
const MAGIC = 'NCOT0001';
const MAX_MANIFEST = 256 * 1024;
export interface OverlayTile {x:number;y:number;width:number;height:number;blob:Blob;}
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;

/** One authenticated artifact: bounded JSON manifest followed by the exact WebP bytes. */
export async function readTiles(blob:Blob,inputSha:string,width:number,height:number):Promise<OverlayTile[]> {
  const header=new Uint8Array(await blob.slice(0,12).arrayBuffer());
  if(header.length!==12||new TextDecoder().decode(header.subarray(0,8))!==MAGIC)throw Error('Invalid tile container');
  const length=new DataView(header.buffer).getUint32(8,true);
  if(!length||length>MAX_MANIFEST||12+length>=blob.size)throw Error('Invalid tile manifest');
  const manifest=JSON.parse(await blob.slice(12,12+length).text());
  if(manifest.format!=='overlay-tiles-v1'||manifest.input_sha256!==inputSha||manifest.width!==width||manifest.height!==height||
    !Array.isArray(manifest.tiles)||!manifest.tiles.length||manifest.tiles.length>4096)throw Error('Invalid tile identity');
  const tiles:OverlayTile[]=[];let offset=12+length;
  for(const item of manifest.tiles){
    if(!integer(item.x)||!integer(item.y)||!integer(item.width)||!integer(item.height)||!integer(item.byte_size)||
      !item.width||!item.height||!item.byte_size||item.width>TILE_WIDTH||item.height>TILE_HEIGHT||
      item.x+item.width>width||item.y+item.height>height||offset+item.byte_size>blob.size||
      typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('Invalid tile bounds');
    if(tiles.some(tile=>item.x<tile.x+tile.width&&tile.x<item.x+item.width&&item.y<tile.y+tile.height&&tile.y<item.y+item.height))throw Error('Overlapping tiles');
    const data=blob.slice(offset,offset+item.byte_size,'image/webp');offset+=item.byte_size;
    if(await hashFile(data)!==item.sha256)throw Error('Invalid tile digest');
    tiles.push({x:item.x,y:item.y,width:item.width,height:item.height,blob:data});
  }
  if(offset!==blob.size)throw Error('Invalid tile length');
  return tiles;
}
