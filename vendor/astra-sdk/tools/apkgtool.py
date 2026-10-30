#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""apkgtool - create, inspect and extract astraOS application packages (.apkg).

The format is documented in docs/APKG.md. This tool and the on-device
reader (frameworks/libastra/src/apkg.cpp) must stay in sync.

Usage:
  apkgtool.py pack <app dir> -o <out.apkg>
  apkgtool.py info <file.apkg>
  apkgtool.py list <file.apkg>
  apkgtool.py verify <file.apkg>
  apkgtool.py unpack <file.apkg> -d <dir>
"""
import argparse
import hashlib
import json
import os
import re
import struct
import sys
import zlib

MAGIC = b"ASTRAPKG"
TRAILER_MAGIC = b"APKGEND\0"
FORMAT_VERSION = 1
HEADER = struct.Struct("<8sHHIIIIIIIQQQ")  # 64 bytes
ENTRY = struct.Struct("<HBBIQQQ32s")  # followed by the UTF-8 path
TRAILER = struct.Struct("<32s8s")

COMPRESSION_STORE = 0
COMPRESSION_ZLIB = 1
TYPE_FILE = 0

PACKAGE_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
WIDGET_SIZES = ("small", "wide")                         # lock screen
HOME_WIDGET_SIZES = ("small", "medium", "large", "bar")   # home screen
EXCLUDED_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db"}
EXCLUDED_DIRS = {"build", "dist"}  # build output (`astra build` writes dist/<package>.apkg)
EXCLUDED_SUFFIXES = (".qmlc", ".jsc", ".pyc", "~")

assert HEADER.size == 64


class ApkgError(Exception):
    pass


# ---------------------------------------------------------------- manifest --

def validate_manifest(manifest, root):
    def need(key, kind):
        if key not in manifest:
            raise ApkgError(f"app.json: missing '{key}'")
        if not isinstance(manifest[key], kind):
            raise ApkgError(f"app.json: '{key}' has the wrong type")
        return manifest[key]

    packed = None

    def need_file(path, what):
        nonlocal packed
        if not os.path.isfile(os.path.join(root, path)):
            raise ApkgError(f"app.json: {what} points to missing file {path}")
        if packed is None:
            packed = {rel for rel, _ in collect_files(root)}
        if os.path.normpath(path).replace(os.sep, "/") not in packed:
            raise ApkgError(f"app.json: {what} points to {path}, which is not packaged "
                            f"(hidden files, {' and '.join(d + '/' for d in sorted(EXCLUDED_DIRS))} are left out)")

    package = need("package", str)
    if not PACKAGE_RE.match(package):
        raise ApkgError(f"app.json: invalid package name '{package}'")
    need("name", str)
    need("version", str)
    if need("versionCode", int) < 1:
        raise ApkgError("app.json: versionCode must be >= 1")
    for key in ("main", "icon"):
        need_file(need(key, str), f"'{key}'")
    perms = manifest.get("permissions", [])
    if not isinstance(perms, list) or not all(isinstance(p, str) for p in perms):
        raise ApkgError("app.json: 'permissions' must be a list of strings")
    seen = set()
    for widget in manifest.get("widgets", []):
        for key in ("id", "name", "qml"):
            if not isinstance(widget.get(key), str):
                raise ApkgError(f"app.json: widget is missing '{key}'")
        # A widget is for the lock screen ("size") and/or the home screen ("home": [sizes]).
        home = widget.get("home")
        if "size" not in widget and not home:
            raise ApkgError(f"app.json: widget '{widget['id']}' needs 'size' (lock screen) or 'home' (home screen)")
        if home is not None and (not isinstance(home, list) or not all(h in HOME_WIDGET_SIZES for h in home)):
            raise ApkgError(f"app.json: widget 'home' sizes must be among {HOME_WIDGET_SIZES}")
        if widget["id"] in seen:
            raise ApkgError(f"app.json: duplicate widget id '{widget['id']}'")
        seen.add(widget["id"])
        if "size" in widget and widget["size"] not in WIDGET_SIZES:
            raise ApkgError(f"app.json: widget size must be one of {WIDGET_SIZES}")
        need_file(widget["qml"], f"widget '{widget['id']}'")
    return manifest


# -------------------------------------------------------------------- pack --

def collect_files(root):
    """The (path in the package, path on disk) of every file pack puts in the package.
    `astra check` lints exactly these, so the two must not walk the tree separately."""
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in EXCLUDED_NAMES | EXCLUDED_DIRS)
        for name in sorted(filenames):
            if name.startswith(".") or name in EXCLUDED_NAMES or name.endswith(EXCLUDED_SUFFIXES):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            files.append((rel, full))
    files.sort()
    return files


def pack(app_dir, out_path):
    manifest_path = os.path.join(app_dir, "app.json")
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise ApkgError(f"cannot read {manifest_path}: {e}")
    validate_manifest(manifest, app_dir)
    manifest_bytes = json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode("utf-8")

    index = bytearray()
    data = bytearray()
    files = collect_files(app_dir)
    for rel, full in files:
        with open(full, "rb") as f:
            raw = f.read()
        packed = zlib.compress(raw, 9)
        if len(packed) < len(raw):
            compression, stored = COMPRESSION_ZLIB, packed
        else:
            compression, stored = COMPRESSION_STORE, raw
        path = rel.encode("utf-8")
        mode = 0o755 if os.access(full, os.X_OK) and not rel.endswith((".qml", ".svg", ".png", ".json", ".js")) else 0o644
        index += ENTRY.pack(len(path), compression, TYPE_FILE, mode, len(data), len(stored), len(raw),
                            hashlib.sha256(raw).digest())
        index += path
        data += stored

    manifest_offset = HEADER.size
    index_offset = manifest_offset + len(manifest_bytes)
    data_offset = index_offset + len(index)
    header = HEADER.pack(MAGIC, FORMAT_VERSION, 0, HEADER.size, manifest_offset, len(manifest_bytes),
                         index_offset, len(index), len(files), 0, data_offset, len(data), 0)
    body = header + manifest_bytes + bytes(index) + bytes(data)
    blob = body + TRAILER.pack(hashlib.sha256(body).digest(), TRAILER_MAGIC)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(blob)
    return manifest, len(files), len(blob)


# -------------------------------------------------------------------- read --

class Package:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.blob = f.read()
        if len(self.blob) < HEADER.size + TRAILER.size:
            raise ApkgError("file too small")
        (magic, version, self.flags, header_size, m_off, m_size, i_off, i_size, count, _r,
         d_off, d_size, _r2) = HEADER.unpack_from(self.blob, 0)
        if magic != MAGIC:
            raise ApkgError("not an astraOS package (bad magic)")
        if version != FORMAT_VERSION:
            raise ApkgError(f"unsupported format version {version}")
        end = len(self.blob) - TRAILER.size
        for off, size in ((m_off, m_size), (i_off, i_size), (d_off, d_size)):
            if off + size > end:
                raise ApkgError("section out of bounds")
        self.manifest = json.loads(self.blob[m_off:m_off + m_size].decode("utf-8"))
        self.data_offset = d_off
        self.data_size = d_size
        self.entries = []
        pos = i_off
        for _ in range(count):
            plen, comp, etype, mode, off, stored, size, digest = ENTRY.unpack_from(self.blob, pos)
            pos += ENTRY.size
            name = self.blob[pos:pos + plen].decode("utf-8")
            pos += plen
            if name.startswith("/") or ".." in name.split("/"):
                raise ApkgError(f"unsafe path in package: {name}")
            if off + stored > d_size:
                raise ApkgError(f"entry {name} out of bounds")
            self.entries.append(dict(path=name, compression=comp, type=etype, mode=mode, offset=off,
                                     stored=stored, size=size, sha256=digest))
        if pos > i_off + i_size:
            raise ApkgError("index overflows its section")

    def verify(self):
        digest, trailer_magic = TRAILER.unpack_from(self.blob, len(self.blob) - TRAILER.size)
        if trailer_magic != TRAILER_MAGIC:
            raise ApkgError("bad trailer")
        if hashlib.sha256(self.blob[:-TRAILER.size]).digest() != digest:
            raise ApkgError("package checksum mismatch")
        for e in self.entries:
            if hashlib.sha256(self.read(e)).digest() != e["sha256"]:
                raise ApkgError(f"checksum mismatch for {e['path']}")

    def read(self, entry):
        start = self.data_offset + entry["offset"]
        raw = self.blob[start:start + entry["stored"]]
        if entry["compression"] == COMPRESSION_ZLIB:
            raw = zlib.decompress(raw)
        elif entry["compression"] != COMPRESSION_STORE:
            raise ApkgError(f"unknown compression {entry['compression']}")
        if len(raw) != entry["size"]:
            raise ApkgError(f"size mismatch for {entry['path']}")
        return raw

    def unpack(self, dest):
        for e in self.entries:
            target = os.path.join(dest, *e["path"].split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(self.read(e))
            try:
                os.chmod(target, e["mode"])
            except OSError:
                pass


# --------------------------------------------------------------------- cli --

def main(argv=None):
    parser = argparse.ArgumentParser(prog="apkgtool", description="astraOS package tool")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pack", help="build a package from an app directory")
    p.add_argument("app_dir")
    p.add_argument("-o", "--output", required=True)
    for name in ("info", "list", "verify"):
        sub.add_parser(name).add_argument("package")
    u = sub.add_parser("unpack", help="extract a package")
    u.add_argument("package")
    u.add_argument("-d", "--dest", required=True)
    args = parser.parse_args(argv)

    try:
        if args.cmd == "pack":
            manifest, count, size = pack(args.app_dir, args.output)
            print(f"{manifest['package']} {manifest['version']}: {count} files, {size} bytes -> {args.output}")
            return 0
        pkg = Package(args.package)
        if args.cmd == "info":
            print(json.dumps(pkg.manifest, indent=2, sort_keys=True))
        elif args.cmd == "list":
            for e in pkg.entries:
                print(f"{e['mode']:o} {e['size']:>9} {'z' if e['compression'] else '-'} {e['path']}")
        elif args.cmd == "verify":
            pkg.verify()
            print(f"{pkg.manifest['package']}: OK ({len(pkg.entries)} files)")
        elif args.cmd == "unpack":
            pkg.verify()
            pkg.unpack(args.dest)
        return 0
    except ApkgError as e:
        print(f"apkgtool: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
