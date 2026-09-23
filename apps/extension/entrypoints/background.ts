import { defineBackground } from 'wxt/utils/define-background';
import { registerSourceBackground } from '../src/sources/runtime/background';
import {registerDriveBackground} from '../src/comics/sources/google-drive/background';
import {registerCatalogSyncBackground} from '../src/comics/application/catalog-sync-background';
import {readWebsiteCatalog} from '../src/comics/application/website-catalog';
export default defineBackground(() => { registerSourceBackground(readWebsiteCatalog); registerDriveBackground(); registerCatalogSyncBackground(); });
