import {registerSourceDriver} from './registry';
import {localSourceDriver} from './local/driver';
import {googleDriveDriver} from './google-drive/driver';

/** Frontend composition root: installing another file source changes only this list. */
export function installFileSources() {
  const dispose = [localSourceDriver, googleDriveDriver].map(registerSourceDriver);
  return () => { for (const remove of dispose) remove(); };
}
