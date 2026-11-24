import json
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote
from unittest.mock import Mock, patch

import requests

from xmu_rollcall import attendance, device_input, rollcall_handler
from xmu_rollcall.cli import cli
from click.testing import CliRunner


def response(data, status=200):
    result = requests.Response()
    result.status_code = status
    result.json = Mock(return_value=data)
    return result


def task(**changes):
    result = {"rollcall_id": 42, "is_radar": False, "is_number": False,
              "is_expired": False, "rollcall_status": "absent", "status": "absent",
              "course_title": "Course", "created_by_name": "Teacher",
              "department_name": "Department", "scored": False}
    result.update(changes)
    return result


def session_for(*rows):
    session = Mock()
    session.headers = {}
    session.get.side_effect = [response({"rollcalls": row}) for row in rows]
    session.put.return_value = response({})
    return session


class AttendanceTests(unittest.TestCase):
    def test_qr_url_decoding_preserves_signature_and_control_escapes(self):
        compact = "4~\x1016!3~token+中文\x1fpart\x1eend"
        url = "https://c-mobile.xmu.edu.cn/j?p=" + quote(compact, safe="+")
        self.assertEqual(device_input.parse_qr_text(url),
                         {"rollcallId": 42, "data": "token+中文~part!end"})
        self.assertEqual(device_input.parse_qr_text(json.dumps({"rollcallId": 42, "data": "abc"})),
                         {"rollcallId": 42, "data": "abc"})

    def test_invalid_input_never_reaches_network(self):
        for text in ("", "hello", "4~42!3~", "4~42!4~43!3~abc",
                     '{"rollcallId":true,"data":"abc"}',
                     "https://example.org/j?p=4~42!3~abc", "4~42!3~abc!8~\x1a1",
                     "https://[", "4~\u00b2!3~abc", "4~" + "9" * 5000 + "!3~abc"):
            with self.subTest(text=text), patch.object(attendance, "log_and_print"):
                session = Mock()
                self.assertFalse(attendance.send_qr(session, text))
                session.get.assert_not_called()
                session.put.assert_not_called()

    def test_qr_wrong_task_and_expired_task_never_submit(self):
        for rows in ([task(is_expired=True)], [], [task(is_radar=True)], [task(is_number=True)]):
            session = session_for(rows)
            self.assertFalse(attendance.send_qr(session, "4~42!3~token"))
            session.put.assert_not_called()
        session = Mock()
        self.assertFalse(attendance.send_qr(session, "4~42!3~token", expected_rollcall_id=43))
        session.get.assert_not_called()

    def test_success_requires_authoritative_student_state(self):
        for confirmed in (False, True):
            session = session_for([task()], [task(rollcall_status="on_call_fine" if confirmed else "absent")])
            self.assertEqual(attendance.send_qr(session, "4~42!3~token"), confirmed)
            self.assertEqual(session.put.call_args.kwargs["json"]["data"], "token")
            self.assertFalse(session.put.call_args.kwargs["allow_redirects"])

    def test_radar_uses_fresh_measured_accuracy_and_rechecks_task(self):
        position = {"latitude": 24.5, "longitude": 118.1, "accuracy": 89.5, "timestamp": time.time()}
        session = session_for([task(is_radar=True)], [task(is_radar=True)],
                              [task(is_radar=True, rollcall_status="on_call_fine")])
        with patch.object(attendance, "get_current_location", return_value=position):
            self.assertTrue(attendance.send_radar(session, 42))
        self.assertEqual(session.put.call_count, 1)
        payload = session.put.call_args.kwargs["json"]
        self.assertEqual(payload["accuracy"], 89.5)
        self.assertEqual(payload["latitude"], position["latitude"])
        session = session_for([task(is_radar=True)], [task(is_radar=True, is_expired=True)])
        with patch.object(attendance, "get_current_location", return_value=position):
            self.assertFalse(attendance.send_radar(session, 42))
        session.put.assert_not_called()

    def test_permission_failure_stale_location_and_redirect_do_not_crash(self):
        session = session_for([task(is_radar=True)])
        with patch.object(attendance, "get_current_location", side_effect=device_input.InputError("denied")):
            self.assertFalse(attendance.send_radar(session, 42))
        session.put.assert_not_called()
        for position in ({"latitude": 24, "longitude": 118, "accuracy": 10, "timestamp": time.time()-61},
                         {"latitude": float("nan"), "longitude": 118, "accuracy": 10, "timestamp": time.time()}):
            with self.assertRaises(device_input.InputError):
                device_input.validate_location(position)
        session = session_for([task()])
        session.put.return_value = response({}, status=302)
        self.assertFalse(attendance.send_qr(session, "4~42!3~token"))

    def test_timeout_does_not_blindly_resubmit(self):
        session = session_for([task()])
        session.put.side_effect = requests.Timeout("unknown outcome")
        with self.assertRaises(requests.Timeout):
            attendance.send_qr(session, "4~42!3~token")
        self.assertEqual(session.put.call_count, 1)

    def test_qr_monitor_never_opens_picker_and_keeps_other_rollcalls_running(self):
        with patch.object(rollcall_handler, "select_qr_image", side_effect=device_input.InputError("cancelled")) as picker, patch.object(
            rollcall_handler, "send_radar", return_value=True
        ) as radar, patch.dict(rollcall_handler._qr_prompt_times, {}, clear=True), patch.object(
            rollcall_handler.time, "sleep"
        ) as sleep:
            data = {"rollcalls": [task(), task(rollcall_id=43, is_radar=True)]}
            rollcall_handler.handle_rollcalls(data, Mock())
            rollcall_handler.handle_rollcalls(data, Mock())
            self.assertEqual(picker.call_count, 0)
            self.assertEqual(radar.call_count, 2)
            sleep.assert_not_called()

    def test_menu_cancellation_returns_to_commands(self):
        with patch("xmu_rollcall.cli.setup_logging"), patch("xmu_rollcall.cli.load_config", return_value={}), patch(
            "xmu_rollcall.cli.select_qr_image", side_effect=device_input.InputError("cancelled")
        ):
            result = CliRunner().invoke(cli, input="5\nimage\n")
            self.assertEqual(result.exit_code, 0, result.output)
            self.assertIn("cancelled", result.output)
            self.assertGreater(result.output.count("QR attendance"), 1)

    def test_windows_projection_exposes_used_members(self):
        import sys
        if sys.platform != "win32":
            self.skipTest("Windows-only positioning")
        from winrt.windows.devices.geolocation import Geolocator, GeolocationAccessStatus
        self.assertTrue(callable(Geolocator.request_access_async))
        self.assertTrue(callable(Geolocator.get_geoposition_async_with_age_and_timeout))
        self.assertEqual(GeolocationAccessStatus.ALLOWED, 1)

    def test_qr_image_uses_real_decoder_and_inspect_never_logs_in(self):
        import zxingcpp
        from PIL import Image
        barcode = zxingcpp.create_barcode("4~42!3~synthetic-token", zxingcpp.BarcodeFormat.QRCode)
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "qr.png"
            pixels = memoryview(zxingcpp.write_barcode_to_image(barcode, scale=6))
            Image.frombytes("L", (pixels.shape[1], pixels.shape[0]), pixels.tobytes()).save(image)
            self.assertEqual(device_input.read_qr_image(image)["rollcallId"], 42)
            with patch("xmu_rollcall.cli._submission_session") as login:
                result = CliRunner().invoke(cli, ["qr", "--image", str(image), "--inspect"])
                self.assertEqual(result.exit_code, 0, result.output)
                login.assert_not_called()
