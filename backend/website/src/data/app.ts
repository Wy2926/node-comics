// Public release destinations. Keep latest downloads independent of a fixed tag.
export const appRelease = {
  repository: 'https://github.com/Wy2926/node-comics-app',
  latest: 'https://github.com/Wy2926/node-comics-app/releases/latest',
  androidSlug: 'android-app',
  // Preserve the existing iOS URL and its localized incoming links.
  iosSlug: 'ios-orion',
  architectures: ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
} as const;
