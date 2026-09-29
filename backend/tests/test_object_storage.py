"""Durable immutable publication and actual I/O failures."""
from io import BytesIO
import pytest
from app.storage import StorageError, get_store
from app.config import settings


def test_immutable_file_replay_and_conflicting_bytes(client, png):
    store = get_store()
    store.put_file('results/aa/a', BytesIO(png), 'image/png')
    store.put_file('results/aa/a', BytesIO(png), 'image/png')
    with pytest.raises(StorageError, match='storage'):
        store.put_file('results/aa/a', BytesIO(b'other'), 'image/png')
    assert store.read('results/aa/a') == png
    assert not list(settings().storage_path.rglob('*.part'))


def test_failed_publication_leaves_no_visible_file(client, png, monkeypatch):
    import app.storage as module
    monkeypatch.setattr(module.os, 'fsync', lambda _: (_ for _ in ()).throw(OSError('disk unavailable')))
    with pytest.raises(StorageError):
        get_store().put('results/aa/a', png, 'image/png')
    assert not get_store().exists('results/aa/a')
    assert not list(settings().storage_path.rglob('*.part'))


def test_full_disk_does_not_publish_or_overwrite(client, png, monkeypatch):
    import app.storage as module
    import errno
    def disk_full(*args):
        raise OSError(errno.ENOSPC, 'No space left on device')
    monkeypatch.setattr(module.shutil, 'copyfileobj', disk_full)
    with pytest.raises(StorageError) as failure:
        get_store().put('inputs/a/source', png, 'image/png', kind='original')
    assert failure.value.code == 'STORAGE_FULL'
    assert not get_store().exists('inputs/a/source')


@pytest.mark.parametrize('key', ['../outside', '/absolute', 'a//b', 'C:/outside', 'a/../outside'])
def test_server_paths_cannot_escape_volume(client, key):
    with pytest.raises(ValueError):
        get_store().path(key)


@pytest.mark.parametrize('same_bytes', [True, False])
def test_concurrent_publication_is_atomic_without_global_lock(client, png, monkeypatch, same_bytes):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    import app.storage as module
    barrier = Barrier(2)
    link = module.os.link

    def simultaneous_link(source, target):
        barrier.wait(timeout=5)
        return link(source, target)

    monkeypatch.setattr(module.os, 'link', simultaneous_link)
    payloads = [png, png if same_bytes else b'different']

    def publish(data):
        try:
            get_store().put('results/aa/concurrent', data, 'image/png')
            return 'published'
        except StorageError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(publish, payloads))
    assert results.count('published') == (2 if same_bytes else 1)
    assert results.count('STORAGE_CONFLICT') == (0 if same_bytes else 1)
    assert get_store().read('results/aa/concurrent') in payloads
    assert not list(settings().storage_path.rglob('*.part'))


def test_input_cleanup_reclaims_task_directory_without_removing_shared_prefix(client, png):
    store = get_store()
    store.put('inputs/first/source', png, 'image/png', kind='original')
    store.put('inputs/second/source', png, 'image/png', kind='original')
    store.put('results/aa/result', png, 'image/png')
    store.delete('inputs/first/source')
    store.delete('inputs/first/source')
    assert not store.path('inputs/first').exists()
    assert store.read('inputs/second/source') == png
    store.delete('results/aa/result')
    assert store.path('results/aa').is_dir()
