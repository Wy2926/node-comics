import {afterEach, expect, it, vi} from 'vitest';
import {CanvasDisplay} from '../src/inline/canvas-display';

afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
function fixture(boxSizing = 'content-box', edges = '0px') {
  const properties = new Map<string, string>();
  const preview = {src: '', alt: '', dataset: {}, previousElementSibling: undefined as unknown,
    decode: vi.fn(async () => {}), setAttribute: vi.fn(), remove: vi.fn(),
    style: {getPropertyValue: (key: string) => properties.get(key) ?? '', getPropertyPriority: () => 'important',
      setProperty: (key: string, value: string) => properties.set(key, value)}};
  const parent = {};
  const canvas = {parentElement: parent, offsetLeft: 102, offsetTop: 0, offsetWidth: 538, offsetHeight: 765,
    after: () => {preview.previousElementSibling = canvas;}};
  vi.stubGlobal('Image', class {constructor() {return preview;}});
  vi.stubGlobal('getComputedStyle', (element: unknown) => element === parent ? {position: 'relative'} : {
    width: '538px', height: '765.140625px', boxSizing,
    getPropertyValue: (name: string) => name === 'transform' ? 'translateY(-50%)' : /^(padding|border)-/.test(name) ? edges : '',
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return {display: new CanvasDisplay(canvas as unknown as HTMLCanvasElement), properties, preview};
}
it('retains fractional layout dimensions without applying transforms twice and releases the overlay on restore', async () => {
  const {display, properties, preview} = fixture();
  await display.show(new Blob(), 'result', () => true);
  expect(properties.get('width')).toBe('538px'); expect(properties.get('height')).toBe('765.140625px');
  expect(properties.get('transform')).toBe('translateY(-50%)'); expect(properties.get('left')).toBe('102px');
  display.restore(); expect(preview.remove).toHaveBeenCalledOnce(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
});
it.each(['content-box', 'border-box'])('retains the existing border-box footprint for %s canvases', async boxSizing => {
  const {display, properties} = fixture(boxSizing, '1.25px');
  await display.show(new Blob(), 'result', () => true);
  expect(properties.get('height')).toBe((boxSizing === 'content-box' ? 770.140625 : 765.140625) + 'px');
  display.restore();
});
