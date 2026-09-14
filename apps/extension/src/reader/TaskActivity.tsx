export function TaskActivity({waiting=false}:{waiting?:boolean}) {
  return waiting
    ? <span className="nc-task-animation waiting" aria-hidden="true"><i/><i/><i/></span>
    : <span className="nc-task-animation translating" aria-hidden="true"/>;
}
