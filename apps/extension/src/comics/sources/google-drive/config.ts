export function driveBridgeUrl(): string | undefined {
  const configured = import.meta.env.VITE_DRIVE_CONNECT_URL as string | undefined;
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/') return undefined;
    return url.href;
  } catch { return undefined; }
}
export function isDriveConfigured() { return driveBridgeUrl() !== undefined; }
