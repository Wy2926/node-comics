/** Match a URL against a Chrome origin pattern, without granting paths or credentials. */
export function originMatches(pattern: string, value: string): boolean {
  const match = /^(https?|\*):\/\/(\*|\*\.[^/*:]+|[^/*:]+)(?::(\d+))?\/\*$/.exec(pattern);
  if (!match) return false;
  try {
    const url = new URL(value), host = match[2].toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      match[1] !== '*' && url.protocol !== match[1] + ':' || (url.port || '') !== (match[3] || '')) return false;
    return host === '*' || host.startsWith('*.') ? host === '*' || url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.hostname === host;
  } catch {return false;}
}
