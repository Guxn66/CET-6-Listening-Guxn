"""Attendance submission using fresh location or a scanned classroom code."""

import json
import uuid
from datetime import datetime, timezone

import requests

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
        log_and_print("Obtaining current Windows device location...")
        position = validate_location(get_current_location() if location is None else location)
        # Re-check the task after the permission/positioning operation.
        row = _current_task(session, rollcall_id, "radar")
        if answered(row):
            return True
        validate_location(position)
        return _submit(session, rollcall_id, "answer", {
            "deviceId": str(uuid.uuid4()), "latitude": position["latitude"],
            "longitude": position["longitude"], "accuracy": position["accuracy"],
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
