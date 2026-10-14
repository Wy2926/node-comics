import type {ReactNode} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {Modal} from './components';
import './confirmation-dialog.css';

/** Content-only building blocks; callers retain ownership of the operation and its guards. */
export function DialogSubject({title,meta,icon='book'}:{title:string;meta?:ReactNode;icon?:string}){
  return <div className="nc-dialog-subject"><Icon name={icon} size={28}/><div><strong>{title}</strong>{meta&&<div className="nc-dialog-meta">{meta}</div>}</div></div>;
}

export function DialogNotice({title,children,tone='info',role}:{title?:string;children:ReactNode;tone?:'info'|'danger'|'success';role?:'alert'|'status'}){
  return <div className="nc-dialog-notice" data-tone={tone} role={role}><Icon name={tone==='success'?'check':'info'} size={20}/><div>{title&&<h3>{title}</h3>}<div>{children}</div></div></div>;
}

export function ConfirmationDialog({title,subject,meta,icon='trash',danger=true,action,busy=false,disabled=false,error,onConfirm,onClose,children,extraActions}:{
  title:string;subject:string;meta?:ReactNode;icon?:string;danger?:boolean;action:string;busy?:boolean;disabled?:boolean;error?:string;
  onConfirm:()=>void;onClose:()=>void;children:ReactNode;extraActions?:ReactNode;
}){
  return <Modal title={title} icon={icon} className={'nc-confirmation-dialog'+(danger?' is-danger':'')} onClose={()=>{if(!busy)onClose();}} footer={
    <div className="nc-dialog-footer" aria-busy={busy}>
      <button className="button secondary" disabled={busy} onClick={onClose}>{msg('取消')}</button>
      {extraActions}
      <button className={'button '+(danger?'danger':'primary')} disabled={busy||disabled} onClick={onConfirm}>
        {busy?<span className="spinner"/>:<Icon name={icon} size={18}/>}<span>{busy?msg('处理中…'):action}</span>
      </button>
    </div>
  }>
    <div className="nc-dialog-content">
      <DialogSubject title={subject} meta={meta}/>
      {children}
      {error&&<DialogNotice tone="danger" role="alert">{error}</DialogNotice>}
    </div>
  </Modal>;
}
