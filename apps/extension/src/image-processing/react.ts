import {useEffect, useLayoutEffect, useState} from 'react';
import {processingDefaults, readProcessingSettings, subscribeProcessingSettings} from './settings';
import type {ProcessingProfile} from './contracts';
import {ProcessingWindow, type ProcessingTarget} from './window';

export function useProcessingWindow(targets: ProcessingTarget[], profile?: ProcessingProfile, revision?: string, immediate = false) {
  const [, refresh] = useState(0);
  const [window] = useState(() => new ProcessingWindow(() => refresh(value => value + 1)));
  useLayoutEffect(() => {window.update(targets, profile, revision, immediate);}, [window, targets, profile?.id, profile?.revision, revision, immediate]);
  useLayoutEffect(() => () => window.clear(), [window]);
  return new Map(targets.map(target => [target.id, window.image(target, profile, revision)]));
}

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
  const [settings, setSettings] = useState(() => ({...processingDefaults(), ready: false}));
  useEffect(() => {
    let active = true, generation = 0;
    const load = () => {
      const version = ++generation;
      void readProcessingSettings().then(value => {if (active && version === generation) setSettings({...value, ready: true});})
        .catch(() => {if (active && version === generation) setSettings(value => ({...value, ready: true}));});
    };
    load(); const stop = subscribeProcessingSettings(load);
    return () => {active = false; stop();};
  }, []);
  return settings;
}
