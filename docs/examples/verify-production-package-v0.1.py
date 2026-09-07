"""Recompute the v0.1 production-package fingerprints without third-party deps."""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path


MANIFEST_NAME = "source-manifest.md"
EPISODE_PATH = re.compile(r"^episodes/(\d{3})\.md$")
EXPECTED = {
    "package_fingerprint": "sha256:8030bce57ee4c8c90bfe3f806dbabe953de937ed46ee61583adddd933d668d3a",
    "validation_fingerprint": "sha256:d30484ae63ed4f05a05d8f43edd5e725cfab57c41e6e977948bffbb036c19b1b",
    "source_version_canonical_hash": "sha256:1d2f0bc17032163649f4aa3d78ed890dc34dbe3f25ea9cdfd49d76db53ef767c",
}
DECLARED_FINGERPRINT = re.compile(
    rb"^package_fingerprint:\s*[\"']?(sha256:[0-9a-f]{64})[\"']?\s*$",
    re.MULTILINE,
)


def normalize_file(path: Path) -> bytes:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError(f"UTF-8 BOM is not allowed: {path}")
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"file is not valid UTF-8: {path}") from exc
    normalized = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return normalized.rstrip(b"\n") + b"\n"


def fingerprint(rows: list[tuple[str, str]]) -> str:
    payload = b"".join(
        path.encode("utf-8") + b"\0" + digest.encode("ascii") + b"\n"
        for path, digest in rows
    )
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def episode_content(normalized_file_bytes: bytes, path: str) -> bytes:
    """Extract and normalize the Content section without trimming content bytes."""
    heading = re.search(rb"(?m)^## Content\n", normalized_file_bytes)
    if not heading:
        raise ValueError(f"missing ## Content heading: {path}")
    body = normalized_file_bytes[heading.end():]
    if body.startswith(b"\n"):
        body = body[1:]  # exactly one Markdown heading/body separator
    next_heading = re.search(rb"(?m)^## [^\n]*\n", body)
    if next_heading:
        body = body[:next_heading.start()]
        if body.endswith(b"\n"):
            body = body[:-1]  # exactly one separator before the next section
    return body.rstrip(b"\n") + b"\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--package-root",
        type=Path,
        default=Path(__file__).parent / "production-package-v0.1",
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root = args.package_root.resolve()
    if not root.is_dir():
        print(f"package root does not exist: {root}", file=sys.stderr)
        return 2

    rows: list[tuple[str, str]] = []
    sizes: dict[str, int] = {}
    episode_contents: list[tuple[int, bytes]] = []
    try:
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            relative = path.relative_to(root).as_posix()
            normalized = normalize_file(path)
            digest = hashlib.sha256(normalized).hexdigest()
            rows.append((relative, digest))
            sizes[relative] = len(normalized)
            episode_match = EPISODE_PATH.match(relative)
            if episode_match:
                episode_contents.append(
                    (int(episode_match.group(1)), episode_content(normalized, relative))
                )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    package_rows = [(path, digest) for path, digest in rows if path != MANIFEST_NAME]
    package_fp = fingerprint(package_rows)
    validation_fp = fingerprint(rows)
    if not episode_contents:
        print("no episode files found", file=sys.stderr)
        return 1
    episode_contents.sort(key=lambda item: item[0])
    canonical = b"".join(
        content + (b"\n" if index < len(episode_contents) - 1 else b"")
        for index, (_, content) in enumerate(episode_contents)
    )
    canonical_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()
    canonical_hash_hex = canonical_hash.removeprefix("sha256:")
    manifest = (root / MANIFEST_NAME).read_bytes()
    match = DECLARED_FINGERPRINT.search(manifest)
    declared = match.group(1).decode("ascii") if match else "<missing or invalid>"

    print(f"package_fingerprint: {package_fp}")
    print(f"validation_fingerprint: {validation_fp}")
    print(f"source_version_canonical_hash: {canonical_hash}")
    print(f"source_version_canonical_hash_hex: {canonical_hash_hex}")
    print(f"manifest_declared_package_fingerprint: {declared}")
    for path, digest in rows:
        print(f"{path}\t{digest}\t{sizes[path]} bytes")

    if args.check and declared != package_fp:
        print("ERROR: manifest package_fingerprint does not match", file=sys.stderr)
        return 1
    default_root = (Path(__file__).parent / "production-package-v0.1").resolve()
    if args.check and root == default_root:
        actual = {
            "package_fingerprint": package_fp,
            "validation_fingerprint": validation_fp,
            "source_version_canonical_hash": canonical_hash,
        }
        for name, expected in EXPECTED.items():
            if actual[name] != expected:
                print(f"ERROR: golden fixture {name} does not match", file=sys.stderr)
                return 1
    if args.check:
        print("OK: package fingerprints and canonical hash are reproducible")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
