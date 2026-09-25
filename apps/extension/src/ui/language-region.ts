/** Presentation only: explicit BCP 47 regions take precedence over CLDR likely regions. */
export function languageRegion(language: string): string | undefined {
  try {
    const locale = new Intl.Locale(language.replaceAll('_', '-'));
    // Undefined, multiple and non-linguistic content must not inherit a default country.
    if (!locale.language || ['und', 'mul', 'zxx'].includes(locale.language)) return;
    const region = locale.region ?? locale.maximize().region;
    // World and macroregions (e.g. es-419) have no single national flag.
    return region && /^[A-Z]{2}$/.test(region) ? region : undefined;
  } catch { return; }
}
