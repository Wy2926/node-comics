import {msg} from '../i18n/runtime';
import {InvalidArtifactError, OriginalUnavailableError, materializeResult as materialize, validateResult as validate} from '../../../../backend/shared/translation-images/materialize';
export {OriginalUnavailableError, InvalidArtifactError};

function localized(error: unknown) {
  if (error instanceof InvalidArtifactError) {
    error.message = msg('翻译文件校验失败，请重新加载。');
  } else if (error instanceof OriginalUnavailableError) {
    error.message = msg('原图不可用，请恢复所属来源或本地原图缓存。');
  } else if (error instanceof Error && error.message === '原图内容已变化，请重新加载后翻译。') {
    error.message = msg('原图内容已变化，请重新加载后翻译。');
  }
  return error;
}
export function validateResult(...args: Parameters<typeof validate>) {
  try { return validate(...args); }
  catch (error) { throw localized(error); }
}
export async function materializeResult(...args: Parameters<typeof materialize>) {
  try { return await materialize(...args); }
  catch (error) { throw localized(error); }
}
