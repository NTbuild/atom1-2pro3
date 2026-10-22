#!/usr/bin/env python3
"""Serve an NT Site Mirror locally with fail-closed routing.

SPA fallback is OFF by default. Enable it only with ``--spa`` or with a
schema-1.3 ``serve-contract.json`` that explicitly sets ``spa_fallback`` to
true and names a safe ``safe_spa_entry``. ``--no-spa`` remains available as a
safe override for older launch commands.

For schema-1.3 mirrors, ``mirror-manifest.json.route_map`` maps an exact
origin-form request target (``/path?query``; query order is significant) to a
record containing ``local_path`` and optional ``content_type``. The map is the
authority for query variants and extensionless resources. Unknown variants of
a mapped path return 404 instead of falling through to a query-insensitive
filesystem lookup or SPA fallback.

Legacy ``downloaded[].path`` / ``content_type`` records remain supported for
safe content-type replay. All filesystem paths are constrained to the web
root, directory listings are disabled, missing data requests 404 honestly,
responses are ``Cache-Control: no-store``, and valid single byte ranges receive
206 responses.

Usage:
    python serve.py [directory] [--port 8000] [--spa | --no-spa]
                    [--contract serve-contract.json]

Requires: Python 3 standard library only.
"""

import argparse
import json
import os
import re
import stat
from dataclasses import dataclass, field
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import PurePosixPath
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import unquote_to_bytes, urlsplit


SINGLE_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
DEFAULT_MANIFEST = "mirror-manifest.json"
DEFAULT_CONTRACT = "serve-contract.json"


class ConfigurationError(ValueError):
    """Raised when a local manifest or serve contract is unsafe or invalid."""


@dataclass(frozen=True)
class RouteEntry:
    request_target: str
    local_path: Optional[str]
    content_type: Optional[str] = None


@dataclass
class ManifestData:
    path: Optional[str] = None
    schema_version: str = ""
    content_types: Dict[str, str] = field(default_factory=dict)
    route_map: Dict[str, RouteEntry] = field(default_factory=dict)
    mapped_request_paths: Set[str] = field(default_factory=set)
    warnings: List[str] = field(default_factory=list)


def schema_version_tuple(value) -> Tuple[int, int]:
    match = re.match(r"^\s*(\d+)(?:\.(\d+))?", str(value or ""))
    if not match:
        return (0, 0)
    return (int(match.group(1)), int(match.group(2) or 0))


def safe_local_path(directory: str, relative_path: str) -> Optional[str]:
    """Resolve a manifest path inside *directory*, rejecting traversal.

    Manifest paths are portable POSIX-relative paths. Absolute paths,
    backslashes, dot segments, empty segments, drive-qualified paths, NULs,
    and symlink escapes are rejected.
    """
    if not isinstance(relative_path, str) or not relative_path:
        return None
    if "\x00" in relative_path or "\\" in relative_path:
        return None
    if relative_path.startswith("/") or os.path.splitdrive(relative_path)[0]:
        return None
    raw_parts = relative_path.split("/")
    if any(part in ("", ".", "..") for part in raw_parts):
        return None
    pure = PurePosixPath(relative_path)
    if pure.is_absolute() or any(part in (".", "..") for part in pure.parts):
        return None

    root = os.path.realpath(directory)
    candidate = os.path.realpath(os.path.join(root, *pure.parts))
    try:
        if os.path.commonpath((root, candidate)) != root:
            return None
    except ValueError:
        return None
    return candidate


def canonical_request_target(raw_target: str, allow_absolute_url: bool = False) -> Optional[str]:
    """Return an exact origin-form path+query target, without sorting query.

    Full HTTP(S) URLs are accepted only for manifest source records. Incoming
    client requests must use origin form, which prevents proxy-style authority
    confusion.
    """
    if not isinstance(raw_target, str) or not raw_target:
        return None
    try:
        parsed = urlsplit(raw_target)
    except ValueError:
        return None
    if parsed.scheme or parsed.netloc:
        if not allow_absolute_url or parsed.scheme not in ("http", "https") or not parsed.netloc:
            return None
    path = parsed.path or "/"
    if not path.startswith("/") or "\\" in path or "\x00" in path:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in path + parsed.query):
        return None
    return path + (("?" + parsed.query) if parsed.query else "")


def request_path_from_target(request_target: str) -> str:
    return request_target.split("?", 1)[0]


