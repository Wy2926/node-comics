import type {Plugin} from 'vite';

/* UnRAR source code may be used in any software to handle
 * RAR archives without limitations free of charge, but cannot be
 * used to develop RAR (WinRAR) compatible archiver and to
 * re-create RAR compression algorithm, which is proprietary.
 * Distribution of modified UnRAR source code in separate form
 * or as a part of other software is permitted, provided that
 * full text of this paragraph, starting from "UnRAR source code"
 * words, is included in license, or in documentation if license
 * is not available, and in source code comments of resulting package.
 */

/** node-unrar-js 2.0.2 Emscripten glue generates names and argument converters.
 * Use static closures with the same conversion/destructor order for MV3 CSP.
 * WASM and the extraction algorithm are unchanged. Fail closed on an upgrade.
 */
export function unrarCsp():Plugin {
  return {name:'unrar-static-function-names',enforce:'pre',transform(code,id){
    if(!id.replaceAll('\\','/').endsWith('/node-unrar-js/esm/js/unrar.js'))return;
    const pattern=/function createNamedFunction\(name,body\)\{.*?\}function extendError/;
    const invoker=/function craftInvokerFunction\(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc\)\{.*?\}function __embind_register_class_function/;
    if(!pattern.test(code)||!invoker.test(code)||code.match(/new Function/g)?.length!==1||code.match(/new_\(Function/g)?.length!==1||!code.includes('function getHeapMax(){return 2147483648}'))throw Error('UnRAR glue changed; review its MV3 CSP compatibility and memory limit before upgrading.');
    const patched=code.replace(pattern,'function createNamedFunction(name,body){const fn=function(){return body.apply(this,arguments)};Object.defineProperty(fn,"name",{value:makeLegalFunctionName(name)});return fn}function extendError')
      .replace(invoker,`function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){
        const count=argTypes.length;
        if(count<2)throwBindingError("Invalid argument types");
        const member=argTypes[1]!==null&&classType!==null;
        const needsStack=argTypes.slice(1).some(type=>type!==null&&type.destructorFunction===undefined);
        return createNamedFunction(humanName,function(){
          if(arguments.length!==count-2)throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+(count-2)+" args!");
          const destructors=needsStack?[]:null;
          const wired=[];
          if(member)wired[1]=argTypes[1].toWireType(destructors,this);
          for(let index=2;index<count;index++)wired[index]=argTypes[index].toWireType(destructors,arguments[index-2]);
          const result=cppInvokerFunc(cppTargetFunc,...wired.slice(member?1:2));
          if(needsStack)runDestructors(destructors);
          else for(let index=member?1:2;index<count;index++)if(argTypes[index].destructorFunction!==null)argTypes[index].destructorFunction(wired[index]);
          if(argTypes[0].name!=="void")return argTypes[0].fromWireType(result);
        });
      }function __embind_register_class_function`)
      // The local CBR Worker additionally bounds compressed input and target output.
      .replace('function getHeapMax(){return 2147483648}', 'function getHeapMax(){return 268435456}');
    return {code:patched,map:null};
  }};
}
