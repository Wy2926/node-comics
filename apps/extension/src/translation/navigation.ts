export const resourceSettingsHash='#settings/resources';

export function openTranslationPage(view:unknown){
  const hash=view==='resources'?resourceSettingsHash:view==='settings'?'#settings':'#account';
  return chrome.tabs.create({url:chrome.runtime.getURL('/reader.html'+hash)});
}
