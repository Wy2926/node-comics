import {expect, it} from 'vitest';
import {verifySerialSite} from '../../../shared/gigaviewer/tests/serial-contract';
import {definition} from '../definition';
import {network} from '../network';
import {protocol} from '../protocol';

verifySerialSite(definition, protocol, network, 'https://cdn-img.feelweb.jp',
  'common:search_result', false, '2026-10-25');

it('declares free public reading without a login requirement', () => {
  expect(definition.sites![0].pricing).toBe('free');
  expect(definition.sites![0].accessTags).toBeUndefined();
});
