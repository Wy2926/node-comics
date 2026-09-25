/** Public store identities for manual installs. Submission ZIPs must omit key. */
const publicKeys: Record<string, string> = {
  chrome: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArcK9rWRp4mvqZn4F4bn6yAB2QZJxq9GqjnziRbP/TUOgxO/ieQeya6Q+ul6Oa84ww4P9hxXUYcMMRHnebQRfpV4d7Fuhmp5rToRjc9y0raaphioLbuUOIIY6hXBDfdL9yFxJsLhlleRvaFhUEh1ilNpEPzXrIF5kYgo94HbCZQKpiy/9tSgXpXT0a61d+rWa5ZJbDROnVOB+463qU8i3Cjs5gxakLrdtmILpzU4bglO8klexaNnHT0fa+U6MgBnu/XXhdyWC2t1ZLgjIkkCMDC3EKdI4RR4CH2E/2St2PFWGzdpdH+kxjbczGJAsHjMZsqSS0h5sFFK/mGCBK4qowwIDAQAB',
  edge: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArRcu/o/sm15fLPSzpDW92Cklr0qQwopn0d+G/593lO0iFat/NaT/pzesycmUlT9yK7XXY65EdrxWPG/I5wdutWLrzFCYnG0RxYFKffPGY0pLLRI17OcDg/PKhWYIwjmSfjgR4/AGHXwgob/7F0B3b5WTH/q1i496ECptBXFFDvrfXXKe5IwmeeeDvvmvoGPxn7+lQx6nfsqRLJoIkB0RjP9tP2y9MaZ+Xl1sL66LFKFf8vNp8GidN+fBy+Tj1TDzoAfWVzRqCkekp/UK/oMxT3bphnx6zGc+crBtOzgFrV/oczlwNj/HD1m2fmuZ6zYspbUEc5TmndVX+HzAxELWJQIDAQAB',
};
export function extensionIdentity(browser: string, storeSubmission = false): {key?: string} {
  return !storeSubmission && publicKeys[browser] ? {key: publicKeys[browser]} : {};
}
