/** Move a fixture through the range's assistive change path, with one destination. */
export async function setReaderProgress(range, value) {
  await range.evaluate((input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', {bubbles: true}));
  }, Number(value));
}
