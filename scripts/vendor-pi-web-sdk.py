#!/usr/bin/env python3
"""Repackage the pinned SDK; verify every retained upstream file without extraction.

--check is offline. Default rebuilds from the SRI-verified upstream archive.
Only dependency metadata and CLI/RPC export paths change. Old bundled runtime
files are removed because they embed vulnerable dependencies independently of
the installed npm tree. The upstream unbundled entrypoints remain intact.
"""

import argparse
import base64
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import posixpath
import tarfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "third_party" / "pi-web-sdk"
METADATA_FILES = {"package/package.json", "package/npm-shrinkwrap.json"}


def integrity(data):
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def read_archive(data):
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for entry in archive:
            path = PurePosixPath(entry.name)
            if not entry.isfile() or path.is_absolute() or ".." in path.parts:
                raise ValueError(f"Unsupported archive entry: {entry.name}")
            if not entry.name.startswith("package/") or entry.name in entries:
                raise ValueError(f"Invalid or duplicate archive entry: {entry.name}")
            entries[entry.name] = (entry, archive.extractfile(entry).read())
    return entries


def patched_metadata(entries, source):
    package = json.loads(entries["package/package.json"][1])
    lock = json.loads(entries["package/npm-shrinkwrap.json"][1])
    if package["name"] != source["name"] or package["version"] != source["version"]:
        raise ValueError("Upstream package identity changed")
    if lock["lockfileVersion"] != 3 or lock["version"] != source["version"]:
        raise ValueError("Upstream shrinkwrap identity changed")
    if package["bin"]["pi"] != "dist/bundle/cli.js":
        raise ValueError("Upstream CLI entrypoint changed")
    if package["exports"]["./rpc-entry"]["import"] != "./dist/bundle/rpc-entry.js":
        raise ValueError("Upstream RPC entrypoint changed")
    package["bin"]["pi"] = "dist/cli.js"
    lock["packages"][""]["bin"]["pi"] = "dist/cli.js"
    package["exports"]["./rpc-entry"]["import"] = "./dist/rpc-entry.js"
    for dependency, patch in source["dependencyPatches"].items():
        entry = lock["packages"][f"node_modules/{dependency}"]
        if entry["version"] != patch["from"]:
            raise ValueError(f"Unexpected upstream version for {dependency}")
        for field in ("version", "resolved", "integrity"):
            entry[field] = patch[field]
        if dependency in package["dependencies"]:
            if package["dependencies"][dependency] != patch["from"]:
                raise ValueError(f"Unexpected upstream direct pin for {dependency}")
            package["dependencies"][dependency] = patch["version"]
            lock["packages"][""]["dependencies"][dependency] = patch["version"]
    return {
        "package/package.json": (json.dumps(package, indent="\t") + "\n").encode(),
        "package/npm-shrinkwrap.json": (json.dumps(lock, indent="\t") + "\n").encode(),
    }


def build_archive(upstream, source):
    if integrity(upstream) != source["integrity"]:
        raise ValueError("Upstream SDK integrity mismatch")
    entries = read_archive(upstream)
    metadata = patched_metadata(entries, source)
    license_text = (VENDOR / "LICENSE").read_bytes()
    if hashlib.sha256(license_text).hexdigest() != source["licenseSha256"]:
        raise ValueError("Upstream license identity changed")
    if "package/LICENSE" in entries:
        raise ValueError("Upstream now includes LICENSE; review the packaging patch")
    license_header = tarfile.TarInfo("package/LICENSE")
    license_header.mode = 0o644
    entries["package/LICENSE"] = (license_header, license_text)
    records = {}
    removed = []
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(entries):
                entry, original = entries[name]
                if name.startswith("package/dist/bundle/"):
                    removed.append(name)
                    continue
                data = metadata.get(name, original)
                header = copy.copy(entry)
                header.pax_headers = {}
                header.mtime = 0
                header.uid = header.gid = 0
                header.uname = header.gname = ""
                header.size = len(data)
                archive.addfile(header, io.BytesIO(data))
                records[name] = {
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "mode": entry.mode,
                    "upstreamSha256": None if name == "package/LICENSE" else hashlib.sha256(original).hexdigest(),
                }
    if not removed:
        raise ValueError("Expected upstream bundle was absent")
    result = output.getvalue()
    manifest = {
        "source": source,
        "integrity": integrity(result),
        "registrySigned": False,
        "changedFiles": sorted(METADATA_FILES),
        "addedFiles": ["package/LICENSE"],
        "removedBundledFiles": removed,
        "files": records,
    }
    verify_archive(result, manifest, source)
    return result, manifest


