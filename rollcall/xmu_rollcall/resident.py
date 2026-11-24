"""Desktop attendance worker; only sanitized status crosses the private relay."""
from collections import deque
import argparse
import base64
import ctypes
import getpass
import hashlib
import io
import json
import logging
import multiprocessing
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import queue
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit
import uuid

import requests
from .attendance import list_rollcalls, answered, send_qr, send_radar, _current_task, _submit
from .config import CONFIG_DIR, load_config, get_current_account, get_interval
from .device_input import InputError, parse_qr_text, read_qr_image
from .utils import load_session, save_session, verify_session
from .verify import get_number_rollcall_info

log = logging.getLogger('resident')
VERSION = 'resident-1.3'


def milliseconds():
    return int(time.time() * 1000)


def awake_seconds():
    """Windows working-state clock: excludes sleep and hibernation."""
    if os.name == 'nt':
        ticks = ctypes.c_ulonglong()
        if ctypes.windll.kernel32.QueryUnbiasedInterruptTime(ctypes.byref(ticks)):
            return ticks.value / 10000000
        raise ctypes.WinError()
    return time.monotonic()


class Store:
    def __init__(self, path):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY, course TEXT, kind TEXT, status TEXT,
                message TEXT, firstSeen INTEGER, updatedAt INTEGER,
                dirty INTEGER NOT NULL DEFAULT 1, attempted INTEGER NOT NULL DEFAULT 0,
                lastAttempt INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, result TEXT,
                ok INTEGER, acknowledged INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        ''')

    def meta(self, key, value=None):
        with self.lock, self.db:
            if value is not None:
                self.db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key,str(value)))
            row = self.db.execute('SELECT value FROM meta WHERE key=?',(key,)).fetchone()
            return row[0] if row else None

    def get(self, key):
        with self.lock:
            r = self.db.execute('SELECT * FROM records WHERE id=?',(str(key),)).fetchone()
            return dict(r) if r else None

    def record(self, key, course, kind, status, message='', at=None, attempt=False):
        with self.lock, self.db:
            old = self.get(key)
            now = at or milliseconds()
            if old and old['status'] == 'confirmed':
                return
            if kind == 'number' and old and not re.match(r'\A签到码：[0-9]{1,20}(?:\n|$)', message):
                saved = re.match(r'\A(签到码：[0-9]{1,20})(?:\n|$)', old['message'])
                if saved:
                    message = saved[1] + ('\n' + message if message else '')
            if old and old['status'] == status and old['message'] == message and not attempt:
                return
            now = max(now, old['updatedAt'] + 1 if old else now)
            self.db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?,?,?,?)',
                (str(key),course[:200],kind,status,message[:300],old['firstSeen'] if old else now,
                 now,1,int(attempt or bool(old and old['attempted'])),
                 now if attempt else (old['lastAttempt'] if old else 0)))

    def dirty(self):
        with self.lock:
            return [dict(r) for r in self.db.execute('SELECT id,course,kind,status,message,firstSeen,updatedAt FROM records WHERE dirty=1 LIMIT 500')]

    def uploaded(self, records, ack):
        with self.lock, self.db:
            for r in records:
                self.db.execute('UPDATE records SET dirty=0 WHERE id=? AND updatedAt=?',(r['id'],r['updatedAt']))
            for a in ack:
                self.db.execute('UPDATE commands SET acknowledged=1 WHERE id=?',(a['id'],))

    def begin_command(self, key):
        with self.lock, self.db:
            return self.db.execute('INSERT OR IGNORE INTO commands(id,result,ok) VALUES (?,?,0)',
                (key,'上次指令可能中断，请先核对学校记录')).rowcount == 1

    def finish_command(self, key, ok, result):
        with self.lock, self.db:
            self.db.execute('UPDATE commands SET result=?,ok=?,acknowledged=0 WHERE id=?',(result[:300],int(ok),key))

    def acknowledgements(self):
        with self.lock:
            return [{'id':r['id'],'result':r['result'],'ok':bool(r['ok'])}
                    for r in self.db.execute('SELECT * FROM commands WHERE acknowledged=0 LIMIT 30')]

    def expire_missing(self, active):
        with self.lock:
            rows = list(self.db.execute("SELECT * FROM records WHERE status IN ('pending','error','unverified')"))
        for r in rows:
            if r['id'] not in active:
                self.record(r['id'],r['course'],r['kind'],'expired','任务已不在当前列表，未推断为成功')


def import_legacy(store, path):
    if store.meta('legacy_imported'):
        return
    course = None
    if path.exists():
        with path.open(encoding='utf-8', errors='replace') as source:
            for line in source:
                line = re.sub(r'\x1b\[[0-9;]*m','',line)
                match = re.search(r'Course name: (.+), rollcall created by ',line)
                if match:
                    course = match[1]
                if course and 'Number code rollcall answered successfully.' in line:
                    stamp = re.match(r'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)',line)
                    if not stamp:
                        continue
                    at = int(datetime.strptime(stamp[1],'%Y-%m-%d %H:%M:%S').timestamp()*1000)
                    key = 'legacy-' + hashlib.sha256((stamp[1]+course).encode()).hexdigest()[:24]
                    store.record(key,course,'number','legacy','旧版仅记录提交成功，未回查学校确认',at=at)
    store.meta('legacy_imported','1')


def protect(data, decrypt=False):
    if os.name != 'nt':
        raise RuntimeError('Windows DPAPI required')
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]
    buf = ctypes.create_string_buffer(data)
    incoming = Blob(len(data),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    if decrypt:
        ok = ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(incoming),None,None,None,None,1,ctypes.byref(outgoing))
    else:
        ok = ctypes.windll.crypt32.CryptProtectData(ctypes.byref(incoming),'XMU private relay',None,None,None,1,ctypes.byref(outgoing))
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(outgoing.data,outgoing.size)
    finally:
        ctypes.windll.kernel32.LocalFree(outgoing.data)


def validate_pair(value):
    origin = value.get('origin','')
    url = urlsplit(origin)
    if url.scheme != 'https' or not url.hostname or not url.hostname.endswith('.chatgpt.site') or url.path not in ('','/') or url.query or url.fragment or url.username or url.port:
        raise InputError('Pairing requires the exact HTTPS private Site origin.')
    if not isinstance(value.get('token'),str) or len(value['token']) < 20:
        raise InputError('Pairing token missing.')
    return {'origin':origin.rstrip('/'),'token':value['token']}


def power_status():
    if os.name != 'nt':
        return {'acPower':None,'batteryPercent':None}
    class Power(ctypes.Structure):
        _fields_=[('ac',ctypes.c_ubyte),('flag',ctypes.c_ubyte),('percent',ctypes.c_ubyte),('reserved',ctypes.c_ubyte),('remaining',ctypes.c_uint32),('full',ctypes.c_uint32)]
    power=Power()
    if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(power)):
        return {'acPower':None,'batteryPercent':None}
    return {'acPower':power.ac==1 if power.ac in (0,1) else None,
            'batteryPercent':int(power.percent) if power.percent<=100 else None}


def keep_awake(enabled):
    if os.name != 'nt':
        return False
    class Power(ctypes.Structure):
        _fields_=[('ac',ctypes.c_ubyte),('flag',ctypes.c_ubyte),('percent',ctypes.c_ubyte),('reserved',ctypes.c_ubyte),('remaining',ctypes.c_uint32),('full',ctypes.c_uint32)]
    power = Power()
    ac = ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(power)) and power.ac == 1
    required = enabled and ac
    ok = ctypes.windll.kernel32.SetThreadExecutionState(0x80000001 if required else 0x80000000)
    return bool(required and ok)


class Resident:
    def __init__(self, store, pair):
        self.store,self.pair = store,pair
        self.enabled = threading.Event()
        if store.meta('enabled') == '1':
            self.enabled.set()
        self.work = queue.Queue()
        self.queued = set()
        self.session = None
        self.status = dict(state='paused',lastQuery=0,queries=0,error='',keepAwake=False,
                           accountReady=False,version=VERSION,startedAt=milliseconds(),
                           activeMs=0,pollingStartedAt=0,lastQueryDurationMs=0,intervalSeconds=30,controlUpdatedAt=0,lastResumeAt=0,
                           nextQueryAt=0,pollInFlight=False)
        self.events=deque(maxlen=40)
        self.event_lock=threading.RLock()
        self._timer_tick=awake_seconds()
        self._timer_wall=milliseconds()
        self._last_ac=None
        self._counting=False
        self._relay_failed=False
        self.next_poll = 0

    def event(self, message, level='info'):
        with self.event_lock:
            self.events.append({'at':milliseconds(),'level':level,'message':message[:200]})
        getattr(log,level,log.info)(message)

    def update_timer(self):
        tick=awake_seconds()
        elapsed=max(0,tick-self._timer_tick)
        wall=milliseconds()
        gap=wall-self._timer_wall-elapsed*1000
        if gap>20000:
            self._counting=False
            self.status['lastResumeAt']=wall
            self.next_poll=0
            self.event('检测到运行中断约 %s 分钟，已安排重新查询' % max(1,int(gap/60000)),'warning')
        self._timer_wall=wall
        fresh=0 <= milliseconds()-self.status['lastQuery'] <= max(30000,self.status['intervalSeconds']*1000+30000)
        healthy=self.enabled.is_set() and self.status['state']=='monitoring' and bool(self.status['lastQuery']) and fresh
        # A stalled loop cannot invent monitoring time. Windows standby is excluded by the clock.
        if self._counting and healthy and elapsed <= 30:
            self.status['activeMs']+=int(elapsed*1000)
        self._timer_tick=tick
        self._counting=healthy

    def packet(self):
        self.update_timer()
        with self.event_lock:
            return dict(self.status,monitoringEnabled=self.enabled.is_set(),events=list(self.events),**power_status())

    def apply_control(self, enabled, stamp):
        changed=stamp!=self.status['controlUpdatedAt']
        self.store.meta('enabled','1' if enabled else '0')
        if enabled!=self.enabled.is_set():
            self.event('监控已启用' if enabled else '监控已暂停')
        if enabled:
            if not self.enabled.is_set() or changed:
                self.next_poll=0
            self.enabled.set()
        else:
            self.enabled.clear()
            self.status['state']='paused'
        self.status['controlUpdatedAt']=stamp

    def login(self):
        if self.session is not None:
            return self.session
        account = get_current_account(load_config())
        self.status['accountReady'] = bool(account)
        if not account:
            raise InputError('请先用原客户端配置本机账号')
        session = requests.Session()
        if not (load_session(session,account['id']) and verify_session(session)):
            session.close()
            receiver,sender=multiprocessing.Pipe(duplex=False)
            process=multiprocessing.Process(target=credential_login,args=(sender,account['username'],account['password']),daemon=True)
            process.start()
            sender.close()
            try:
                if not receiver.poll(75):
                    raise InputError('学校登录超时，稍后自动重试')
                result=receiver.recv()
                if not result.get('cookies'):
                    raise InputError('学校登录失败，请在原客户端刷新登录')
                session=requests.Session()
                session.cookies=requests.utils.cookiejar_from_dict(result['cookies'])
            finally:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=5)
                receiver.close()
            save_session(session,account['id'])
        self.session = session
        return session

    def poll(self):
        started=awake_seconds()
        self.status['pollInFlight']=True
        self.event('开始查询学校签到列表')
        session = self.login()
        rows = list_rollcalls(session)
        self.status.update(lastQuery=milliseconds(),queries=self.status['queries']+1,error='',state='monitoring')
        self.status.update(pollInFlight=False,lastQueryDurationMs=int((awake_seconds()-started)*1000))
        if not self.status['pollingStartedAt']:
            self.status['pollingStartedAt']=self.status['lastQuery']
        self.event('查询成功：第 %s 次，当前 %s 个签到任务' % (self.status['queries'],len(rows)))
        self.store.expire_missing({str(r.get('rollcall_id')) for r in rows})
        # Numeric tasks run first. QR and radar only register pending input.
        for row in sorted(rows,key=lambda r:not r.get('is_number')):
            if not self.enabled.is_set():
                break
            key = str(row.get('rollcall_id'))
            if not key.isdecimal():
                continue
            course = str(row.get('course_title') or '未命名课程')
            kind = 'radar' if row.get('is_radar') else 'number' if row.get('is_number') else 'qr'
            old = self.store.get(key)
            if answered(row):
                self.store.record(key,course,kind,'confirmed' if old and old['attempted'] else 'already')
            elif row.get('is_expired') or row.get('status') in {'finished','expired','closed'}:
                self.store.record(key,course,kind,'expired','签到已结束')
            elif kind != 'number':
                if not old or old['status'] not in {'error','unverified'}:
                    self.store.record(key,course,kind,'pending','等待当前课堂二维码' if kind == 'qr' else '等待手机实时定位')
            elif not old or milliseconds()-old['lastAttempt'] >= 60000:
                try:
                    self.number(session,key,course)
                except Exception as exc:
                    self.store.record(key,course,kind,'unverified','请求未确认，下次查询先核对学校状态')
                    log.warning('Number task %s failed: %s',key,type(exc).__name__)
        log.info('School heartbeat: queries=%s tasks=%s',self.status['queries'],len(rows))

    def number(self, session, key, course):
        code,status,end,error = get_number_rollcall_info(session,key)
        if error or not code:
            self.store.record(key,course,'number','error','学校未返回数字码，将持续查询')
            return
        code = str(code)
        if not re.fullmatch(r'[0-9]{1,20}', code):
            self.store.record(key,course,'number','error','学校返回的签到码格式无效，将持续查询')
            return
        self.store.record(key,course,'number','pending','签到码：' + code)
        self.event('数字签到码：%s · %s · 已获取，等待学校确认' % (code,course[:100]))
        if end:
            expiry = datetime.fromisoformat(end)
            if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc):
                self.store.record(key,course,'number','expired','数字签到已结束或结束时间无效')
                return
        row = _current_task(session,key,'number')
        if answered(row):
            self.store.record(key,course,'number','already')
            return
        if not row.get('is_number') or row.get('is_radar') or not self.enabled.is_set():
            return
        self.store.record(key,course,'number','unverified','已发起提交，等待学校确认',attempt=True)
        ok = _submit(session,key,'answer_number_rollcall',{'deviceId':str(uuid.uuid4()),'numberCode':code})
        self.store.record(key,course,'number','confirmed' if ok else 'unverified','' if ok else '提交尚未确认，将回查学校状态')
        self.event('数字签到码：%s · %s · %s' % (code,course[:100],'学校已确认' if ok else '待学校确认'))

    def execute(self, command):
        key = command['id']
        if not self.store.begin_command(key):
            return
        ok,result = False,'指令未执行'
        try:
            if command['expiresAt'] < milliseconds():
                raise InputError('指令过期，请重新操作')
            if not self.enabled.is_set():
                raise InputError('监控已暂停，指令未执行')
            body = json.loads(command['payload'])
            if command['kind'] == 'poll':
                self.next_poll=0
                ok,result=True,'已安排立即查询'
            else:
                task = self.store.get(body['taskId'])
                if not task or task['status'] in {'expired','confirmed','already','legacy'}:
                    raise InputError('任务已结束或已签到，请刷新列表')
                session = self.login()
                if command['kind'] == 'qr':
                    qr = body.get('text')
                    if body.get('image'):
                        image = base64.b64decode(body['image'].split(',',1)[1],validate=True)
                        if len(image)>525000:
                            raise InputError('图片过大')
                        qr = read_qr_image(io.BytesIO(image))
                    else:
                        qr = parse_qr_text(qr)
                    if str(qr['rollcallId']) != body['taskId']:
                        raise InputError('二维码不属于选中的签到')
                elif command['kind'] != 'radar':
                    raise InputError('指令类型无效')
                # Login/decoding may take time: enforce expiry and pause again at submission.
                if command['expiresAt'] <= milliseconds():
                    raise InputError('指令过期，请重新操作')
                if not self.enabled.is_set():
                    raise InputError('监控已暂停，指令未执行')
                self.store.record(task['id'],task['course'],task['kind'],'unverified','正在核对提交结果',attempt=True)
                ok = send_qr(session,qr,expected_rollcall_id=body['taskId']) if command['kind']=='qr' else send_radar(session,body['taskId'],location=body['location'])
                result = '学校已确认签到' if ok else '学校尚未确认，请检查二维码、定位和官方记录'
                self.store.record(task['id'],task['course'],task['kind'],'confirmed' if ok else 'error','' if ok else result)
                self.next_poll=0
        except InputError as exc:
            result=str(exc)[:300]
        except Exception as exc:
            result='操作未确认，请先检查官方记录再重试'
            log.warning('Command %s failed: %s',key,type(exc).__name__)
        finally:
            self.store.finish_command(key,ok,result)

    def worker(self):
        retry=5
        while True:
            try:
                try:
                    command=self.work.get(timeout=1)
                except queue.Empty:
                    command=None
                if command:
                    try:
                        self.execute(command)
                    finally:
                        self.queued.discard(command['id'])
                if self.enabled.is_set() and time.monotonic()>=self.next_poll:
                    interval=min(30,max(15,get_interval(load_config())))
                    scheduled=time.monotonic()
                    self.status['intervalSeconds']=interval
                    self.poll()
                    retry=5
                    self.next_poll=scheduled+interval
                    self.status['nextQueryAt']=milliseconds()+max(0,int((self.next_poll-time.monotonic())*1000))
                elif not self.enabled.is_set():
                    self.status['state']='paused'
            except (Exception,SystemExit) as exc:
                if self.session:
                    self.session.close()
                self.session=None
                self.status.update(state='retrying',pollInFlight=False,error='学校连接或登录异常，后台将持续重试')
                self.event('学校查询失败，%s 秒后重试（%s）' % (retry,type(exc).__name__),'warning')
                self.status['nextQueryAt']=milliseconds()+retry*1000
                log.warning('School retry in %ss: %s',retry,type(exc).__name__)
                self.next_poll=time.monotonic()+retry
                retry=min(retry*2,30)

    def run(self):
        self.status['accountReady']=bool(get_current_account(load_config()))
        threading.Thread(target=self.worker,daemon=True,name='school-worker').start()
        transport=requests.Session()
        self.event('常驻后台已启动，等待控制台同步')
        try:
            while True:
                self.status['keepAwake']=keep_awake(self.enabled.is_set())
                ac=power_status()['acPower']
                if ac is not None and ac!=self._last_ac:
                    self.event('已接通电源' if ac else '当前为电池供电，持续签到请接电；系统可能进入待机', 'info' if ac else 'warning')
                    self._last_ac=ac
                records,ack=self.store.dirty(),self.store.acknowledgements()
                try:
                    response=transport.post(self.pair['origin']+'/api/agent',
                        headers={'OAI-Sites-Authorization':'Bearer '+self.pair['token'],'x-rollcall-agent':'desktop-v1'},
                        json={'agent':self.packet(),'records':records,'ack':ack},timeout=(5,20),allow_redirects=False)
                    response.raise_for_status()
                    payload=response.json()
                    if not isinstance(payload.get('enabled'),bool) or not isinstance(payload.get('commands'),list):
                        raise ValueError('Unexpected relay response')
                    if self._relay_failed:
                        self.event('控制台连接已恢复')
                    self._relay_failed=False
                    self.store.uploaded(records,ack)
                    self.apply_control(payload['enabled'],payload.get('controlUpdatedAt',0))
                    for command in payload['commands']:
                        if command['id'] not in self.queued:
                            self.queued.add(command['id'])
                            self.work.put(command)
                except Exception as exc:
                    if not self._relay_failed:
                        self.event('控制台连接中断，本地状态保留并自动重连','warning')
                    self._relay_failed=True
                    log.warning('Relay unavailable: %s; local monitoring state retained',type(exc).__name__)
                time.sleep(5)
        finally:
            keep_awake(False)
            transport.close()


def credential_login(sender, username, password):
    # The upstream login helper has no request timeouts. Isolate it so an
    # unavailable identity server cannot permanently stall attendance polling.
    try:
        from xmulogin import xmulogin
        session=xmulogin(type=3,username=username,password=password)
        sender.send({'cookies':requests.utils.dict_from_cookiejar(session.cookies) if session else {}})
    except BaseException:
        sender.send({'cookies':{}})
    finally:
        sender.close()


def main():
    multiprocessing.freeze_support()
    parser=argparse.ArgumentParser()
    parser.add_argument('--pair-stdin',action='store_true')
    args=parser.parse_args()
    CONFIG_DIR.mkdir(parents=True,exist_ok=True)
    pairfile=CONFIG_DIR/'resident-pair.dpapi'
    if args.pair_stdin:
        print('Ready for pairing JSON (hidden).',flush=True)
        value=validate_pair(json.loads(getpass.getpass('Pair: ')))
        pairfile.write_bytes(protect(json.dumps(value).encode()))
        print('Paired. Secret protected for this Windows user.',flush=True)
        return
    mutex=None
    if os.name=='nt':
        ctypes.windll.kernel32.CreateMutexW.restype=ctypes.c_void_p
        mutex=ctypes.windll.kernel32.CreateMutexW(None,False,'Local\\XmuRollcallResident')
        if ctypes.windll.kernel32.GetLastError()==183:
            return
    handler=RotatingFileHandler(CONFIG_DIR/'resident.log',maxBytes=3000000,backupCount=3,encoding='utf-8')
    logging.basicConfig(level=logging.INFO,handlers=[handler],format='%(asctime)s %(levelname)s %(name)s %(message)s')
    try:
        pair=validate_pair(json.loads(protect(pairfile.read_bytes(),decrypt=True)))
        store=Store(CONFIG_DIR/'resident.sqlite3')
        import_legacy(store,CONFIG_DIR/'xmu_rollcall.log')
        log.info('Resident started: %s',VERSION)
        Resident(store,pair).run()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        log.error('Resident startup failed: %s',type(exc).__name__)
        raise
    finally:
        if mutex:
            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(mutex))


if __name__=='__main__':
    main()
