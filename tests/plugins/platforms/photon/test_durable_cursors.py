"""Durable Photon cursor regression tests.

A full gateway/VM restart must resume Spectrum's per-stream cursors so iMessages
sent while Hermes is offline are replayed through CatchUpEvents.

Scope of "without duplicates": that guarantee holds for messages sent while the
VM is fully offline and never dispatched before the outage. It does NOT hold
for a message dispatched but uncommitted at crash time (gateway dies, sidecar
exits, or the ACK fails after dispatch succeeded but before commitTagged
writes): the cursor stays old and the new gateway process, with an empty
in-memory dedup, dispatches the Spectrum replay a second time. Closing that
window needs durable dedup or dispatch idempotency, which is out of scope
here — the live acceptance test must therefore use a clean fully-down window.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


_SIDECAR = Path("plugins/platforms/photon/sidecar")
_PATCHER = _SIDECAR / "patch-spectrum-durable-cursors.mjs"
_STORE = _SIDECAR / "durable-cursors.mjs"


def _node(script: str, *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, **(env or {})},
    )


def test_cursor_store_survives_restart_and_clears_rejected_cursor(tmp_path: Path) -> None:
    state = tmp_path / "photon" / "inbound-cursors.json"
    module = _STORE.resolve().as_uri()
    first = _node(
        f"""
        import {{ createDurableCursorBridge }} from {json.dumps(module)};
        const bridge = createDurableCursorBridge({json.dumps(str(state))});
        if (bridge.load('imessage.messages:shared') !== undefined) process.exit(10);
        bridge.commit('imessage.messages:shared', '41');
        bridge.commit('imessage.polls:shared', '39');
        const raw = {{id: 'message-1'}};
        bridge.tag('imessage.messages:shared', '42', [['space', raw]]);
        const wrapped = Object.fromEntries(Object.entries(raw));
        if (!bridge.isTagged(wrapped)) process.exit(13);
        bridge.commitTagged(wrapped);
        """
    )
    assert first.returncode == 0, first.stderr

    second = _node(
        f"""
        import {{ createDurableCursorBridge }} from {json.dumps(module)};
        const bridge = createDurableCursorBridge({json.dumps(str(state))});
        if (bridge.load('imessage.messages:shared') !== '42') process.exit(11);
        if (bridge.load('imessage.polls:shared') !== '39') process.exit(12);
        bridge.clear('imessage.messages:shared');
        """
    )
    assert second.returncode == 0, second.stderr

    payload = json.loads(state.read_text(encoding="utf-8"))
    assert payload == {"imessage.polls:shared": "39"}
    assert state.stat().st_mode & 0o777 == 0o600


def test_cursor_patch_adds_restart_resume_and_ordered_checkpoint(tmp_path: Path) -> None:
    installed = (
        _SIDECAR
        / "node_modules"
        / "@spectrum-ts"
        / "core"
        / "dist"
        / "authoring.js"
    )
    assert installed.is_file(), "run `npm install` in the Photon sidecar first"
    target = tmp_path / "node_modules" / "@spectrum-ts" / "core" / "dist" / "authoring.js"
    target.parent.mkdir(parents=True)
    shutil.copyfile(installed, target)

    result = subprocess.run(
        ["node", str(_PATCHER), str(tmp_path)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    patched = target.read_text(encoding="utf-8")
    assert "Hermes patch: durable Photon stream cursors" in patched
    assert "hermes.photon.streamCursor" in patched
    assert "cursorBridge?.load(options.label)" in patched
    assert "cursorBridge?.tag(options.label, item.cursor, alreadyDelivered ? [] : item.values)" in patched
    assert "cursorBridge?.clear(options.label)" in patched

    again = subprocess.run(
        ["node", str(_PATCHER), str(tmp_path)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert again.returncode == 0, again.stderr
    assert target.read_text(encoding="utf-8") == patched


def test_sidecar_installs_cursor_patch_and_runtime_helper() -> None:
    package = json.loads((_SIDECAR / "package.json").read_text(encoding="utf-8"))
    assert "patch-spectrum-durable-cursors.mjs" in package["scripts"]["postinstall"]
    assert _PATCHER.is_file()
    assert _STORE.is_file()
