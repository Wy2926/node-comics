import {useCallback, useEffect, useRef, useState} from 'react';
import {BlobPicture, type BlobPictureProps} from './Images';
import {enhanceImage} from '../image-processing/runtime';
import type {ProcessingProfile, ProcessingState} from '../image-processing/contracts';
import {EnhancementStatus} from './EnhancementStatus';

/** Display the parent immediately; enhancement never owns the translation's load/retry identity. */
export function EnhancedPicture({profile, owner, eligible, revision, ...picture}: BlobPictureProps & {
  profile?: ProcessingProfile; owner: string; eligible: boolean; revision?: string;
}) {
  const identity = JSON.stringify([picture.scope, picture.blobKey, profile?.id, profile?.revision, revision]);
  const [input, setInput] = useState<{identity: string; blob: Blob}>();
  const [result, setResult] = useState<{identity: string; blob: Blob}>();
  const [state, setState] = useState<{identity: string; value: ProcessingState}>();
  const [attempt, setAttempt] = useState(0), manual = useRef<string | undefined>(undefined);
  const onOriginal = useCallback((blob: Blob) => setInput(previous => previous?.identity === identity && previous.blob === blob ? previous : {identity, blob}), [identity]);
  useEffect(() => {
    if (!profile || !eligible) {manual.current = undefined; setInput(undefined); setResult(undefined); setState(undefined); return;}
    if (input?.identity !== identity || !picture.blobKey) return;
    const controller = new AbortController();
    const retry = manual.current === identity; manual.current = undefined;
    void enhanceImage({blob: input.blob, key: picture.blobKey, owner}, profile, controller.signal,
      value => {if (!controller.signal.aborted) setState({identity, value});}, retry).then(blob => {
      if (!controller.signal.aborted) setResult({identity, blob});
    }).catch(error => {
      if (!controller.signal.aborted && error.name !== 'AbortError') setState({identity, value: {phase: 'error', message: error.message}});
    });
    return () => controller.abort();
  }, [identity, input, eligible, owner, attempt]);
  const current = profile && eligible && state?.identity === identity ? state.value : undefined;
  return <><BlobPicture {...picture} onOriginal={profile && eligible ? onOriginal : undefined} override={profile && eligible && result?.identity === identity ? result.blob : undefined}/>
    <EnhancementStatus state={current} onRetry={() => {manual.current = identity; setAttempt(value => value + 1);}}/>
  </>;
}
