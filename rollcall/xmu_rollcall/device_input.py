"""Read a current device position or an actual classroom QR code."""

import asyncio
import json
import math
import sys
import time
from datetime import timedelta
from urllib.parse import unquote, urlsplit


class InputError(ValueError):
    """Input unavailable or unsuitable for this attendance task."""


_FIELDS = ("courseId", "activityId", "activityType", "data", "rollcallId",
           "groupSetId", "accessCode", "action", "enableGroupRollcall",
           "createUser", "joinCourse")


def parse_qr_text(text):
    """Decode the Tronclass compact format used by the existing QR module."""
    if not isinstance(text, str) or not text.strip() or len(text) > 16384:
        raise InputError("Empty or oversized QR code.")
    text = text.strip()
    if text.startswith(("https://", "http://")):
        try:
            url = urlsplit(text)
        except ValueError as exc:
            raise InputError("Invalid QR URL.") from exc
        if url.hostname not in {"c-mobile.xmu.edu.cn", "lnt.xmu.edu.cn"}:
            raise InputError("This QR code is not from the XMU attendance platform.")
        # unquote preserves literal '+' characters in the signed QR data.
        values = [value for key, sep, value in
                  (item.partition("=") for item in url.query.split("&"))
                  if sep and key == "p"]
        if len(values) != 1:
            raise InputError("QR link must contain one p parameter.")
        try:
            text = unquote(values[0], errors="strict")
        except UnicodeError as exc:
            raise InputError("Invalid QR URL encoding.") from exc
    if text.startswith("{"):
        try:
            result = json.loads(text)
        except (ValueError, RecursionError) as exc:
            raise InputError("Invalid QR JSON.") from exc
        if not isinstance(result, dict):
            raise InputError("Invalid QR payload.")
    else:
        keys = {"0123456789abcdefghijklmnopqrstuvwxyz"[i]: key
                for i, key in enumerate(_FIELDS)}
        result = {}
        for part in filter(None, text.split("!")):
            key, sep, value = part.partition("~")
            key = keys.get(key, key)
            if not sep or key in result:
                raise InputError("Malformed or duplicate QR field.")
            if value.startswith("\x10"):
                try:
                    value = int(value[1:], 36)
                except ValueError as exc:
                    raise InputError("Invalid QR numeric field.") from exc
            elif value == "\x1a1":
                value = True
            elif value == "\x1a0":
                value = False
            else:
                value = value.replace("\x1f", "~").replace("\x1e", "!")
            result[key] = value
    rollcall_id = result.get("rollcallId")
    id_text = str(rollcall_id)
    if (isinstance(rollcall_id, bool) or not id_text.isascii() or not id_text.isdecimal()
            or len(id_text) > 20 or int(id_text) <= 0):
        raise InputError("QR code has no valid rollcall ID.")
    if not isinstance(result.get("data"), str) or not result["data"].strip():
        raise InputError("QR code has no attendance data.")
    if result.get("enableGroupRollcall"):
        raise InputError("Group QR attendance is not supported by this client.")
    return {"rollcallId": int(rollcall_id), "data": result["data"]}


def select_qr_image():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
            path = filedialog.askopenfilename(
                parent=root, title="Select the current classroom QR image",
                filetypes=[("QR images", "*.png *.jpg *.jpeg *.bmp *.webp"),
                           ("All files", "*.*")],
            )
        finally:
            root.destroy()
    except Exception as exc:
        raise InputError("Image picker unavailable; use qr --image <path>.") from exc
    if not path:
        raise InputError("QR image selection cancelled.")
    return path


def read_qr_image(path):
    try:
        from PIL import Image, ImageOps
        import zxingcpp
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            barcodes = zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.QRCode)
        valid = []
        for barcode in barcodes:
            try:
                value = parse_qr_text(barcode.text)
                if value not in valid:
                    valid.append(value)
            except InputError:
                pass
        if len(valid) != 1:
            raise InputError("Image must contain exactly one readable XMU attendance QR code.")
        return valid[0]
    except InputError:
        raise
    except Exception as exc:
        raise InputError("Cannot decode QR image; use a clear, current screenshot.") from exc


def validate_location(location):
    if not isinstance(location, dict):
        raise InputError("No current device location.")
    bounds = {"latitude": (-90, 90), "longitude": (-180, 180),
              "accuracy": (0, 100000), "timestamp": (0, float("inf"))}
    values = {}
    for key, (low, high) in bounds.items():
        value = location.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise InputError(f"Invalid location field: {key}.")
        if not low <= value <= high or (key == "accuracy" and value <= 0):
            raise InputError(f"Location field out of range: {key}.")
        values[key] = float(value)
    if not -5 <= time.time() - values["timestamp"] <= 60:
        raise InputError("Device location is stale; obtain a fresh position.")
    altitude = location.get("altitude", 0)
    if isinstance(altitude, bool) or not isinstance(altitude, (int, float)) or not math.isfinite(altitude):
        raise InputError("Invalid device altitude.")
    values["altitude"] = float(altitude)
    return values


def get_current_location():
    if sys.platform != "win32":
        raise InputError("Automatic device positioning currently requires Windows.")

    async def locate():
        from winrt.windows.devices.geolocation import Geolocator, GeolocationAccessStatus
        access = await Geolocator.request_access_async()
        if access != GeolocationAccessStatus.ALLOWED:
            raise InputError("Location access denied. Enable Windows Location services and desktop app access.")
        locator = Geolocator()
        locator.desired_accuracy_in_meters = 30
        position = await locator.get_geoposition_async_with_age_and_timeout(
            timedelta(0), timedelta(seconds=30))
        coordinate = position.coordinate
        point = coordinate.point.position
        return validate_location({"latitude": point.latitude, "longitude": point.longitude,
                                  "accuracy": coordinate.accuracy,
                                  "altitude": point.altitude,
                                  "timestamp": coordinate.timestamp.timestamp()})

    try:
        from winrt.runtime import init_apartment, uninit_apartment, ApartmentType
        init_apartment(ApartmentType.SINGLE_THREADED)
        try:
            async def bounded():
                return await asyncio.wait_for(locate(), timeout=40)
            return asyncio.run(bounded())
        finally:
            uninit_apartment()
    except InputError:
        raise
    except Exception as exc:
        raise InputError("Cannot obtain current Windows location. Check Location permissions and positioning availability.") from exc
