// Public, build-time configuration only. Never put credentials in this project.
export const site = {
  name: 'NodeLane Comics',
  url: 'https://comics.nodelane.net',
  email: 'comics@nodelane.net',
  language: 'zh-CN',
  updated: '2026-09-20',
  // Fill with the exact listing URLs; empty values render accessible disabled buttons.
  stores: {
    chrome: '',
    edge: '',
    firefox: '',
  },
} as const;

export const absolute = (path: string) => new URL(path, site.url).href;
