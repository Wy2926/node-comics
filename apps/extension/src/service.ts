// Product service is part of the build, never a user preference.
export const API_BASE = 'https://comics.nodelane.net';
export const API_ORIGIN = new URL(API_BASE).origin;

// Reserved website route: /plus. Set this when the official upgrade page is live.
export const WEBSITE_UPGRADE_URL: string | null = null;
