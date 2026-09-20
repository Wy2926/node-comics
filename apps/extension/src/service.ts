// Product service is part of the build, never a user preference.
export const API_BASE = import.meta.env.VITE_API_BASE || 'https://comics.nodelane.net';
export const API_ORIGIN = new URL(API_BASE).origin;
