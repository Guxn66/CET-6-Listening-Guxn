import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import pytest

spec=importlib.util.spec_from_file_location('cloud_worker',Path(__file__).parents[1]/'cloud_worker.py')
cloud=importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)

def worker(tmp_path):
    return cloud.CloudResident(cloud.Store(tmp_path/'state.sqlite3'),{
        'username':'fixture','password':'fixture',
        'pair':{'origin':'https://example.chatgpt.site','token':'x'*32},
        'cookies':{'session':'fixture'}})

def test_cloud_entry_does_not_require_windows_pair_file(tmp_path):
    w=worker(tmp_path)
    assert w.status['version']=='cloud-1.0'
    assert w.packet()['accountReady'] is True
    assert not w.enabled.is_set()

def test_cloud_reuses_verified_session(tmp_path):
    w=worker(tmp_path)
    with patch.object(cloud,'verify_session',return_value=True) as verify:
        session=w.login()
        assert session.cookies.get('session')=='fixture'
        assert w.login() is session
        verify.assert_called_once()

def test_failed_poll_clears_inflight_clock(tmp_path):
    w=worker(tmp_path)
    with patch.object(cloud.Resident,'poll',side_effect=RuntimeError('fixture')):
        with pytest.raises(RuntimeError): w.poll()
    assert w.poll_started==0

def test_stalled_poll_exits_for_supervisor_restart(tmp_path):
    w=worker(tmp_path)
    w.poll_started=1
    with patch.object(cloud.time,'monotonic',return_value=122), patch.object(cloud.os,'_exit',side_effect=SystemExit) as die:
        with pytest.raises(SystemExit): w.heartbeat()
        die.assert_called_once_with(70)
