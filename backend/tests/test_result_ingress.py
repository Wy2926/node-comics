"""Shared-volume result admission bounds streams before multipart spooling."""
import pytest
from app import result_ingress
from app.config import settings
from app.storage import StorageError


def test_slots_bound_concurrency_and_release_without_expiration(client):
    slots = [result_ingress.acquire_result_ingress() for _ in range(settings().cluster_result_ingress_concurrency)]
    try:
        with pytest.raises(StorageError) as error:
            result_ingress.acquire_result_ingress()
        assert error.value.code == 'RESULT_INGRESS_BUSY'
        result_ingress.release_result_ingress(slots.pop())
        replacement = result_ingress.acquire_result_ingress()
        result_ingress.release_result_ingress(replacement)
    finally:
        for slot in slots:
            result_ingress.release_result_ingress(slot)


def test_cancel_while_slot_is_being_acquired_cleans_up(client, monkeypatch):
    import asyncio
    from threading import Event
    acquired, resume = Event(), Event()
    real = result_ingress.acquire_result_ingress
    def delayed():
        slot = real()
        acquired.set()
        assert resume.wait(5)
        return slot
    monkeypatch.setattr(result_ingress, 'acquire_result_ingress', delayed)
    async def exercise():
        task = asyncio.create_task(result_ingress.begin_result_ingress())
        assert await asyncio.to_thread(acquired.wait, 5)
        task.cancel()
        resume.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(exercise())
    slots = [real() for _ in range(settings().cluster_result_ingress_concurrency)]
    for slot in slots:
        result_ingress.release_result_ingress(slot)
