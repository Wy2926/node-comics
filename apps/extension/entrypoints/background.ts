import { defineBackground } from 'wxt/utils/define-background';
import { registerSourceBackground } from '../src/sources/runtime/background';
import {registerDriveBackground} from '../src/comics/sources/google-drive/background';
import {readWebsiteCatalog} from '../src/comics/application/website-catalog';
import {registerOptionalSourceContent} from '../src/sources/runtime/optional-content';
import {registerAnalyticsBackground} from '../src/analytics/background';
import {registerUninstallFeedback} from '../src/uninstall';
import {registerWebShortcutsBackground} from '../src/shortcuts/web-background';
import {registerLocalHostBackground} from '../src/translation/channels/host-background';
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(({reason}) => {
    if (reason === 'install') void chrome.tabs.create({url: chrome.runtime.getURL('/reader.html')}).catch(() => {});
  });
  registerLocalHostBackground();
  // Retire older versions' shelf-wide checks; opening a book now owns automatic checks.
  for (const name of ['nc-catalog-sync','nc-catalog-sync-continue']) void chrome.alarms.clear(name).catch(() => {});
  registerSourceBackground(readWebsiteCatalog); registerOptionalSourceContent(); registerDriveBackground(); registerAnalyticsBackground(); registerUninstallFeedback(); registerWebShortcutsBackground();
});
