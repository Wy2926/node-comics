import {expect, it} from 'vitest';
import {verifySerialSite} from '../../../shared/gigaviewer/tests/serial-contract';
import {definition} from '../definition';
import {network} from '../network';
import {protocol} from '../protocol';

verifySerialSite(definition, protocol, network, 'https://cdn-img.comic-ogyaaa.com',
  'common:search_result', false, '2026-10-25');

it('declares partial paid content without requiring login for public chapters', () => {
  expect(definition.sites![0].pricing).toBe('freemium');
  expect(definition.sites![0].accessTags).toBeUndefined();
});
