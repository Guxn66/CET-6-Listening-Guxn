import json
import time
from unittest.mock import Mock
import pytest
from xmu_rollcall import resident as r

@pytest.fixture
def store(tmp_path):
    result=r.Store(tmp_path/'history.sqlite')
    yield result
    result.db.close()

def test_dirty_upload_does_not_lose_concurrent_update(store):
    store.record('1','course','qr','pending')
    snapshot=store.dirty()
    store.record('1','course','qr','error','new')
    store.uploaded(snapshot,[])
    assert store.dirty()[0]['message']=='new'

def test_confirmed_is_not_overwritten(store):
    store.record('1','course','number','confirmed')
    store.record('1','course','number','expired')
    assert store.get('1')['status']=='confirmed'

def test_missing_pending_is_not_assumed_success(store):
    store.record('1','course','qr','pending')
    store.expire_missing(set())
    assert store.get('1')['status']=='expired'

def test_command_journal_is_at_most_once(store):
    assert store.begin_command('one')
    assert not store.begin_command('one')
    store.finish_command('one',True,'done')
    assert store.acknowledgements()==[{'id':'one','result':'done','ok':True}]

def test_qr_never_opens_dialog_and_does_not_block_number(store,monkeypatch):
    agent=r.Resident(store,{})
    agent.enabled.set()
    agent.login=Mock(return_value=Mock())
    agent.number=Mock()
    rows=[dict(rollcall_id=1,course_title='QR course'),dict(rollcall_id=2,course_title='Number course',is_number=True)]
    monkeypatch.setattr(r,'list_rollcalls',lambda _:rows)
    agent.poll()
    agent.number.assert_called_once()
    assert store.get('1')['status']=='pending'
    assert agent.status['queries']==1
    assert agent.status['lastQuery']>0

def test_already_signed_is_separate_from_our_confirmation(store,monkeypatch):
    agent=r.Resident(store,{})
    agent.enabled.set()
    agent.login=Mock()
    monkeypatch.setattr(r,'list_rollcalls',lambda _:[dict(rollcall_id=1,course_title='course',is_number=True,status='on_call_fine')])
    agent.poll()
    assert store.get('1')['status']=='already'

def test_own_pending_submission_can_be_confirmed_on_later_query(store,monkeypatch):
    store.record('1','course','number','unverified',attempt=True)
    agent=r.Resident(store,{})
    agent.enabled.set()
    agent.login=Mock()
    monkeypatch.setattr(r,'list_rollcalls',lambda _:[dict(rollcall_id=1,course_title='course',is_number=True,rollcall_status='on_call_fine')])
    agent.poll()
    assert store.get('1')['status']=='confirmed'

def test_expired_command_does_not_log_in(store):
    agent=r.Resident(store,{})
    agent.enabled.set()
    agent.login=Mock()
    agent.execute(dict(id='x',expiresAt=0,kind='qr',payload='{}'))
    agent.login.assert_not_called()
    assert not store.acknowledgements()[0]['ok']

def test_paused_command_does_not_log_in(store):
    agent=r.Resident(store,{})
    agent.login=Mock()
    agent.execute(dict(id='x',expiresAt=r.milliseconds()+10000,kind='radar',payload='{}'))
    agent.login.assert_not_called()

def test_wrong_qr_task_is_not_submitted(store,monkeypatch):
    store.record('1','course','qr','pending')
    agent=r.Resident(store,{})
    agent.enabled.set()
    agent.login=Mock()
    send=Mock()
    monkeypatch.setattr(r,'send_qr',send)
    agent.execute(dict(id='x',expiresAt=r.milliseconds()+10000,kind='qr',payload=json.dumps({'taskId':'1','text':json.dumps({'rollcallId':2,'data':'fresh'})})))
    send.assert_not_called()
    assert '不属于' in store.acknowledgements()[0]['result']

def test_number_requires_authoritative_confirmation(store,monkeypatch):
    agent=r.Resident(store,{})
    agent.enabled.set()
    monkeypatch.setattr(r,'get_number_rollcall_info',lambda *_:('0123','active',None,None))
    monkeypatch.setattr(r,'_current_task',lambda *_:{'is_number':True})
    submit=Mock(return_value=False)
    monkeypatch.setattr(r,'_submit',submit)
    agent.number(Mock(),'1','course')
    assert store.get('1')['status']=='unverified'
    assert submit.call_args.args[2]=='answer_number_rollcall'
    assert submit.call_args.args[3]['numberCode']=='0123'

