"""Cloud entry point. Credentials arrive privately from the supervising process."""
import json
import logging
import multiprocessing
import os
import sys
import threading
import time
from pathlib import Path
import requests
from xmu_rollcall.resident import Resident, Store, credential_login, validate_pair
from xmu_rollcall.utils import verify_session


class CloudResident(Resident):
    def __init__(self, store, config):
        super().__init__(store, validate_pair(config['pair']))
        self.config = config
        self.poll_started = 0
        self.status['version'] = 'cloud-1.0'
        self.status['accountReady'] = True

    def login(self):
        if self.session is not None:
            return self.session
        session = requests.Session()
        cookies = self.config.get('cookies')
        if cookies:
            self.config.pop('cookies', None)
            session.cookies = requests.utils.cookiejar_from_dict(cookies)
            if verify_session(session):
                self.session = session
                return session
        session.close()
        receiver, sender = multiprocessing.Pipe(duplex=False)
        process = multiprocessing.Process(target=credential_login,
            args=(sender, self.config['username'], self.config['password']), daemon=True)
        process.start()
        sender.close()
        try:
            if not receiver.poll(75):
                raise RuntimeError('School login timeout')
            result = receiver.recv()
            if not result.get('cookies'):
                raise RuntimeError('School login needs attention')
            session = requests.Session()
            session.cookies = requests.utils.cookiejar_from_dict(result['cookies'])
            self.session = session
            return session
        finally:
            if process.is_alive():
                process.terminate()
            process.join(5)
            receiver.close()

    def poll(self):
        self.poll_started = time.monotonic()
        try:
            return super().poll()
        finally:
            self.poll_started = 0

    def packet(self):
        packet = super().packet()
        packet['accountReady'] = True
        return packet

    def heartbeat(self):
        while True:
            if self.poll_started and time.monotonic() - self.poll_started > 120:
                os._exit(70)
            # No course names, codes, credentials or cookies on stdout.
            print(json.dumps({'kind': 'heartbeat', 'state': self.status['state'],
                'lastQuery': self.status['lastQuery'], 'queries': self.status['queries'],
                'enabled': self.enabled.is_set()}), flush=True)
            time.sleep(5)


def main():
    multiprocessing.freeze_support()
    os.umask(0o077)
    config = json.loads(os.environ.pop('XMU_CLOUD_CONFIG'))
    directory = Path(os.environ['XMU_ROLLCALL_CONFIG_DIR'])
    directory.mkdir(parents=True, exist_ok=True)
    store = Store(directory / 'resident.sqlite3')
    if store.meta('enabled') is None:
        store.meta('enabled', '1' if config.get('enabled', False) else '0')
    worker = CloudResident(store, config)
    # Library logging can contain codes. Keep them only in the private relay.
    logging.disable(logging.CRITICAL)
    if '--diagnose' in sys.argv:
        from xmu_rollcall.attendance import list_rollcalls
        rows = list_rollcalls(worker.login())
        print(json.dumps({'authenticated': True, 'tasks': len(rows), 'submitted': False}), flush=True)
        return
    threading.Thread(target=worker.heartbeat, daemon=True).start()
    worker.run()


if __name__ == '__main__':
    main()
