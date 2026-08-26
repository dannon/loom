"""Token bucket rate limiter for API request throttling."""

import asyncio
import time
from typing import Optional


class TokenBucketRateLimiter:
    """Token bucket rate limiter for controlling request rates."""

    def __init__(self, rate: float, capacity: int):
        """Initialize the rate limiter."""
        self.rate = rate
        self.capacity = capacity
        self.tokens = float(capacity)
        self.last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, timeout: Optional[float] = None) -> bool:
        """Wait until a token is available, then consume it."""
        start_time = time.monotonic()

        async with self._lock:
            self._refill()

            while self.tokens < 1:
                if timeout is not None:
                    elapsed = time.monotonic() - start_time
                    remaining = timeout - elapsed
                    if remaining <= 0:
                        return False

                # Calculate wait time for next token
                wait_time = (1 - self.tokens) / self.rate

                if timeout is not None:
                    wait_time = min(wait_time, remaining)

                await asyncio.sleep(wait_time)
                self._refill()

            self.tokens -= 1
            return True

    def _refill(self) -> None:
        """Refill tokens based on elapsed time since last refill."""
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        self.last_refill = now

    @property
    def available_tokens(self) -> float:
        """Return the current number of available tokens (approximate)."""
        return self.tokens

    @classmethod
    def from_requests_per_minute(cls, requests_per_minute: int) -> "TokenBucketRateLimiter":
        """Create a rate limiter from a requests-per-minute limit."""
        rate = requests_per_minute / 60.0
        return cls(rate=rate, capacity=requests_per_minute)
