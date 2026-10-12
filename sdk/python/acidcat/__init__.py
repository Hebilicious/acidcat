"""Write an AcidCat catalog in Python, and render it to the JSON document the toolchain checks.

This is an authoring library, not a runtime: a program uses it to produce `acidcat.catalog.json`, and nothing reads
the catalog through it at runtime. See spec/catalog.md.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, Sequence

__all__ = ["Catalog", "CatalogError", "Schema"]

Schema = dict[str, Any]
"""A JSON Schema 2020-12 schema, written as a plain dict."""

_ID = re.compile(r"[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+")
_NAME = re.compile(r"[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?")
_TYPE_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
_REFERENCE = re.compile(r"#/\$defs/([A-Za-z][A-Za-z0-9_]*)")


class CatalogError(ValueError):
    """A catalog breaks a rule of the specification."""


class Catalog:
    def __init__(self, title: str | None = None, description: str | None = None) -> None:
        self._title = title
        self._description = description
        self._targets: dict[str, dict[str, Any]] = {}
        self._types: dict[str, Schema] = {}
        self._capabilities: dict[str, dict[str, Any]] = {}

    def target(
        self,
        name: str,
        bindings: Sequence[str],
        description: str | None = None,
        options: Mapping[str, Any] | None = None,
    ) -> Catalog:
        """Declare a target, served by `bindings` such as "typescript" and "webmcp"."""
        if name in self._targets:
            raise CatalogError(f"The target {name} is declared twice")
        self._targets[name] = {"bindings": list(bindings), "description": description, "options": options}
        return self

    def type(self, name: str, schema: Schema) -> Schema:
        """Declare a shared type, and get the schema that references it."""
        if name in self._types:
            raise CatalogError(f"The type {name} is declared twice")
        self._types[name] = schema
        return {"$ref": f"#/$defs/{name}"}

    def capability(
        self,
        id: str,
        description: str,
        audience: Sequence[str] = (),
        input: Schema | None = None,
        output: Schema | None = None,
        failures: Mapping[str, Schema] | None = None,
        read_only: bool | None = None,
        state: Schema | None = None,
    ) -> Catalog:
        """Declare a capability. A capability with no audience reaches no target."""
        if id in self._capabilities:
            raise CatalogError(f"The capability {id} is declared twice")
        self._capabilities[id] = {
            "description": description,
            "audience": list(audience),
            "input": input,
            "output": output,
            "failures": dict(failures) if failures else None,
            "readOnly": read_only,
            "state": state,
        }
        return self

    def validate(self) -> list[str]:
        """The catalog rules this catalog breaks. Empty when it conforms."""
        problems: list[str] = []
        for name, target in self._targets.items():
            bindings = target["bindings"]
            if not _NAME.fullmatch(name):
                problems.append(f"the target name {name} is malformed")
            if not bindings:
                problems.append(f"the target {name} has no bindings")
            if len(set(bindings)) != len(bindings):
                problems.append(f"the target {name} repeats a binding")
            problems += [f"the target {name} names the malformed binding {b}" for b in bindings if not _NAME.fullmatch(b)]
        for name, schema in self._types.items():
            if not _TYPE_NAME.fullmatch(name):
                problems.append(f"the type name {name} is malformed")
            problems += [f"the type {name} {problem}" for problem in self._reference_problems(schema)]
        for id, capability in self._capabilities.items():
            audience = capability["audience"]
            if len(id) > 128 or not _ID.fullmatch(id):
                problems.append(f"the id {id} is malformed")
            if not capability["description"].strip():
                problems.append(f"{id} has no description")
            if len(set(audience)) != len(audience):
                problems.append(f"{id} repeats a target in its audience")
            problems += [f"{id} names the undeclared target {t}" for t in audience if t not in self._targets]
            if capability["input"] is not None and self._resolve(capability["input"]).get("type") != "object":
                problems.append(f"{id} input does not describe an object")
            schemas = [capability["input"], capability["output"], capability["state"], *(capability["failures"] or {}).values()]
            for schema in schemas:
                if schema is not None:
                    problems += [f"{id} {problem}" for problem in self._reference_problems(schema)]
        return problems

    def to_json(self) -> dict[str, Any]:
        """The catalog as a JSON value. Raises CatalogError when the catalog breaks a rule."""
        problems = self.validate()
        if problems:
            raise CatalogError("The catalog does not conform:\n" + "\n".join(problems))
        return _compact(
            {
                "acidcat": "0.1",
                "title": self._title,
                "description": self._description,
                "targets": {name: _compact(target) for name, target in self._targets.items()},
                "$defs": dict(self._types) or None,
                "capabilities": {id: _compact(capability) for id, capability in self._capabilities.items()},
            }
        )

    def render(self) -> str:
        """The catalog as JSON text, ready to write to `acidcat.catalog.json`."""
        return json.dumps(self.to_json(), indent=2, ensure_ascii=False) + "\n"

    def _resolve(self, schema: Schema) -> Schema:
        match = _REFERENCE.fullmatch(str(schema.get("$ref", "")))
        return self._types.get(match.group(1), schema) if match else schema

    def _reference_problems(self, schema: Any) -> list[str]:
        problems: list[str] = []
        for node in _objects(schema):
            if "$defs" in node:
                problems.append("carries its own $defs; declare shared types with type()")
            if "$ref" in node:
                match = _REFERENCE.fullmatch(str(node["$ref"]))
                if not match or match.group(1) not in self._types:
                    problems.append(f"references {node['$ref']}, which is not a type")
        return problems


def _compact(value: dict[str, Any]) -> dict[str, Any]:
    return {key: member for key, member in value.items() if member is not None}


def _objects(value: Any):
    if isinstance(value, list):
        for item in value:
            yield from _objects(item)
    elif isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _objects(item)
