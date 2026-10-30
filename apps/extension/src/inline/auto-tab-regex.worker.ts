export {};
self.onmessage = ({data}: MessageEvent<{pattern: string; url: string}>) => {
  try { self.postMessage({matches: new RegExp(data.pattern).test(data.url)}); }
  catch { self.postMessage({matches: false, error: 'invalid'}); }
};
self.postMessage({ready: true});