def safe_content_type(value) -> Optional[str]:
    """Return a header-safe captured Content-Type, or None."""
    if not isinstance(value, str) or not value or len(value) > 512:
        return None
    if any(ord(char) < 32 or ord(char) > 126 for char in value):
        return None
    return value


def _read_json_object(path: str, label: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except OSError as exc:
        raise ConfigurationError(f"cannot read {label} {path}: {exc}") from exc
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ConfigurationError(f"invalid JSON in {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ConfigurationError(f"{label} must contain a JSON object: {path}")
    return value


def resolve_contract_path(directory: str, explicit_path: Optional[str]) -> Optional[str]:
    if explicit_path:
        candidate = os.path.abspath(explicit_path)
        if not os.path.isfile(candidate) and not os.path.isabs(explicit_path):
            candidate = os.path.abspath(os.path.join(directory, explicit_path))
        if not os.path.isfile(candidate):
            raise ConfigurationError(f"serve contract not found: {explicit_path}")
        return candidate
    candidate = os.path.join(directory, DEFAULT_CONTRACT)
    return candidate if os.path.isfile(candidate) else None


def load_serve_contract(directory: str, explicit_path: Optional[str] = None):
    path = resolve_contract_path(directory, explicit_path)
    if path is None:
        return None, {}, []

    contract = _read_json_object(path, "serve contract")
    warnings = []
    if schema_version_tuple(contract.get("schema_version")) < (1, 3):
        raise ConfigurationError("serve contract schema_version must be 1.3 or newer")

    for field_name in ("spa_fallback", "range_requests"):
        if field_name in contract and not isinstance(contract[field_name], bool):
            raise ConfigurationError(f"serve contract {field_name} must be boolean")
    if "port" in contract and (not isinstance(contract["port"], int) or isinstance(contract["port"], bool)
                               or not 0 <= contract["port"] <= 65535):
        raise ConfigurationError("serve contract port must be an integer from 0 through 65535")
    bind = contract.get("bind")
    if bind is not None and bind != "127.0.0.1":
        raise ConfigurationError("serve contract bind must be 127.0.0.1")
    if "cache_control" in contract and contract["cache_control"] != "no-store":
        warnings.append("contract cache_control ignored; server enforces no-store")
    if contract.get("range_requests") is False:
        warnings.append("contract range_requests=false ignored; server preserves single-range support")

    entry = contract.get("safe_spa_entry")
    if entry is not None and not isinstance(entry, str):
        raise ConfigurationError("serve contract safe_spa_entry must be a relative path or null")
    if contract.get("spa_fallback") is True:
        if not entry:
            raise ConfigurationError("spa_fallback=true requires safe_spa_entry")
        resolved = safe_local_path(directory, entry)
        if resolved is None or not os.path.isfile(resolved):
            raise ConfigurationError("serve contract safe_spa_entry must name a file inside the web root")

    manifest_ref = contract.get("manifest")
    if manifest_ref is not None and not isinstance(manifest_ref, str):
        raise ConfigurationError("serve contract manifest must be a relative path")
    if manifest_ref and safe_local_path(directory, manifest_ref) is None:
        raise ConfigurationError("serve contract manifest escapes the web root")
    route_map_ref = contract.get("route_map")
    if route_map_ref is not None:
        expected_ref = "%s#route_map" % (manifest_ref or DEFAULT_MANIFEST)
        if route_map_ref != expected_ref:
            raise ConfigurationError(
                "serve contract route_map must reference %s" % expected_ref
            )

    return path, contract, warnings


def _route_records(raw_route_map):
    """Yield (request-target, record) pairs from the canonical object shape.

    A small list/string compatibility surface is retained so pre-release v1.3
    manifests fail safely rather than becoming unreadable. The canonical shape
    remains: ``{"/path?query": {"local_path": "..."}}``.
    """
    if isinstance(raw_route_map, dict):
        for request_target, value in raw_route_map.items():
            if isinstance(value, str):
                value = {"local_path": value}
            yield request_target, value
        return
    if isinstance(raw_route_map, list):
        for value in raw_route_map:
            if not isinstance(value, dict):
                yield None, value
                continue
            request_target = value.get("request_target") or value.get("route")
            yield request_target, value
        return
    yield None, raw_route_map


def load_manifest(directory: str, manifest_path: Optional[str] = None) -> ManifestData:
    path = manifest_path or os.path.join(directory, DEFAULT_MANIFEST)
    if not os.path.isfile(path):
        if manifest_path:
            raise ConfigurationError(f"manifest not found: {manifest_path}")
        return ManifestData()

    manifest = _read_json_object(path, "mirror manifest")
    result = ManifestData(path=path, schema_version=str(manifest.get("schema_version") or ""))

    # Safe legacy compatibility: replay captured types only for paths confined to
    # the served root. Missing files simply have no effect.
    downloaded = manifest.get("downloaded", [])
    if isinstance(downloaded, list):
        for index, entry in enumerate(downloaded):
            if not isinstance(entry, dict):
                result.warnings.append(f"downloaded[{index}] ignored: expected object")
                continue
            local_path = entry.get("path")
            raw_content_type = entry.get("content_type")
            if not local_path or not raw_content_type:
                continue
            resolved = safe_local_path(directory, local_path)
            if resolved is None:
                result.warnings.append(f"downloaded[{index}] ignored: unsafe path")
                continue
            content_type = safe_content_type(raw_content_type)
            if content_type is None:
                result.warnings.append(f"downloaded[{index}] content_type ignored: unsafe value")
                continue
            result.content_types[resolved] = content_type
    elif downloaded is not None:
        result.warnings.append("downloaded ignored: expected list")

    raw_route_map = manifest.get("route_map")
    if raw_route_map is None:
        return result
    if schema_version_tuple(result.schema_version) < (1, 3):
        result.warnings.append("route_map ignored: manifest schema_version is older than 1.3")
        return result

    for index, (raw_target, record) in enumerate(_route_records(raw_route_map)):
        # Canonical v1.3 route_map keys are origin-form request targets. The
        # source origin belongs in record.source_url, never in the map key.
        target = canonical_request_target(raw_target, allow_absolute_url=False)
        if target is None:
            result.warnings.append(f"route_map[{index}] ignored: invalid request target")
            continue
        result.mapped_request_paths.add(request_path_from_target(target))
        if not isinstance(record, dict):
            result.warnings.append(f"route_map[{target}] blocked: expected object")
            result.route_map[target] = RouteEntry(target, None, None)
            continue
        local_path = record.get("local_path")
        raw_content_type = record.get("content_type")
        content_type = safe_content_type(raw_content_type) if raw_content_type else None
        if raw_content_type and content_type is None:
            result.warnings.append(f"route_map[{target}] content_type ignored: unsafe value")
        resolved = safe_local_path(directory, local_path) if local_path else None
        if resolved is None:
            result.warnings.append(f"route_map[{target}] blocked: unsafe or missing local_path")
            entry = RouteEntry(target, None, content_type)
        else:
            entry = RouteEntry(target, local_path, content_type)
            if content_type:
                result.content_types[resolved] = content_type
        previous = result.route_map.get(target)
        if previous is not None and previous != entry:
            result.warnings.append(f"route_map[{target}] blocked: conflicting duplicate")
            result.route_map[target] = RouteEntry(target, None, None)
        else:
            result.route_map[target] = entry
    return result


def static_path_for_request(directory: str, url_path: str):
    """Map a URL path to a file without permitting traversal or listings."""
    try:
        decoded = unquote_to_bytes(url_path).decode("utf-8", "strict")
    except (UnicodeDecodeError, ValueError):
        return None, "unsafe-path"
    if (not decoded.startswith("/") or "\\" in decoded
            or any(ord(char) < 32 or ord(char) == 127 for char in decoded)):
        return None, "unsafe-path"
    parts = decoded.split("/")[1:]
    if any(part in (".", "..") for part in parts):
        return None, "unsafe-path"
    parts = [part for part in parts if part]

    if not parts:
        candidate = safe_local_path(directory, "index.html")
    else:
        candidate = safe_local_path(directory, "/".join(parts))
    if candidate is None:
        return None, "unsafe-path"
    if os.path.isdir(candidate):
        relative_index = "/".join(parts + ["index.html"])
        index = safe_local_path(directory, relative_index)
        if index is not None and os.path.isfile(index):
            return index, "static-index"
        return None, "directory-listing-disabled"
    if os.path.isfile(candidate):
        return candidate, "static-file"
    return None, "not-found"


class MirrorRequestHandler(SimpleHTTPRequestHandler):
    spa_enabled = False
    spa_entry = "index.html"
    content_types = {}
    route_map = {}
    mapped_request_paths = set()

    def is_navigation(self):
        """Return true only for browser-navigation-shaped requests."""
        mode = self.headers.get("Sec-Fetch-Mode")
        if mode:
            return mode.strip().lower() == "navigate"
        return "text/html" in self.headers.get("Accept", "")

    def resolve_requested_file(self):
        target = canonical_request_target(self.path, allow_absolute_url=False)
        if target is None:
            return None, None, "unsafe-request-target"
        url_path = request_path_from_target(target)

        entry = self.route_map.get(target)
        if entry is not None:
            if not entry.local_path:
                return None, None, "blocked-route-map-entry"
            resolved = safe_local_path(self.directory, entry.local_path)
            if resolved is None or not os.path.isfile(resolved):
                return None, None, "missing-route-map-file"
            return resolved, entry.content_type, "route-map"

        # Once any variant of a path is mapped, the full path+query key is
        # authoritative. This prevents an unknown query variant from being
        # served as another body or masked by SPA fallback.
        if url_path in self.mapped_request_paths:
            return None, None, "unmapped-query-variant"

        path, reason = static_path_for_request(self.directory, url_path)
        return path, None, reason

    def resolve_spa_entry(self):
        path = safe_local_path(self.directory, self.spa_entry)
        if path is None or not os.path.isfile(path):
            return None
        return path

    def should_use_spa_fallback(self, reason: str) -> bool:
        if not self.spa_enabled or reason != "not-found" or not self.is_navigation():
            return False
        target = canonical_request_target(self.path, allow_absolute_url=False)
        if target is None:
            return False
        clean = request_path_from_target(target)
        extension = os.path.splitext(clean)[1].lower()
        return extension in ("", ".html")

    def do_GET(self):
        self._serve(send_body=True)

    def do_HEAD(self):
        self._serve(send_body=False)

    def _serve(self, send_body: bool):
        self._response_content_type = None
        path, content_type, reason = self.resolve_requested_file()
        if path is None and self.should_use_spa_fallback(reason):
            path = self.resolve_spa_entry()
            if path is not None:
                content_type = self.content_types.get(path)
                self.log_message("SPA fallback: %s -> %s", self.path, self.spa_entry)
        if path is None:
            self.log_message("honest 404 (%s): %s", reason, self.path)
            self.send_error(404, "File not found")
            return

        self._response_content_type = content_type
        if self.maybe_send_range(path, send_body):
            return
        self.send_file(path, send_body)

    def send_file(self, path: str, send_body: bool):
        try:
            handle = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return
        try:
            file_stat = os.fstat(handle.fileno())
            if not stat.S_ISREG(file_stat.st_mode):
                self.send_error(404, "File not found")
                return
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Length", str(file_stat.st_size))
            self.send_header("Last-Modified", self.date_time_string(file_stat.st_mtime))
            self.end_headers()
            if send_body:
                try:
                    self.copyfile(handle, self.wfile)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        finally:
            handle.close()

    def maybe_send_range(self, path: str, send_body: bool) -> bool:
        """Serve a valid single byte range as 206, or 416 if unsatisfiable."""
        header = self.headers.get("Range")
        if not header:
            return False
        match = SINGLE_RANGE_RE.match(header.strip())
        if not match:
            return False
        start_text, end_text = match.groups()
        if not start_text and not end_text:
            return False
        try:
            size = os.path.getsize(path)
            if start_text:
                start = int(start_text)
                end = int(end_text) if end_text else size - 1
                if end_text and end < start:
                    return False
            else:
                suffix = int(end_text)
                if suffix == 0:
                    return False
                start, end = max(0, size - suffix), size - 1
        except (OSError, ValueError):
            return False

        if start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True

        end = min(end, size - 1)
        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.send_header("Last-Modified", self.date_time_string(os.path.getmtime(path)))
        self.end_headers()
        if send_body:
            try:
                with open(path, "rb") as handle:
                    handle.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = handle.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
        return True

    def guess_type(self, path):
        if self._response_content_type:
            return self._response_content_type
        content_type = self.content_types.get(os.path.realpath(path))
        if content_type:
            return content_type
        return super().guess_type(path)

    def list_directory(self, path):
        self.send_error(404, "Directory listing disabled")
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()


# Keep the old class name import-compatible while changing its default to safe.
SPAHandler = MirrorRequestHandler


def make_handler(directory: str, manifest: ManifestData, spa_enabled: bool = False,
                 spa_entry: str = "index.html"):
    class ConfiguredHandler(MirrorRequestHandler):
        pass

    ConfiguredHandler.spa_enabled = spa_enabled
    ConfiguredHandler.spa_entry = spa_entry
    ConfiguredHandler.content_types = dict(manifest.content_types)
    ConfiguredHandler.route_map = dict(manifest.route_map)
    ConfiguredHandler.mapped_request_paths = set(manifest.mapped_request_paths)
    return partial(ConfiguredHandler, directory=directory)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", default=".", help="mirror root (default: current dir)")
    parser.add_argument("--port", type=int, default=None,
                        help="loopback port (default: contract port or 8000)")
    spa_group = parser.add_mutually_exclusive_group()
    spa_group.add_argument("--spa", action="store_true", help="explicitly enable safe SPA fallback")
    spa_group.add_argument("--no-spa", action="store_true",
                           help="force SPA fallback off (also overrides a contract)")
    parser.add_argument("--contract", help="project-local serve-contract.json")
    return parser


def contract_summary(path: Optional[str], contract: dict, actual_port: int,
                     spa_enabled: bool) -> str:
    if path is None:
        return "Serve contract: none (safe defaults/CLI only)"
    generated = contract.get("generated")
    if isinstance(generated, dict):
        generated_text = ", generated=%s/%s" % (
            generated.get("phase", "unknown"), generated.get("actor", "unknown"))
    else:
        generated_text = ""
    return (
        "Serve contract: %s (schema=%s, bind=127.0.0.1, port=%d, "
        "spa_fallback=%s, manifest=%s, route_map=%s, cache_control=no-store, "
        "range_requests=true%s)"
        % (
            path,
            contract.get("schema_version"),
            actual_port,
            "on" if spa_enabled else "off",
            contract.get("manifest", DEFAULT_MANIFEST),
            contract.get("route_map", "manifest.route_map"),
            generated_text,
        )
    )


def resolve_spa_configuration(directory: str, contract: dict,
                              force_spa: bool = False,
                              force_no_spa: bool = False):
    """Resolve SPA behavior with fail-closed precedence.

    ``--no-spa`` wins, then explicit ``--spa``, then a confirmed schema-1.3
    contract. CLI-enabled SPA defaults to ``index.html`` when the contract does
    not name an entry; contract-enabled SPA must already have named and
    validated ``safe_spa_entry`` in ``load_serve_contract``.
    """
    contract_spa = contract.get("spa_fallback") is True if contract else False
    spa_enabled = False if force_no_spa else bool(force_spa or contract_spa)
    if not spa_enabled:
        return False, "index.html"
    spa_entry = contract.get("safe_spa_entry") if contract else None
    spa_entry = spa_entry or "index.html"
    resolved_entry = safe_local_path(directory, spa_entry)
    if resolved_entry is None or not os.path.isfile(resolved_entry):
        raise ConfigurationError("SPA entry must name a file inside the web root")
    return True, spa_entry


def main(argv=None):
    args = build_parser().parse_args(argv)
    directory = os.path.abspath(args.directory)
    if not os.path.isdir(directory):
        raise SystemExit(f"Not a directory: {directory}")

    try:
        contract_path, contract, contract_warnings = load_serve_contract(directory, args.contract)
        manifest_ref = contract.get("manifest") if contract else None
        if manifest_ref:
            manifest_path = safe_local_path(directory, manifest_ref)
            if manifest_path is None:
                raise ConfigurationError("serve contract manifest escapes the web root")
        else:
            manifest_path = None
        manifest = load_manifest(directory, manifest_path)

        spa_enabled, spa_entry = resolve_spa_configuration(
            directory, contract, force_spa=args.spa, force_no_spa=args.no_spa
        )

        contract_port = contract.get("port") if contract else None
        port = args.port if args.port is not None else (contract_port if contract_port is not None else 8000)
        if not 0 <= port <= 65535:
            raise ConfigurationError("port must be from 0 through 65535")
    except ConfigurationError as exc:
        raise SystemExit(f"serve configuration error: {exc}") from exc

    handler = make_handler(directory, manifest, spa_enabled=spa_enabled, spa_entry=spa_entry)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        actual_port = httpd.server_address[1]
        print(contract_summary(contract_path, contract, actual_port, spa_enabled))
        for warning in contract_warnings + manifest.warnings:
            print(f"Warning: {warning}")
        mode = "SPA fallback ON" if spa_enabled else "plain static (SPA fallback OFF)"
        extras = []
        if manifest.route_map:
            extras.append(f"{len(manifest.route_map)} exact manifest routes")
        if manifest.content_types:
            extras.append(f"{len(manifest.content_types)} manifest content-types")
        extra = (" + " + ", ".join(extras)) if extras else ""
        print(f"Serving {directory} at http://127.0.0.1:{actual_port} ({mode}{extra}) — Ctrl+C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
