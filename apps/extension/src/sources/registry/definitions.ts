import { definition as generic } from '../generic/definition';
import { definition as comicpash } from '../sites/comicpash/definition';
import { definition as gunnerkrigg } from '../sites/gunnerkrigg/definition';
import { definition as mangacopy } from '../sites/mangacopy/definition';
import { definition as xkcd } from '../sites/xkcd/definition';
export const definitions = [generic, mangacopy, comicpash, xkcd, gunnerkrigg] as const;
