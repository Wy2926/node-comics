export const reasonIds = ['unused', 'sites', 'reading', 'translation', 'performance', 'pricing', 'privacy', 'other'] as const;
export type Reason = typeof reasonIds[number];
