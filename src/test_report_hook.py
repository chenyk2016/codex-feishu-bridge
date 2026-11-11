"""The public Stop hook must obey explicit chat scope and the pause switch."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from connection_settings import set_enabled

spec = importlib.util.spec_from_file_location("report_hook", Path(__file__).with_name("report-hook.py"))
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class ReportHookChecks(unittest.TestCase):
    def test_registered_chat_only_and_no_new_outbox_during_pause(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "session-catalog.json"
            catalog.write_text(json.dumps({"version": 1, "sessions": [{"sessionId": "test_chat"}]}))
            catalog.chmod(0o600)
            event = {"hook_event_name": "Stop", "session_id": "test_chat", "turn_id": "turn_one",
                     "last_assistant_message": "Isolated test response."}
            set_enabled(root, False)
            self.assertIsNone(hook.queue_report(event, root))
            self.assertFalse((root / "turn-outbox").exists())
            set_enabled(root, True)
            self.assertIsNone(hook.queue_report({**event, "session_id": "unregistered"}, root))
            event_id = hook.queue_report(event, root)
            self.assertEqual(hook.queue_report(event, root), event_id)
            self.assertEqual(len(list((root / "turn-outbox").glob("*.json"))), 1)
            self.assertEqual((root / "turn-outbox" / (event_id + ".json")).stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
