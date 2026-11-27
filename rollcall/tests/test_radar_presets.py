import json
import time
from unittest.mock import Mock

from xmu_rollcall import attendance, config, coord, resident as r


def test_wgs84_gcj02_roundtrip_xiamen():
    lat, lng = 24.6123, 118.3012
    glat, glng = coord.wgs84_to_gcj02(lat, lng)
    # In Xiamen, GCJ-02 shifts south/east by a few hundred meters.
    assert abs(glat - lat) > 0.001
    assert abs(glng - lng) > 0.001
    rlat, rlng = coord.gcj02_to_wgs84(glat, glng)
    assert abs(rlat - lat) < 1e-5
    assert abs(rlng - lng) < 1e-5


def test_send_radar_converts_wgs84_only_when_tagged(monkeypatch):
    submitted = []
    monkeypatch.setattr(attendance, "_current_task", lambda *_: {"rollcall_id": 42, "is_radar": True})
    monkeypatch.setattr(attendance, "_submit", lambda _s, _id, _ep, payload: submitted.append(payload) or True)

    now = time.time()
    assert attendance.send_radar(Mock(), 42, {
        "latitude": 24.6123, "longitude": 118.3012, "accuracy": 20, "altitude": 0,
        "timestamp": now, "coordType": "wgs84",
    })
    expected_lat, expected_lng = coord.wgs84_to_gcj02(24.6123, 118.3012)
    assert abs(submitted[-1]["latitude"] - expected_lat) < 1e-9
    assert abs(submitted[-1]["longitude"] - expected_lng) < 1e-9

    assert attendance.send_radar(Mock(), 42, {
        "latitude": 24.6123, "longitude": 118.3012, "accuracy": 20, "altitude": 0,
        "timestamp": now, "coordType": "gcj02",
    })
    assert submitted[-1]["latitude"] == 24.6123
    assert submitted[-1]["longitude"] == 118.3012


def test_poll_radar_presets_stops_on_first_hit(monkeypatch):
    attempts = []
    monkeypatch.setattr(attendance, "_current_task", lambda *_: {"rollcall_id": 7, "is_radar": True})

    def fake_submit(_s, _id, _ep, payload):
        attempts.append((payload["latitude"], payload["longitude"]))
        return len(attempts) == 2

    monkeypatch.setattr(attendance, "_submit", fake_submit)
    presets = [
        {"name": "1号楼", "latitude": 24.61, "longitude": 118.30, "coordType": "gcj02"},
        {"name": "2号楼", "latitude": 24.62, "longitude": 118.31, "coordType": "gcj02"},
        {"name": "3号楼", "latitude": 24.63, "longitude": 118.32, "coordType": "gcj02"},
    ]
    ok, detail = attendance.poll_radar_presets(Mock(), 7, presets, coord_mode="gcj02", delay_seconds=0)
    assert ok is True
    assert "2号楼" in detail
    assert len(attempts) == 2


def test_resident_executes_radar_poll_command(tmp_path, monkeypatch):
    store = r.Store(tmp_path / "history.sqlite")
    try:
        store.record("9", "信号处理", "radar", "pending")
        agent = r.Resident(store, {})
        agent.enabled.set()
        agent.login = Mock(return_value=Mock())
        monkeypatch.setattr(r, "poll_radar_presets", lambda *_a, **_kw: (True, "命中：2号楼（GCJ02）"))
        payload = json.dumps({
            "taskId": "9",
            "coordMode": "gcj02",
            "presets": [{"name": "2号楼", "latitude": 24.62, "longitude": 118.31, "coordType": "gcj02"}],
        })
        agent.execute({"id": "cmd-1", "expiresAt": r.milliseconds() + 10000, "kind": "radar_poll", "payload": payload})
        ack = store.acknowledgements()[0]
        assert ack["ok"] is True
        assert "2号楼" in ack["result"]
        assert store.get("9")["status"] == "confirmed"
    finally:
        store.db.close()


def test_config_radar_helpers():
    cfg = {
        "radar_auto_poll": True,
        "radar_coord_mode": "both",
        "radar_presets": [
            {"name": "A楼", "latitude": 24.6, "longitude": 118.3},
            {"name": "bad", "latitude": 999, "longitude": 118.3},
        ],
    }
    assert config.get_radar_auto_poll(cfg) is True
    assert config.get_radar_coord_mode(cfg) == "both"
    presets = config.get_radar_presets(cfg)
    assert len(presets) == 1
    assert presets[0]["coordType"] == "gcj02"
