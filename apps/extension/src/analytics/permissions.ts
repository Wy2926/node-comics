interface DataCollectionPermissions {data_collection: string[];}
const permission: DataCollectionPermissions & chrome.permissions.Permissions = {
  data_collection: ['technicalAndInteraction'],
};

function firefoxAnalytics(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox/');
}

export async function analyticsPermission(): Promise<boolean> {
  if (!firefoxAnalytics()) return true;
  try {
    return await chrome.permissions.contains(permission);
  } catch {
    return false;
  }
}

/** Called directly from the consent button handler, preserving the user gesture. */
export function requestAnalyticsPermission(): Promise<boolean> {
  if (!firefoxAnalytics()) return Promise.resolve(true);
  return chrome.permissions.request(permission).catch(()=>false);
}

export async function removeAnalyticsPermission(): Promise<void> {
  if (firefoxAnalytics()) await chrome.permissions.remove(permission).catch(()=>false);
}
