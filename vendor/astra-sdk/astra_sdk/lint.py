# SPDX-License-Identifier: Apache-2.0
"""astra check: the astraOS design language, enforced.

Every app on astraOS looks and behaves like the rest of the system: it is
built from Astra.Controls, takes colours, type and spacing from Theme, and
does not ship its own widget toolkit, fonts or web wrapper. These rules are
checked by `astra check`, `astra build` refuses to package an app with
errors, and Market refuses to publish one. See docs/DESIGN.md.

Errors (E) block packaging; warnings (W) do not. Only the apps built into
the system image (check_app(system=True), `astra check --system`) may use the
web engine, their own colours and fonts: every app made with the SDK or
published on Market is checked as a third-party app, whatever its package.
"""
import json
import os
import re

QML_SUFFIXES = (".qml", ".js", ".mjs")

ALLOWED_IMPORTS = {
    "QtQuick", "QtQml", "QtQml.Models", "QtQuick.Layouts", "QtQuick.Shapes",
    "QtQuick.Effects", "QtMultimedia", "QtPositioning", "QtSensors",
    "Astra.Core", "Astra.Controls", "Astra.Animation",
}
SYSTEM_ONLY_IMPORTS = {"QtWebEngine", "QtWebView", "QtWebChannel"}
FORBIDDEN_IMPORTS = {
    "QtQuick.Controls": "use Astra.Controls (Button, Switch, TextField, Slider, Sheet...)",
    "QtQuick.Dialogs": "use Sheet or Dialogs.show()",
    "QtQuick.Templates": "use Astra.Controls",
    "QtQuick.Window": "apps get their window from the system",
    "Qt5Compat.GraphicalEffects": "use QtQuick.Effects (MultiEffect)",
}
FORBIDDEN_TYPES = {
    "ApplicationWindow": "the root is a Page, a PageStack or an Item: the system owns the window",
    "Window": "the root is a Page, a PageStack or an Item: the system owns the window",
    "FontLoader": "apps use the system font (Theme.fontFamily)",
    "WebEngineView": "third-party apps are native: build the UI with Astra.Controls",
    "WebView": "third-party apps are native: build the UI with Astra.Controls",
}

COLOR_LITERAL = re.compile(r'''["'](#[0-9a-fA-F]{3,8})["']|Qt\.(rgba|hsla|hsva|lighter|darker|tint)\s*\(''')
COLOR_PROP = re.compile(r'''\b(color|[a-z][A-Za-z]*Color|border\.color|gradient)\s*:''')
FONT_FAMILY = re.compile(r'''font\.family\s*:\s*(.+)''')
PIXEL_SIZE = re.compile(r'''font\.pixelSize\s*:\s*(\d+(\.\d+)?)\s*($|;|})''')
TEXT_LITERAL = re.compile(r'''^\s*(text|title|message|placeholder|subtitle)\s*:\s*"([^"]*[A-Za-z][^"]*)"''')
IMPORT = re.compile(r'''^\s*import\s+([A-Za-z][\w.]*)''')
TYPE_USE = re.compile(r'''^\s*([A-Z]\w*)\s*\{''')


class Problem:
    def __init__(self, path, line, severity, code, message):
        self.path, self.line, self.severity, self.code, self.message = path, line, severity, code, message

    def as_dict(self):
        return {"file": self.path, "line": self.line, "severity": self.severity,
                "code": self.code, "message": self.message}

    def __str__(self):
        kind = "error" if self.severity == "error" else "warning"
        return f"{self.path}:{self.line}: {kind} {self.code}: {self.message}"


def _manifest(app_dir, problems):
    path = os.path.join(app_dir, "app.json")
    try:
        with open(path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError) as e:
        problems.append(Problem("app.json", 1, "error", "E100", f"cannot read the manifest: {e}"))
        return None
    accent = manifest.get("accent")
    if accent is not None and not re.fullmatch(r"#[0-9a-fA-F]{6}", str(accent)):
        problems.append(Problem("app.json", 1, "error", "E101", "'accent' must be a colour like #FF375F"))
    return manifest


def _all_files(app_dir):
    for dirpath, _dirnames, filenames in os.walk(app_dir):
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            yield os.path.relpath(full, app_dir).replace(os.sep, "/"), full


def check_app(app_dir, system=False, files=None):
    """Returns the list of Problems of the app in app_dir.

    files: the (relative path, full path) pairs to check, which `astra check`
    takes from apkgtool.collect_files so that every file that gets packaged is
    checked. Without it every file under app_dir is."""
    problems = []
    manifest = _manifest(app_dir, problems)
    system_app = system
    accent = (manifest or {}).get("accent", "").lower()

    for rel, full in (_all_files(app_dir) if files is None else files):
        if not rel.endswith(QML_SUFFIXES):
            continue
        try:
            with open(full, encoding="utf-8") as f:
                lines = f.read().split("\n")
        except (OSError, UnicodeDecodeError) as e:
            problems.append(Problem(rel, 1, "error", "E001", f"cannot read: {e}"))
            continue
        in_comment = False
        for n, raw in enumerate(lines, 1):
            line = raw
            if in_comment:
                if "*/" not in line:
                    continue
                line, in_comment = line.split("*/", 1)[1], False
            if "/*" in line and "*/" not in line.split("/*", 1)[1]:
                line, in_comment = line.split("/*", 1)[0], True
            code = line.split("//", 1)[0] if "//" in line and "://" not in line else line

            m = IMPORT.match(code)
            if m:
                module = m.group(1)
                if module in FORBIDDEN_IMPORTS:
                    problems.append(Problem(rel, n, "error", "E010", f"import {module}: {FORBIDDEN_IMPORTS[module]}"))
                elif module in SYSTEM_ONLY_IMPORTS:
                    if not system_app:
                        problems.append(Problem(rel, n, "error", "E011",
                                                f"import {module}: apps are native, not web pages in a frame"))
                elif module not in ALLOWED_IMPORTS and not code.strip().startswith('import "'):
                    problems.append(Problem(rel, n, "error", "E012",
                                            f"import {module}: not part of the astraOS SDK"))
                continue

            m = TYPE_USE.match(code)
            if m and m.group(1) in FORBIDDEN_TYPES and not (system_app and m.group(1) in ("WebEngineView", "WebView")):
                problems.append(Problem(rel, n, "error", "E020", f"{m.group(1)}: {FORBIDDEN_TYPES[m.group(1)]}"))

            m = FONT_FAMILY.search(code)
            if m and "Theme.fontFamily" not in m.group(1) and not system_app:
                problems.append(Problem(rel, n, "error", "E030", "font.family: use Theme.fontFamily"))

            if not system_app and COLOR_PROP.search(code):
                for c in COLOR_LITERAL.finditer(code):
                    literal = (c.group(1) or "").lower()
                    if literal and literal == accent:
                        continue
                    problems.append(Problem(rel, n, "error", "E040",
                                            "colour literal: use Theme colours (Theme.text, Theme.accent...) "
                                            "or the app's 'accent' from app.json (Application.accent)"))
                    break

            if PIXEL_SIZE.search(code):
                problems.append(Problem(rel, n, "warning", "W050",
                                        "font.pixelSize: use Theme sizes (Theme.bodySize, Theme.titleSize...)"))

            if TEXT_LITERAL.match(code):
                problems.append(Problem(rel, n, "warning", "W060",
                                        "text without qsTr(): it cannot be translated"))
    return problems
