"""Run with backend/.venv/Scripts/python.exe -m unittest discover -s scripts -p test_paddle_sandbox_webhook.py."""
import hashlib
from contextlib import closing
import hmac
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from paddle_sandbox_webhook import MAX_BODY, create_app


class SandboxWebhookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "sandbox.env"
        self.config.write_text("PADDLE_ENVIRONMENT=sandbox\nPADDLE_WEBHOOK_SECRET=test-secret\n")
        self.database = self.root / "receipts.sqlite"
        self.client = TestClient(create_app(self.config, self.database))
        self.addCleanup(self.client.close)
        self.body = json.dumps({"event_id": "evt_" + "a" * 26, "event_type": "subscription.trialing",
            "occurred_at": "2026-09-16T12:00:00Z", "data": {"id": "sub_" + "b" * 26,
            "email": "must-not-be-stored@example.test"}}).encode()

    def send(self, body=None, timestamp=None, secret="test-secret"):
        body = self.body if body is None else body
        timestamp = str(int(time.time()) if timestamp is None else timestamp)
        digest = hmac.new(secret.encode(), timestamp.encode() + b":" + body, hashlib.sha256).hexdigest()
        return self.client.post("/webhooks/paddle", content=body,
            headers={"Paddle-Signature": f"ts={timestamp};h1={digest}", "Content-Type": "application/json"})

    def test_signed_delivery_deduplicates_across_restart_and_omits_private_data(self):
        self.assertFalse(self.send().json()["duplicate"])
        with TestClient(create_app(self.config, self.database)) as restarted:
            self.client, previous = restarted, self.client
            try:
                self.assertTrue(self.send().json()["duplicate"])
            finally:
                self.client = previous
        with closing(sqlite3.connect(self.database)) as db:
            row = db.execute("SELECT event_id, deliveries FROM receipts").fetchone()
        self.assertEqual(row, ("evt_" + "a" * 26, 2))
        self.assertNotIn(b"must-not-be-stored", self.database.read_bytes())

    def test_concurrent_replay_has_one_receipt(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(lambda _: self.send(), range(8)))
        self.assertTrue(all(r.status_code == 200 for r in responses))
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*), SUM(deliveries) FROM receipts").fetchone(), (1, 8))

    def test_paddle_simulator_event_id_is_accepted_and_distinguished(self):
        payload = json.loads(self.body)
        payload["event_id"] = "ntfsimevt_" + "c" * 26
        response = self.send(body=json.dumps(payload).encode())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["simulation"])
        self.assertFalse(response.json()["grants_entitlements"])

    def test_missing_wrong_or_malformed_signature_rejected(self):
        self.assertEqual(self.client.post("/webhooks/paddle", content=self.body).status_code, 401)
        self.assertEqual(self.send(secret="wrong").status_code, 401)
        self.assertEqual(self.client.post("/webhooks/paddle", content=self.body,
            headers={"Paddle-Signature": "ts=invalid;h1=bad"}).status_code, 401)

    def test_expired_and_future_signatures_rejected(self):
        for offset in (-600, 600):
            self.assertEqual(self.send(timestamp=int(time.time()) + offset).status_code, 401)

    def test_invalid_signed_payload_and_body_limit(self):
        for payload in (b"not json", b"[]", b"{}"):
            self.assertEqual(self.send(body=payload).status_code, 400)
        self.assertEqual(self.send(body=b"x" * (MAX_BODY + 1)).status_code, 413)

    def test_config_secret_can_be_added_after_start(self):
        self.config.write_text("PADDLE_ENVIRONMENT=sandbox\n")
        self.assertEqual(self.send().status_code, 503)
        self.config.write_text("PADDLE_ENVIRONMENT=sandbox\nPADDLE_WEBHOOK_SECRET=test-secret\n")
        self.assertEqual(self.send().status_code, 200)

    def test_production_config_rejected(self):
        self.config.write_text("PADDLE_ENVIRONMENT=production\nPADDLE_WEBHOOK_SECRET=test-secret\n")
        with self.assertRaises(ValueError):
            create_app(self.config, self.database)
        self.assertEqual(self.send().status_code, 503)


if __name__ == "__main__":
    unittest.main()
