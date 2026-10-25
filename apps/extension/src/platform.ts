/** Safari assigns a different extension origin to each installation. */
export function isSafariExtension(): boolean {
  return typeof chrome !== 'undefined' &&
    chrome.runtime?.getURL?.('').startsWith('safari-web-extension://') === true;
}
