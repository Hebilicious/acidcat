"""The canonical form of a catalog (spec/catalog.md#canonical-form).

The one way to write a catalog as text, so that every tool and every SDK produces the same bytes for the same catalog.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal
from typing import Any, Callable

_CATALOG_ORDER = ["acidcat", "title", "description", "targets", "$defs", "capabilities"]
_TARGET_ORDER = ["bindings", "description", "options"]
_CAPABILITY_ORDER = ["description", "audience", "input", "output", "failures", "readOnly", "state"]


def canonical_text(catalog: dict[str, Any]) -> str:
    """A catalog in canonical form, as text."""
    return _write(_catalog(catalog), "") + "\n"


def _catalog(catalog: dict[str, Any]) -> dict[str, Any]:
    def member(key: str, value: Any) -> Any:
        if key == "targets":
            return _by_key(value, lambda target: _ordered(target, _TARGET_ORDER, lambda _, inner: _sorted(inner)))
        if key == "$defs":
            return _by_key(value, _sorted)
        if key == "capabilities":
            return _by_key(value, lambda capability: _ordered(capability, _CAPABILITY_ORDER, _capability_member))
        return _sorted(value)

    return _ordered(catalog, _CATALOG_ORDER, member)


def _capability_member(key: str, value: Any) -> Any:
    return _by_key(value, _sorted) if key == "failures" else _sorted(value)


def _ordered(value: dict[str, Any], order: list[str], each: Callable[[str, Any], Any]) -> dict[str, Any]:
    known = [key for key in order if key in value]
    others = sorted(key for key in value if key not in order)
    return {key: each(key, value[key]) for key in known + others}


def _by_key(value: dict[str, Any], each: Callable[[Any], Any]) -> dict[str, Any]:
    return {key: each(value[key]) for key in sorted(value)}


def _sorted(value: Any) -> Any:
    if isinstance(value, list):
        return [_sorted(item) for item in value]
    if isinstance(value, dict):
        return _by_key(value, _sorted)
    return value


def _write(value: Any, indent: str) -> str:
    inner = indent + "  "
    if isinstance(value, dict):
        if not value:
            return "{}"
        members = [f"{inner}{_string(key)}: {_write(item, inner)}" for key, item in value.items()]
        return "{\n" + ",\n".join(members) + "\n" + indent + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        return "[\n" + ",\n".join(inner + _write(item, inner) for item in value) + "\n" + indent + "]"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    raise TypeError(f"A catalog holds only JSON values, not {type(value).__name__}")


def _string(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def _number(value: float) -> str:
    """Write a number the way ECMAScript's Number::toString does, from its shortest round-trip digits."""
    if not math.isfinite(value):
        raise ValueError("A catalog holds only finite numbers")
    if value == 0:
        return "0"
    sign, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    digits = "".join(map(str, digit_tuple)).rstrip("0")
    exponent += len(digit_tuple) - len(digits)
    return ("-" if value < 0 else "") + _layout(digits, exponent + len(digits))


def _layout(digits: str, n: int) -> str:
    """Lay out `0.<digits> × 10^n` as ECMAScript does."""
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * -n + digits
    e = n - 1
    mantissa = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{mantissa}e{'+' if e > 0 else '-'}{abs(e)}"