def test_legacy_records_are_never_confirmed(store,tmp_path):
    path=tmp_path/'old.log'
    path.write_text('2026-10-27 14:00:00 INFO Course name: old course, rollcall created by teacher.\n2026-10-27 14:00:10 INFO Number code rollcall answered successfully.\n',encoding='utf-8')
    r.import_legacy(store,path)
    r.import_legacy(store,path)
    assert len(store.dirty())==1
    assert store.dirty()[0]['status']=='legacy'

@pytest.mark.parametrize('origin',['http://rollcall.example.chatgpt.site','https://evil.example','https://x.chatgpt.site/other','https://x.chatgpt.site?token=x','https://user@x.chatgpt.site'])
def test_pairing_is_bound_to_site_origin(origin):
    with pytest.raises(r.InputError):
        r.validate_pair({'origin':origin,'token':'x'*30})

def test_dpapi_roundtrip():
    if r.os.name!='nt':
        pytest.skip('Windows only')
    encrypted=r.protect(b'test secret')
    assert b'test secret' not in encrypted
    assert r.protect(encrypted,decrypt=True)==b'test secret'


def test_command_expiring_during_login_is_not_submitted(store,monkeypatch):
    store.record('1','course','qr','pending')
    agent=r.Resident(store,{})
    agent.enabled.set()
    clock=[1000]
    monkeypatch.setattr(r,'milliseconds',lambda:clock[0])
    def login():
        clock[0]=3000
        return Mock()
    agent.login=login
    send=Mock()
    monkeypatch.setattr(r,'send_qr',send)
    agent.execute(dict(id='expire-login',expiresAt=2000,kind='qr',payload=json.dumps({'taskId':'1','text':json.dumps({'rollcallId':1,'data':'fresh'})})))
    send.assert_not_called()
    assert '过期' in store.acknowledgements()[0]['result']


def test_monitor_timer_counts_only_healthy_awake_monitoring(store,monkeypatch):
    clock=[10.0];wall=[100000]
    monkeypatch.setattr(r,'awake_seconds',lambda:clock[0])
    monkeypatch.setattr(r,'milliseconds',lambda:wall[0])
    a=r.Resident(store,{})
    a.enabled.set();a.status.update(state='monitoring',lastQuery=wall[0])
    a.update_timer();clock[0]+=5;wall[0]+=5000;a.update_timer()
    assert a.status['activeMs']==5000
    a.enabled.clear();clock[0]+=5;wall[0]+=5000;a.update_timer()
    assert a.status['activeMs']==5000

def test_standby_gap_is_not_counted(store,monkeypatch):
    clock=[10.0];wall=[100000]
    monkeypatch.setattr(r,'awake_seconds',lambda:clock[0])
    monkeypatch.setattr(r,'milliseconds',lambda:wall[0])
    a=r.Resident(store,{})
    a.enabled.set();a.status.update(state='monitoring',lastQuery=wall[0]);a.update_timer()
    clock[0]+=1;wall[0]+=3600000;a.update_timer()
    assert a.status['activeMs']==0

def test_stalled_loop_is_not_counted(store,monkeypatch):
    clock=[10.0]
    monkeypatch.setattr(r,'awake_seconds',lambda:clock[0])
    a=r.Resident(store,{})
    a.enabled.set();a.status.update(state='monitoring',lastQuery=r.milliseconds());a.update_timer()
    clock[0]+=90;a.update_timer()
    assert a.status['activeMs']==0

def test_runtime_events_are_bounded_and_snapshot_is_independent(store):
    a=r.Resident(store,{})
    for i in range(50):a.event('query '+str(i))
    snapshot=a.packet();a.event('later')
    assert len(snapshot['events'])==40
    assert snapshot['events'][-1]['message']=='query 49'
    assert a.packet()['events'][-1]['message']=='later'


def test_enable_ack_requires_real_control_application(store):
    a=r.Resident(store,{})
    a.apply_control(True,12345)
    assert a.packet()['monitoringEnabled'] is True
    assert a.status['controlUpdatedAt']==12345
    a.next_poll=999
    a.apply_control(True,12346)
    assert a.next_poll==0
    a.apply_control(False,12347)
    assert a.packet()['monitoringEnabled'] is False
    assert a.status['state']=='paused'

def test_resume_event_and_immediate_requery_after_sleep_gap(store,monkeypatch):
    wall=[100000];awake=[10.0]
    monkeypatch.setattr(r,'milliseconds',lambda:wall[0])
    monkeypatch.setattr(r,'awake_seconds',lambda:awake[0])
    a=r.Resident(store,{})
    a.next_poll=999999
    wall[0]+=3600000;awake[0]+=1;a.update_timer()
    assert a.status['lastResumeAt']==wall[0]
    assert a.status['activeMs']==0
    assert a.next_poll==0
    assert '运行中断' in a.events[-1]['message']
