"""Attendance submission using fresh location or a scanned classroom code."""

import json
import time
import uuid
from datetime import datetime, timezone

import requests

from .coord import gcj02_to_wgs84, wgs84_to_gcj02
from .device_input import InputError, get_current_location, parse_qr_text, validate_location
from .network import REQUEST_TIMEOUT, is_retryable
from .verify import base_url, _api_headers, log_and_print


def list_rollcalls(session):
    response = session.get(f"{base_url}/api/radar/rollcalls", headers=_api_headers(session),
                           timeout=REQUEST_TIMEOUT, allow_redirects=False)
    response.raise_for_status()
    if response.status_code != 200:
        raise InputError("Session expired or attendance list unavailable; sign in again.")
    try:
        payload = response.json()
    except ValueError as exc:
        raise InputError("Attendance server did not return JSON; sign in again.") from exc
    rows = payload.get("rollcalls") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise InputError("Invalid attendance list response.")
    return rows


def answered(row):
    return row.get("rollcall_status") == "on_call_fine" or row.get("status") == "on_call_fine"


def _current_task(session, rollcall_id, kind):
    row = next((row for row in list_rollcalls(session)
                if str(row.get("rollcall_id")) == str(rollcall_id)), None)
    if row is None:
        raise InputError("This attendance task is no longer in your current task list.")
    if answered(row):
        return row
    if row.get("is_expired") is True or row.get("status") in {"finished", "expired", "closed"}:
        raise InputError("This attendance task has expired.")
    if row.get("end_time"):
        try:
            end = datetime.fromisoformat(row["end_time"])
            if end.tzinfo is None:
                raise ValueError("timezone missing")
        except (ValueError, TypeError) as exc:
            raise InputError("Cannot validate attendance end time.") from exc
        if end <= datetime.now(timezone.utc):
            raise InputError("This attendance task has ended.")
    if kind == "radar" and not row.get("is_radar"):
        raise InputError("Selected attendance task is not radar attendance.")
    if kind == "qr" and (row.get("is_radar") or row.get("is_number")):
        raise InputError("Selected attendance task is not QR attendance.")
    return row


def _submit(session, rollcall_id, endpoint, payload):
    response = session.put(f"{base_url}/api/rollcall/{rollcall_id}/{endpoint}",
                           json=payload, headers=_api_headers(session),
                           timeout=REQUEST_TIMEOUT, allow_redirects=False)
    if response.status_code != 200:
        if response.status_code in {408, 429, 500, 502, 503, 504}:
            response.raise_for_status()
        log_and_print(f"Attendance rejected (HTTP {response.status_code}). Check location, QR freshness, and login.")
        return False
    # A transport success is not enough: check the student's authoritative state.
    try:
        confirmed = any(str(row.get("rollcall_id")) == str(rollcall_id) and answered(row)
                        for row in list_rollcalls(session))
    except (InputError, requests.RequestException):
        log_and_print("Answer sent, but confirmation unavailable. Check the official app before retrying.")
        return False
    if not confirmed:
        log_and_print("Answer sent, but the server has not confirmed attendance. Check the official app.")
    return confirmed


def send_radar(session, rollcall_id, location=None):
    try:
        row = _current_task(session, rollcall_id, "radar")
        if answered(row):
            return True
        from_windows = location is None
        if from_windows:
            log_and_print("Obtaining current Windows device location...")
        raw_position = get_current_location() if from_windows else location
        position = validate_location(raw_position)
        coord_type = (
            "wgs84"
            if from_windows
            else str((raw_position or {}).get("coordType") or "gcj02").lower()
        )
        lat, lng = position["latitude"], position["longitude"]
        if coord_type == "wgs84":
            lat, lng = wgs84_to_gcj02(lat, lng)
        # Re-check the task after the permission/positioning operation.
        row = _current_task(session, rollcall_id, "radar")
        if answered(row):
            return True
        validate_location(position)
        return _submit(session, rollcall_id, "answer", {
            "deviceId": str(uuid.uuid4()), "latitude": lat,
            "longitude": lng, "accuracy": position["accuracy"],
            "altitude": position["altitude"], "altitudeAccuracy": None, "heading": None, "speed": None,
        })
    except InputError as exc:
        log_and_print(str(exc))
        return False
    except requests.RequestException as exc:
        if is_retryable(exc):
            raise
        log_and_print("Radar attendance request failed. Refresh the login session and check the log.")
        return False


