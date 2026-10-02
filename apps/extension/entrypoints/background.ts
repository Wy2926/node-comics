import { defineBackground } from 'wxt/utils/define-background';
import { registerSourceBackground } from '../src/sources/runtime/background';
import {registerDriveBackground} from '../src/comics/sources/google-drive/background';
import {registerCatalogSyncBackground} from '../src/comics/application/catalog-sync-background';
import {readWebsiteCatalog} from '../src/comics/application/website-catalog';
import {registerOptionalSourceContent} from '../src/sources/runtime/optional-content';
import {registerAnalyticsBackground} from '../src/analytics/background';
import {registerUninstallFeedback} from '../src/uninstall';
import {registerWebShortcutsBackground} from '../src/shortcuts/web-background';
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(({reason}) => {
    if (reason === 'install') void chrome.tabs.create({url: chrome.runtime.getURL('/reader.html')}).catch(() => {});
  });
  registerSourceBackground(readWebsiteCatalog); registerOptionalSourceContent(); registerDriveBackground(); registerCatalogSyncBackground(); registerAnalyticsBackground(); registerUninstallFeedback(); registerWebShortcutsBackground();
});
