# SPDX-License-Identifier: Apache-2.0
"""astra - the astraOS SDK command line.

  astra new <dir> [--template app|tabs|list] [--name "My App"] [--package com.example.myapp]
  astra check [dir] [--json]          design language and manifest check
  astra build [dir] [-o out.apkg]     check, then package dist/<package>.apkg
  astra run [dir]                     build, install on the connected phone, start, follow the log
  astra install <app.apkg>            install a package on the phone
  astra logs                          follow the phone's log
  astra screenshot [file.png]         capture the phone's screen
  astra devices                       the connected phone
  astra i18n [dir]                    add new strings to i18n/<language>.json
  astra templates                     list the project templates

The phone is reached over USB with Developer options > USB debugging on
(the same connection as `adu`). Astra Studio runs these commands.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

from . import lint

SDK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(SDK_ROOT, "templates")
VERSION = "0.1.0"


def tool(name):
    """Path of a bundled tool: <sdk>/tools/<name>.py, or the astra repository's tools/."""
    for candidate in (os.path.join(SDK_ROOT, "tools", name + ".py"),
                      os.path.join(SDK_ROOT, "..", "tools", name, name + ".py")):
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    sys.exit(f"astra: {name} is missing from the SDK ({SDK_ROOT})")


def run_tool(name, *args, check=True):
    return subprocess.run([sys.executable, tool(name), *args], check=check).returncode


def read_manifest(app_dir):
    with open(os.path.join(app_dir, "app.json"), encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- new --

def cmd_templates(_args):
    for name in sorted(os.listdir(TEMPLATES)):
        info = os.path.join(TEMPLATES, name, "template.json")
        if os.path.isfile(info):
            with open(info, encoding="utf-8") as f:
                print(f"{name:8} {json.load(f).get('description', '')}")


def cmd_new(args):
    src = os.path.join(TEMPLATES, args.template)
    if not os.path.isdir(src):
        sys.exit(f"astra: no template '{args.template}' (astra templates)")
    dest = os.path.abspath(args.dir)
    if os.path.exists(dest) and os.listdir(dest):
        sys.exit(f"astra: {dest} is not empty")
    name = args.name or os.path.basename(dest).replace("-", " ").replace("_", " ").title()
    slug = re.sub(r"[^a-z0-9]", "", name.lower()) or "app"
    package = args.package or f"com.example.{slug}"
    if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", package):
        sys.exit(f"astra: invalid package name '{package}' (like com.example.myapp)")
    values = {"{{name}}": name, "{{package}}": package, "{{accent}}": args.accent}
    for dirpath, _dirs, files in os.walk(src):
        rel = os.path.relpath(dirpath, src)
        os.makedirs(os.path.join(dest, rel), exist_ok=True)
        for f in files:
            if f == "template.json":
                continue
            with open(os.path.join(dirpath, f), encoding="utf-8") as fh:
                text = fh.read()
            for k, v in values.items():
                text = text.replace(k, v)
            with open(os.path.join(dest, rel, f), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
    print(f"Created {name} ({package}) in {dest}")
    print(f"  astra run {args.dir}     build it and start it on your phone")


# -------------------------------------------------------------- check --

def check(app_dir, as_json=False, system=False):
    problems = lint.check_app(app_dir, system)
    try:
        sys.path.insert(0, os.path.dirname(tool("apkgtool")))
        import apkgtool
        apkgtool.validate_manifest(read_manifest(app_dir), app_dir)
    except SystemExit:
        raise
    except Exception as e:  # ApkgError, or a manifest that cannot be read
        if not any(p.code == "E100" for p in problems):
            problems.insert(0, lint.Problem("app.json", 1, "error", "E100", str(e)))
    if as_json:
        print(json.dumps([p.as_dict() for p in problems], indent=1))
    else:
        for p in problems:
            print(p)
        errors = sum(p.severity == "error" for p in problems)
        print(f"{errors} error(s), {len(problems) - errors} warning(s)")
    return problems


def cmd_check(args):
    problems = check(args.dir, args.json, args.system)
    return 1 if any(p.severity == "error" for p in problems) else 0


# -------------------------------------------------------------- build --

def build(app_dir, out=None):
    problems = check(app_dir)
    if any(p.severity == "error" for p in problems):
        sys.exit("astra: fix the errors above first: astraOS apps follow the system's design language")
    manifest = read_manifest(app_dir)
    out = out or os.path.join(app_dir, "dist", manifest["package"] + ".apkg")
    run_tool("apkgtool", "pack", app_dir, "-o", out)
    return out


def cmd_build(args):
    print(build(args.dir, args.output))


def cmd_run(args):
    out = build(args.dir)
    package = read_manifest(args.dir)["package"]
    run_tool("adu", "install", out)
    run_tool("adu", "start", package)
    return run_tool("adu", "logcat", check=False)


def cmd_install(args):
    return run_tool("adu", "install", args.apkg)


def cmd_logs(_args):
    return run_tool("adu", "logcat", check=False)


def cmd_screenshot(args):
    return run_tool("adu", "screenshot", *( [args.file] if args.file else []))


def cmd_devices(_args):
    return run_tool("adu", "info", check=False)


def cmd_i18n(args):
    return run_tool("i18n", "update", os.path.abspath(args.dir), check=False)


def main(argv=None):
    p = argparse.ArgumentParser(prog="astra", description="astraOS SDK " + VERSION)
    p.add_argument("--version", action="version", version="astra " + VERSION)
    sub = p.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new", help="create a project from a template")
    n.add_argument("dir")
    n.add_argument("--template", default="app")
    n.add_argument("--name")
    n.add_argument("--package")
    n.add_argument("--accent", default="#0A84FF")
    sub.add_parser("templates", help="list the templates")
    for name, helptext in (("check", "check the design language and the manifest"), ("build", "package the app"),
                           ("run", "build, install and start on the phone"), ("i18n", "update translations")):
        c = sub.add_parser(name, help=helptext)
        c.add_argument("dir", nargs="?", default=".")
        if name == "check":
            c.add_argument("--json", action="store_true")
            c.add_argument("--system", action="store_true", help=argparse.SUPPRESS)
        if name == "build":
            c.add_argument("-o", "--output")
    sub.add_parser("install").add_argument("apkg")
    sub.add_parser("logs")
    sub.add_parser("screenshot").add_argument("file", nargs="?")
    sub.add_parser("devices")
    args = p.parse_args(argv)
    handler = globals()["cmd_" + args.cmd]
    return handler(args) or 0


if __name__ == "__main__":
    sys.exit(main())
