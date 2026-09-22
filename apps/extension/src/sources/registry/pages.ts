import type { CreateSourcePage } from '../contracts/page';
import { createPage as generic } from '../generic/page';
import { createPage as comicpash } from '../sites/comicpash/page';
import { createPage as gunnerkrigg } from '../sites/gunnerkrigg/page';
import { createPage as mangacopy } from '../sites/mangacopy/page';
import { createPage as xkcd } from '../sites/xkcd/page';
export const pageFactories: Readonly<Record<string, CreateSourcePage>> = {
  generic,
  mangacopy,
  comicpash,
  xkcd,
  gunnerkrigg,
};
