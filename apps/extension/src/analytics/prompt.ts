export const analyticsPromptStorageKey = 'nc-analytics-prompt-v1';

export interface AnalyticsPreferences {
  enabled: boolean;
  promptHandled: boolean;
  consentedAt?: number;
}

interface Dependencies {
  read: () => Promise<{prompt?: boolean; consent?: boolean; consented_at?: number}>;
  writePrompt: (handled: boolean) => Promise<void>;
  enabled: () => Promise<boolean>;
  setConsent: (enabled: boolean) => Promise<boolean>;
}

/** Keep the local choice outside the queue/identifier store, including after revocation. */
export function createAnalyticsPreferences(deps: Dependencies) {
  let serial = Promise.resolve();

  function lock<T>(work: () => Promise<T>): Promise<T> {
    const run = serial.then(work, work);
    serial = run.then(() => {}, () => {});
    return run;
  }

  async function handled(): Promise<boolean> {
    const saved = await deps.read();
    if (typeof saved.prompt === 'boolean') return saved.prompt;
    // An older explicit on/off setting is already a choice. Native permission alone is not.
    const previousChoice = typeof saved.consent === 'boolean';
    await deps.writePrompt(previousChoice);
    return previousChoice;
  }

  async function snapshot(enabled: boolean, promptHandled: boolean): Promise<AnalyticsPreferences> {
    const saved = enabled ? await deps.read() : undefined;
    const consentedAt = saved?.consented_at;
    return {enabled, promptHandled, ...(enabled && typeof consentedAt === 'number' && Number.isSafeInteger(consentedAt) && consentedAt >= 0 ? {consentedAt} : {})};
  }

  function status(): Promise<AnalyticsPreferences> {
    return lock(async () => {
      let promptHandled = await handled();
      const enabled = await deps.enabled();
      if (enabled && !promptHandled) {
        await deps.writePrompt(true);
        promptHandled = true;
      }
      return snapshot(enabled, promptHandled);
    });
  }

  function choose(wanted: boolean): Promise<AnalyticsPreferences> {
    return lock(async () => {
      let promptHandled = await handled();
      const enabled = await deps.setConsent(wanted);
      if (enabled === wanted) {
        await deps.writePrompt(true);
        promptHandled = true;
      }
      return snapshot(enabled, promptHandled);
    });
  }

  return {status, choose};
}
