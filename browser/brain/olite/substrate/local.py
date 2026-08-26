"""Local compute: run Python in the same Pyodide interpreter the brain runs in."""

import ast
import contextlib
import copy
import io


class LocalPython:
    def __init__(self, manifest):
        self._manifest = manifest
        self._ns = {}

    def scoped(self, manifest):
        """A view gated by a narrower manifest, sharing the SAME namespace."""
        view = copy.copy(self)
        view._manifest = manifest
        return view

    def run(self, code):
        self._manifest.require("local")
        buffer = io.StringIO()
        result = None
        with contextlib.redirect_stdout(buffer):
            parsed = ast.parse(code)
            if parsed.body and isinstance(parsed.body[-1], ast.Expr):
                last = parsed.body.pop()
                exec(compile(parsed, "<olite>", "exec"), self._ns)
                result = eval(compile(ast.Expression(last.value), "<olite>", "eval"), self._ns)
            else:
                exec(compile(parsed, "<olite>", "exec"), self._ns)
        out = buffer.getvalue()
        parts = []
        if out.strip():
            parts.append(out.rstrip())
        if result is not None:
            parts.append(repr(result))
        return "\n".join(parts) if parts else "(no output)"
