import type { SourceDefinition, SourceLocation } from '../contracts/definition';
import type { CreateSourcePage, SourcePageSession } from '../contracts/page';
import { resolveSource } from './resolve';
export class SourceNavigation {
  private current?: {
    url: string;
    controller: AbortController;
    session: SourcePageSession;
    location: SourceLocation;
    navigationId: string;
  };
  constructor(
    private document: Document,
    private definitions: readonly SourceDefinition[],
    private factories: Readonly<Record<string, CreateSourcePage>>,
    private invalidated: () => void = () => {},
  ) {}
  get(url: string) {
    if (this.current?.url === url) return this.current;
    this.dispose();
    const { definition, location } = resolveSource(url, this.definitions),
      factory = this.factories[definition.id];
    const controller = new AbortController(),
      session:SourcePageSession = factory ? factory({ document: this.document, location, signal: controller.signal }) : {
        direction:'ltr',
        snapshot:()=>({adapter:definition.id,url,title:definition.name,direction:'ltr',note:'',discoveryComplete:false,items:[]}),
        discoverPages:async()=>({status:'unsupported',code:'SOURCE_PAGE_UNSUPPORTED'}),
        inlineTargets:()=>[],dispose(){},
      };
    if (
      (!factory && definition.capabilities.inline) ||
      (definition.capabilities.inline && !session.inlineTargets) ||
      (definition.capabilities.pages && !session.discoverPages)
    ) {
      session.dispose();
      throw Error('SOURCE_CAPABILITY_MISMATCH');
    }
    this.current = { url, controller, session, location, navigationId: crypto.randomUUID() };
    return this.current;
  }
  dispose() {
    if (!this.current) return;
    this.current.controller.abort();
    this.current.session.dispose();
    this.current = undefined;
    this.invalidated();
  }
}
