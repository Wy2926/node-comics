import {registerSourceDriver} from './registry';
import {localSourceDriver} from './local/driver';
import {googleDriveDriver} from './google-drive/driver';
import {opdsProvider} from './opds/provider';

/** Frontend composition root: file-only and catalog providers share one capability registry. */
export function installFileSources() {
  const dispose = [localSourceDriver, googleDriveDriver, opdsProvider].map(registerSourceDriver);
  return () => { for (const remove of dispose) remove(); };
}
