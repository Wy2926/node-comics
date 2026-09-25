import type {Capabilities,Mode} from '../../types';

/** A channel may omit a mode entirely. Disabled modes can still have readable past results. */
export function channelMode(caps:Capabilities|undefined,preferred:Mode):Mode {
  if(!caps||caps.modes.some(mode=>mode.id===preferred))return preferred;
  return caps.modes.find(mode=>mode.enabled)?.id??preferred;
}
