import {Button} from './ui';
import {createContext, useContext, type ReactNode} from 'react';
export type Entity = {kind: 'users' | 'tasks'; id: string};
export const EntityActiveContext = createContext(false);
export const EntityContext = createContext<(entity: Entity) => void>(() => undefined);
export function EntityLink({kind, id, children}: Entity & {children: ReactNode}) {
  const open = useContext(EntityContext);
  return <Button type="button" className="text-link entity-link" onClick={() => open({kind, id})}>{children}</Button>;
}
