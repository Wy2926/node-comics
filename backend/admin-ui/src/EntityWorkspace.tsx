import {lazy, Suspense, useState, type ReactNode} from 'react';
import {Drawer} from 'antd';
import {EntityContext, EntityActiveContext, type Entity} from './EntityLink';
const EntityRecord = lazy(() => import('./EntityRecord'));
type Auth = {onUnauthorized: (message: string) => void};
export function EntityWorkspace({children, onUnauthorized}: Auth & {children: ReactNode}) {
  const [stack, setStack] = useState<Entity[]>([]);
  function open(entity: Entity) {
    setStack(current => {const index = current.findIndex(item => item.id === entity.id && item.kind === entity.kind);
      return index < 0 ? [...current, entity] : current.slice(0, index + 1);});
  }
  return <EntityContext.Provider value={open}><EntityActiveContext.Provider value={stack.length > 0}>{children}</EntityActiveContext.Provider>{stack.map((entity, index) => <Drawer key={`${entity.kind}:${entity.id}`} open
    title={entity.kind === 'users' ? '用户工作台' : '翻译任务'} size="large" rootClassName="entity-drawer" styles={{wrapper: {width: 'min(1180px, 94vw)'}}}
    onClose={() => setStack(current => current.slice(0, index))} maskClosable={false}>
    <Suspense fallback={<p role="status">正在读取详情…</p>}><EntityRecord entity={entity} onUnauthorized={onUnauthorized}/></Suspense>
  </Drawer>)}</EntityContext.Provider>;
}
