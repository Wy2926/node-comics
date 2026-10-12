import {useEffect, useState} from 'react';
import {processingDefaults, readProcessingSettings, subscribeProcessingSettings} from './settings';

export function useEnhancementVisible() {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return visible;
}

export function useProcessingSettings() {
  const [settings, setSettings] = useState(processingDefaults);
  useEffect(() => {
    let active = true, generation = 0;
    const load = () => {
      const version = ++generation;
      void readProcessingSettings().then(value => {if (active && version === generation) setSettings(value);}).catch(() => {});
    };
    load(); const stop = subscribeProcessingSettings(load);
    return () => {active = false; stop();};
  }, []);
  return settings;
}
