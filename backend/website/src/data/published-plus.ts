// Public launch prices, independent of payment-channel activation.
// Keep aligned with docs/STRIPE_BILLING.md; these are never checkout offers.
export const publishedPlus = {
  monthlyAmount: '9.99',
  yearlyAmount: '99.99',
  monthlyRedrawPages: 300,
  trialDays: 7,
  trialRedrawPages: 30,
  purchaseLaunchBefore: '2026-09-30T00:00:00+08:00',
} as const;
