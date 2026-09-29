"""Bounded result HTTP ingress shared by all center API processes.

OS-held locks release on process death. No TTL can expire while a slow writer
still owns a slot, and files contain no request data or credentials.
"""
import os
from .config import settings
from .storage import StorageError


def _try_slot(root, index):
    path = root / 'staging' / f'.result-ingress-{index}.lock'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = path.open('a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            if path.stat().st_size == 0:
                handle.write(b'0')
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except (BlockingIOError, PermissionError):
        handle.close()
        return None
    except OSError as error:
        handle.close()
        if error.errno in (11, 13):
            return None
        raise


def release_result_ingress(handle):
    if handle is None or handle.closed:
        return
    if os.name == 'nt':
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    handle.close()


def acquire_result_ingress():
    cfg = settings()
    root = cfg.storage_path.resolve()
    for index in range(cfg.cluster_result_ingress_concurrency):
        selected = _try_slot(root, index)
        if selected is not None:
            return selected
    raise StorageError('RESULT_INGRESS_BUSY')


async def begin_result_ingress():
    """Cancellation during slot acquisition must not orphan an OS-held lock."""
    import asyncio
    from starlette.concurrency import run_in_threadpool
    task = asyncio.create_task(run_in_threadpool(acquire_result_ingress))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass
            except Exception:
                break
        try:
            admitted = task.result()
        except Exception:
            raise asyncio.CancelledError() from None
        release_result_ingress(admitted)
        raise
