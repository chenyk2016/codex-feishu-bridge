"""Offline launch preparation checks; never install a job or contact Feishu."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('launcher', Path(__file__).with_name('service-launcher.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherChecks(unittest.TestCase):
    """Exercise bounded private logs."""
    def test_logs_rotate_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'connector.log'
            log = launcher.RotatingLog(path, limit=20)
            for _ in range(20):
                log.write(b'1234567890\n')
            files = list(Path(name).iterdir())
            self.assertLessEqual(len(files), 4)
            self.assertTrue(all(p.stat().st_size <= 20 for p in files))
            self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in files))


if __name__ == '__main__':
    unittest.main()
