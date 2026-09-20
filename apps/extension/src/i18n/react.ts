import {useSyncExternalStore} from 'react';
import {getLocale,subscribeLocale} from './runtime';
/** Re-render without remounting the reader, dialogs, or in-progress imports. */
export const useUiLocale=()=>useSyncExternalStore(subscribeLocale,getLocale,getLocale);