def _expand_radar_candidates(presets, coord_mode="gcj02"):
    mode = str(coord_mode or "gcj02").lower()
    if mode not in {"gcj02", "wgs84", "both"}:
        mode = "gcj02"
    target_modes = ("gcj02", "wgs84") if mode == "both" else (mode,)
    candidates = []
    for target in target_modes:
        for item in presets or ():
            if not isinstance(item, dict):
                continue
            lat = item.get("latitude")
            lng = item.get("longitude")
            if isinstance(lat, bool) or isinstance(lng, bool):
                continue
            if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
                continue
            src = str(item.get("coordType") or "gcj02").lower()
            if src == "wgs84" and target == "gcj02":
                out_lat, out_lng = wgs84_to_gcj02(float(lat), float(lng))
            elif src == "gcj02" and target == "wgs84":
                out_lat, out_lng = gcj02_to_wgs84(float(lat), float(lng))
            else:
                out_lat, out_lng = float(lat), float(lng)
            name = str(item.get("name") or f"{out_lat:.5f},{out_lng:.5f}")[:60]
            candidates.append((name, target.upper(), out_lat, out_lng))
    return candidates


def poll_radar_presets(session, rollcall_id, presets, coord_mode="gcj02", delay_seconds=0.6, should_stop=None):
    """Try preset radar coordinates sequentially until confirmed or exhausted."""
    candidates = _expand_radar_candidates(presets, coord_mode=coord_mode)
    if not candidates:
        return False, "没有可用的预设坐标，请先配置教学楼坐标"
    for idx, (name, coord_label, lat, lng) in enumerate(candidates):
        if should_stop and should_stop():
            return False, "轮询已取消"
        try:
            row = _current_task(session, rollcall_id, "radar")
            if answered(row):
                return True, "学校已确认签到"
            location = {
                "latitude": lat,
                "longitude": lng,
                "accuracy": 25.0,
                "altitude": 0.0,
                "timestamp": time.time(),
                "coordType": "gcj02",
            }
            validate_location(location)
            if _submit(session, rollcall_id, "answer", {
                "deviceId": str(uuid.uuid4()), "latitude": lat,
                "longitude": lng, "accuracy": 25.0,
                "altitude": 0.0, "altitudeAccuracy": None, "heading": None, "speed": None,
            }):
                return True, f"命中：{name}（{coord_label}）"
        except InputError as exc:
            return False, str(exc)
        except requests.RequestException as exc:
            if is_retryable(exc):
                raise
            return False, "雷达请求失败，请检查登录状态"
        if idx + 1 < len(candidates) and delay_seconds > 0:
            time.sleep(delay_seconds)
    return False, f"已轮询 {len(candidates)} 个点位均未命中"


def send_qr(session, qr, expected_rollcall_id=None):
    try:
        data = parse_qr_text(json.dumps(qr) if isinstance(qr, dict) else qr)
        rollcall_id = data["rollcallId"]
        if expected_rollcall_id is not None and str(rollcall_id) != str(expected_rollcall_id):
            raise InputError("QR code belongs to a different attendance task.")
        row = _current_task(session, rollcall_id, "qr")
        if answered(row):
            return True
        return _submit(session, rollcall_id, "answer_qr_rollcall", {
            "deviceId": str(uuid.uuid4()), "data": data["data"],
        })
    except InputError as exc:
        log_and_print(str(exc))
        return False
    except requests.RequestException as exc:
        if is_retryable(exc):
            raise
        log_and_print("QR attendance request failed. Refresh the login session and check the current code.")
        return False
