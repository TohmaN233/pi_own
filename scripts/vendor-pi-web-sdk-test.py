#!/usr/bin/env python3
"""Offline tests for source authentication and the SDK patch boundary."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("vendor_sdk", Path(__file__).with_name("vendor-pi-web-sdk.py"))
vendor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vendor)


def archive(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as output:
        for name, content, mode in files:
            entry = tarfile.TarInfo(name)
            entry.mode = mode
            entry.size = len(content)
            output.addfile(entry, io.BytesIO(content))
    return stream.getvalue()


class SecurityPackageTests(unittest.TestCase):
    def setUp(self):
        self.source = json.loads((vendor.VENDOR / "source.json").read_text(encoding="utf-8"))
        self.package = {
            "name": self.source["name"], "version": self.source["version"],
            "bin": {"pi": "dist/bundle/cli.js"},
            "exports": {"./rpc-entry": {"import": "./dist/bundle/rpc-entry.js"}},
            "dependencies": {"undici": "8.9.0"},
        }
        self.lock = {"version": self.source["version"], "lockfileVersion": 3, "packages": {
            "": {"dependencies": {"undici": "8.9.0"}, "bin": {"pi": "dist/bundle/cli.js"}},
            "node_modules/undici": {"version": "8.9.0"},
            "node_modules/brace-expansion": {"version": "5.0.9"},
        }}
        self.original = archive([
            ("package/package.json", json.dumps(self.package).encode(), 0o644),
            ("package/npm-shrinkwrap.json", json.dumps(self.lock).encode(), 0o644),
            ("package/dist/cli.js", b"original CLI runtime", 0o755),
            ("package/dist/rpc-entry.js", b"original RPC runtime", 0o755),
            ("package/dist/index.js", b"original SDK API", 0o644),
            ("package/dist/bundle/cli.js", b"old embedded dependencies", 0o755),
        ])
        self.source["integrity"] = vendor.integrity(self.original)

    def test_rebuild_is_deterministic_and_preserves_runtime_and_modes(self):
        data, manifest = vendor.build_archive(self.original, self.source)
        again, again_manifest = vendor.build_archive(self.original, self.source)
        self.assertEqual(data, again)
        self.assertEqual(manifest, again_manifest)
        entries = vendor.read_archive(data)
        self.assertNotIn("package/dist/bundle/cli.js", entries)
        self.assertEqual(entries["package/dist/cli.js"][1], b"original CLI runtime")
        self.assertEqual(entries["package/dist/cli.js"][0].mode, 0o755)
        self.assertEqual(manifest["registrySigned"], False)
        vendor.verify_archive(data, manifest, self.source)

    def test_rejects_unauthenticated_upstream(self):
        with self.assertRaisesRegex(ValueError, "Upstream SDK integrity mismatch"):
            vendor.build_archive(self.original + b"changed", self.source)

    def test_rejects_runtime_edits_even_with_refreshed_artifact_hash(self):
        data, manifest = vendor.build_archive(self.original, self.source)
        entries = vendor.read_archive(data)
        replacement = b"changed SDK API"
        files = [(name, replacement if name == "package/dist/index.js" else body, entry.mode)
                 for name, (entry, body) in entries.items()]
        changed = archive(files)
        manifest["integrity"] = vendor.integrity(changed)
        manifest["files"]["package/dist/index.js"]["sha256"] = hashlib.sha256(replacement).hexdigest()
        with self.assertRaisesRegex(ValueError, "Upstream runtime bytes changed"):
            vendor.verify_archive(changed, manifest, self.source)

    def test_rejects_stale_embedded_bin_metadata(self):
        data, manifest = vendor.build_archive(self.original, self.source)
        entries = vendor.read_archive(data)
        lock = json.loads(entries["package/npm-shrinkwrap.json"][1])
        lock["packages"][""]["bin"]["pi"] = "dist/bundle/cli.js"
        replacement = json.dumps(lock).encode()
        changed = archive([(name, replacement if name == "package/npm-shrinkwrap.json" else body, entry.mode)
                           for name, (entry, body) in entries.items()])
        manifest["integrity"] = vendor.integrity(changed)
        manifest["files"]["package/npm-shrinkwrap.json"]["sha256"] = hashlib.sha256(replacement).hexdigest()
        with self.assertRaisesRegex(ValueError, "Entrypoints must use"):
            vendor.verify_archive(changed, manifest, self.source)

    def test_rejects_path_escape_and_duplicate_entries(self):
        for names in (("../escape",), ("package/index.js", "package/index.js")):
            with self.assertRaises(ValueError):
                vendor.read_archive(archive([(name, b"", 0o644) for name in names]))


if __name__ == "__main__":
    unittest.main()
