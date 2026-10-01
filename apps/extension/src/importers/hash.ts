import {msg} from '../i18n/runtime';
import {Sha256 as CoreSha256} from '../../../../backend/shared/translation-images/hash';
export {hashFile} from '../../../../backend/shared/translation-images/hash';
function localized(error: unknown) {
  if (error instanceof Error && error.message === 'SHA-256 已结束。') error.message = msg('SHA-256 已结束。');
  return error;
}
export class Sha256 extends CoreSha256 {
  override update(bytes: Uint8Array) {
    try { return super.update(bytes); }
    catch (error) { throw localized(error); }
  }
  override digest() {
    try { return super.digest(); }
    catch (error) { throw localized(error); }
  }
}
