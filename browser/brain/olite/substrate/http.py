import asyncio
import json
import logging
from datetime import datetime, timezone

from olite.exceptions import HttpError

logger = logging.getLogger(__name__)

# Retry configuration
RETRY_STATUS_CODES = {429, 500, 502, 503, 504}
MAX_RETRIES = 3
INITIAL_BACKOFF = 1.0  # seconds
# A rate limiter states how long to wait; guessing shorter guarantees the retry fails.
MAX_RETRY_AFTER = 60.0
RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo"


def retry_after(headers, body):
    """The delay the server asked for, or None; sources ordered by how standard they are."""
    for source in (_retry_after_header, _retry_after_ms_header, _google_retry_info):
        stated = source(headers if source is not _google_retry_info else body)
        if stated is not None:
            return max(0.0, min(stated, MAX_RETRY_AFTER))
    return None


def _header(headers, name):
    """Case-insensitive lookup; header casing is not guaranteed by anyone."""
    if not headers:
        return None
    try:
        for key, value in headers.items():
            if key and key.lower() == name and value:
                return value
    except AttributeError:
        return None
    return None


def _retry_after_header(headers):
    """RFC 9110 `Retry-After`: delta-seconds or an HTTP-date. Both are in the wild."""
    raw = _header(headers, "retry-after")
    if raw is None:
        return None
    raw = str(raw).strip()
    try:
        return float(raw)
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        when = parsedate_to_datetime(raw)
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return (when - datetime.now(timezone.utc)).total_seconds()
    except Exception:
        return None


def _retry_after_ms_header(headers):
    """OpenAI sends `retry-after-ms` alongside, and sometimes instead of, the seconds form."""
    raw = _header(headers, "retry-after-ms")
    if raw is None:
        return None
    try:
        return float(str(raw).strip()) / 1000.0
    except ValueError:
        return None


def _google_retry_info(body):
    """Google states the delay in a typed RetryInfo detail and sends no header at all."""
    payload = body
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return None
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    if not isinstance(payload, dict):
        return None
    for detail in (payload.get("error") or {}).get("details") or []:
        if isinstance(detail, dict) and detail.get("@type") == RETRY_INFO_TYPE:
            delay = str(detail.get("retryDelay") or "")
            if delay.endswith("s"):
                try:
                    return float(delay[:-1])
                except ValueError:
                    return None
    return None


class HttpClient:
    async def request(self, method, url, headers=None, body=None, signal=None, on_retry=None):
        raise NotImplementedError


def _report(on_retry, status, wait, attempt):
    """Tell the caller we are waiting, so a slow turn does not look like a hang."""
    if on_retry is None:
        return
    try:
        on_retry({"status": status, "wait": wait, "attempt": attempt, "of": MAX_RETRIES})
    except Exception:
        logger.debug("retry listener raised", exc_info=True)


def is_pyodide():
    try:
        import pyodide_js  # noqa: F401

        return True
    except ImportError:
        return False


# parse response without relying on content type
async def parse_response(response):
    text = await response.text()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


# ----------------------------


def _js_headers(response):
    """A dict-like view of fetch's Headers, or None when it cannot be read."""
    try:
        return {
            "retry-after": response.headers.get("Retry-After"),
            "retry-after-ms": response.headers.get("retry-after-ms"),
        }
    except Exception:
        return None


class BrowserHttpClient(HttpClient):
    def __init__(self):
        from js import fetch
        from pyodide.ffi import to_js

        self._fetch = fetch
        self._to_js = to_js

    async def request(self, method, url, headers=None, body=None, signal=None, on_retry=None):
        headers = headers or {}
        options = {
            "method": method.upper(),
            "headers": headers,
            "cache": "no-store",
        }
        if body is not None:
            options["body"] = json.dumps(body)
            headers.setdefault("Content-Type", "application/json")
        # Handed to fetch so Stop drops the request in flight.
        if signal is not None:
            options["signal"] = signal

        last_error = None
        for attempt in range(MAX_RETRIES):
            response = await self._fetch(url, self._to_js(options))
            if response.ok:
                return await parse_response(response)

            status = response.status
            text = await response.text()

            if status not in RETRY_STATUS_CODES:
                # Don't retry client errors (except 429)
                raise HttpError(
                    f"HTTP {status}: {text}",
                    status_code=status,
                    details={"url": url, "method": method},
                )

            last_error = HttpError(
                f"HTTP {status}: {text}",
                status_code=status,
                details={"url": url, "method": method},
            )

            if attempt < MAX_RETRIES - 1:
                stated = retry_after(_js_headers(response), text)
                backoff = stated if stated is not None else INITIAL_BACKOFF * (2**attempt)
                logger.warning(f"HTTP {status}, retrying in {backoff}s " f"(attempt {attempt + 1}/{MAX_RETRIES})")
                _report(on_retry, status, backoff, attempt + 1)
                await asyncio.sleep(backoff)

        raise last_error


# ----------------------------


class ServerHttpClient(HttpClient):
    def __init__(self):
        import aiohttp

        self._aiohttp = aiohttp

    async def request(self, method, url, headers=None, body=None, signal=None, on_retry=None):
        # A browser AbortSignal has no meaning here; the loop's own checks still apply.
        del signal
        data = None
        if body is not None:
            data = json.dumps(body)
            headers = headers or {}
            headers.setdefault("Content-Type", "application/json")

        last_error = None
        last_headers = None
        for attempt in range(MAX_RETRIES):
            async with self._aiohttp.ClientSession() as session:
                async with session.request(
                    method=method.upper(),
                    url=url,
                    headers=headers,
                    data=data,
                ) as response:
                    if response.status < 400:
                        return await parse_response(response)

                    status = response.status
                    text = await response.text()
                    last_headers = dict(response.headers)

                    if status not in RETRY_STATUS_CODES:
                        # Don't retry client errors (except 429)
                        raise HttpError(
                            f"HTTP {status}: {text}",
                            status_code=status,
                            details={"url": url, "method": method},
                        )

                    last_error = HttpError(
                        f"HTTP {status}: {text}",
                        status_code=status,
                        details={"url": url, "method": method},
                    )

            if attempt < MAX_RETRIES - 1:
                stated = retry_after(last_headers, text)
                backoff = stated if stated is not None else INITIAL_BACKOFF * (2**attempt)
                logger.warning(f"HTTP {status}, retrying in {backoff}s " f"(attempt {attempt + 1}/{MAX_RETRIES})")
                _report(on_retry, status, backoff, attempt + 1)
                await asyncio.sleep(backoff)

        raise last_error


# ----------------------------

http: HttpClient
if is_pyodide():
    http = BrowserHttpClient()
else:
    http = ServerHttpClient()


__all__ = ["http", "HttpClient"]
