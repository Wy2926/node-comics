import { defineBackground } from 'wxt/utils/define-background';
import { registerSourceBackground } from '../src/sources/runtime/background';
import {registerDriveBackground} from '../src/comics/sources/google-drive/background';
export default defineBackground(() => { registerSourceBackground(); registerDriveBackground(); });
