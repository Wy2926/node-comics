import {pageCurl} from './page-curl';
import {pageTransition} from './page-transition';

export type PageTurnAnimation='curl'|'slide'|'fade'|'none';
/** Visual lifecycle only. Gestures, navigation, image access and reading evidence stay with their owners. */
export interface PageTurn {
 position():void;
 preview(surface:HTMLDivElement|null):void;
 drag(start:{x:number;y:number},current:{x:number;y:number}):void;
 canCommit():boolean;
 revert(done:()=>void):void;
 play(done:()=>void):void;
 dispose():void;
}
export function pageTurn(viewport:HTMLDivElement,surface:HTMLDivElement,sign:number,animation:PageTurnAnimation='curl'):PageTurn|undefined{
 if(animation==='none')return;
 return animation==='curl'?pageCurl(viewport,surface,sign):pageTransition(viewport,surface,sign,animation);
}