def verify_archive(data, manifest, source):
    if manifest["source"] != source or integrity(data) != manifest["integrity"]:
        raise ValueError("Vendored SDK integrity/source mismatch")
    entries = read_archive(data)
    if set(entries) != set(manifest["files"]):
        raise ValueError("Vendored SDK file closure changed")
    if manifest["changedFiles"] != sorted(METADATA_FILES) or manifest["registrySigned"] is not False:
        raise ValueError("Vendored SDK patch/provenance declaration changed")
    if manifest["addedFiles"] != ["package/LICENSE"]:
        raise ValueError("Vendored SDK addition scope changed")
    if not manifest["removedBundledFiles"] or any(
        not name.startswith("package/dist/bundle/") for name in manifest["removedBundledFiles"]
    ):
        raise ValueError("Vendored SDK removal scope changed")
    for name, (entry, content) in entries.items():
        record = manifest["files"][name]
        actual = hashlib.sha256(content).hexdigest()
        if actual != record["sha256"] or entry.mode != record["mode"]:
            raise ValueError(f"Vendored SDK file identity changed: {name}")
        if name == "package/LICENSE":
            if actual != source["licenseSha256"] or record["upstreamSha256"] is not None:
                raise ValueError("Vendored SDK license identity changed")
        elif name not in METADATA_FILES and actual != record["upstreamSha256"]:
            raise ValueError(f"Upstream runtime bytes changed: {name}")
        if name.startswith("package/dist/bundle/"):
            raise ValueError(f"Vulnerable upstream bundle remains: {name}")
    for path in ("package/dist/cli.js", "package/dist/rpc-entry.js"):
        if not entries[path][0].mode & 0o111:
            raise ValueError(f"Entrypoint is not executable: {path}")
    package = json.loads(entries["package/package.json"][1])
    lock = json.loads(entries["package/npm-shrinkwrap.json"][1])
    if package["name"] != source["name"] or package["version"] != source["version"]:
        raise ValueError("Vendored SDK identity changed")
    if package["bin"]["pi"] != "dist/cli.js" or lock["packages"][""]["bin"]["pi"] != "dist/cli.js" or package["exports"]["./rpc-entry"]["import"] != "./dist/rpc-entry.js":
        raise ValueError("Entrypoints must use the upstream unbundled runtime")
    for dependency, patch in source["dependencyPatches"].items():
        entry = lock["packages"][f"node_modules/{dependency}"]
        for field in ("version", "resolved", "integrity"):
            if entry[field] != patch[field]:
                raise ValueError(f"Vendored SDK dependency identity changed: {dependency}.{field}")
        if dependency in package["dependencies"] and (
            package["dependencies"][dependency] != patch["version"]
            or lock["packages"][""]["dependencies"][dependency] != patch["version"]
        ):
            raise ValueError(f"Vendored SDK direct dependency changed: {dependency}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="Verify committed artifact offline")
    action.add_argument("--refresh-lock", action="store_true", help="Refresh the SDK's exact nested graph and artifact integrity in Pi Web's lock")
    args = parser.parse_args()
    source = json.loads((VENDOR / "source.json").read_text(encoding="utf-8"))
    artifact = VENDOR / f"pi-coding-agent-{source['version']}-security.tgz"
    manifest_path = VENDOR / "manifest.json"
    if args.refresh_lock:
        data = artifact.read_bytes()
        verify_archive(data, json.loads(manifest_path.read_text(encoding="utf-8")), source)
        entries = read_archive(data)
        package = json.loads(entries["package/package.json"][1])
        sdk_lock = json.loads(entries["package/npm-shrinkwrap.json"][1])
        path = ROOT / "apps/pi-web/package-lock.json"
        outer = json.loads(path.read_text(encoding="utf-8"))
        sdk_path = "node_modules/@earendil-works/pi-coding-agent"
        if outer["packages"][sdk_path]["version"] != source["version"]:
            raise ValueError("Review an SDK API version migration before refreshing its lock")
        specifier = f"file:../../third_party/pi-web-sdk/{artifact.name}"
        app = json.loads((ROOT / "apps/pi-web/package.json").read_text(encoding="utf-8"))
        if app["dependencies"][source["name"]] != specifier:
            raise ValueError("Pi Web SDK source declaration changed")
        outer["packages"][""]["dependencies"][source["name"]] = specifier
        current = outer["packages"][sdk_path]
        current.update({"resolved": specifier, "integrity": integrity(data), "hasShrinkwrap": True,
                        "dependencies": package["dependencies"], "bin": package["bin"]})
        for key in list(outer["packages"]):
            if key.startswith(sdk_path + "/"):
                del outer["packages"][key]
        for key, entry in sdk_lock["packages"].items():
            if key:
                outer["packages"][sdk_path + "/" + key] = entry
        outer["packages"] = dict(sorted(outer["packages"].items()))
        path.write_text(json.dumps(outer, indent=2) + "\n", encoding="utf-8", newline="\n")
    elif args.check:
        data = artifact.read_bytes()
        verify_archive(data, json.loads(manifest_path.read_text(encoding="utf-8")), source)
        outer = json.loads((ROOT / "apps/pi-web/package-lock.json").read_text(encoding="utf-8"))["packages"]
        sdk_path = "node_modules/@earendil-works/pi-coding-agent"
        specifier = f"file:../../third_party/pi-web-sdk/{artifact.name}"
        app = json.loads((ROOT / "apps/pi-web/package.json").read_text(encoding="utf-8"))
        if app["dependencies"][source["name"]] != specifier or outer[""]["dependencies"][source["name"]] != specifier:
            raise ValueError("Pi Web SDK source declaration changed")
        for field, expected in {"version": source["version"], "resolved": specifier, "integrity": integrity(data)}.items():
            if outer[sdk_path].get(field) != expected:
                raise ValueError(f"Pi Web SDK archive identity changed: {field}")
        if outer[sdk_path].get("hasShrinkwrap") is not True:
            raise ValueError("Pi Web lock must retain the SDK shrinkwrap boundary")
        entries = read_archive(data)
        package = json.loads(entries["package/package.json"][1])
        if outer[sdk_path].get("dependencies") != package["dependencies"] or outer[sdk_path].get("bin") != package["bin"]:
            raise ValueError("Pi Web SDK dependency or entrypoint metadata changed")
        sdk_lock = json.loads(entries["package/npm-shrinkwrap.json"][1])
        for path, expected in sdk_lock["packages"].items():
            if not path:
                continue
            parent, separator, name = path.rpartition("node_modules/")
            if not separator:
                raise ValueError(f"Invalid SDK dependency path: {path}")
            current = posixpath.join(sdk_path, parent).rstrip("/")
            while True:
                actual = outer.get(posixpath.join(current, "node_modules", name))
                if actual is not None:
                    break
                if not current:
                    raise ValueError(f"SDK dependency missing from Pi Web lock: {path}")
                current = posixpath.dirname(current)
            for field in ("version", "resolved", "integrity"):
                if field in expected and actual.get(field) != expected[field]:
                    raise ValueError(f"SDK dependency drift in Pi Web lock: {path}.{field}")
    else:
        with urlopen(source["url"], timeout=60) as response:
            upstream = response.read()
        data, manifest = build_archive(upstream, source)
        artifact.write_bytes(data)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Verified SDK {source['version']} security package: {artifact.name}")


if __name__ == "__main__":
    main()
