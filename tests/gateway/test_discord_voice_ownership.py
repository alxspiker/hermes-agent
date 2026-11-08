"""Discord voice automation must never move or disconnect a manually owned call."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from plugins.platforms.discord import adapter as discord_adapter


def _adapter(monkeypatch):
    monkeypatch.setattr(discord_adapter, "DISCORD_AVAILABLE", True)
    adapter = object.__new__(discord_adapter.DiscordAdapter)
    adapter._client = object()
    adapter._voice_clients = {}
    adapter._voice_locks = {}
    adapter._voice_owners = {}
    return adapter


@pytest.mark.asyncio
async def test_auto_join_does_not_move_manual_connection_while_waiting(monkeypatch):
    adapter = _adapter(monkeypatch)
    guild_id = 123
    channel = SimpleNamespace(id=8, guild=SimpleNamespace(id=guild_id))
    manual_channel = SimpleNamespace(id=7)
    manual = SimpleNamespace(channel=manual_channel, is_connected=lambda: True)
    adapter._join_voice_locked = AsyncMock(return_value=True)
    lock = adapter._voice_locks[guild_id] = asyncio.Lock()

    await lock.acquire()
    join = asyncio.create_task(
        adapter.join_owned_voice_channel(channel, owner=object(), text_channel_id=10)
    )
    await asyncio.sleep(0)
    adapter._voice_clients[guild_id] = manual
    lock.release()

    assert await join is False
    assert adapter._voice_clients[guild_id] is manual
    assert manual.channel is manual_channel
    adapter._join_voice_locked.assert_not_awaited()


@pytest.mark.asyncio
async def test_automatic_join_leases_exact_connection(monkeypatch):
    adapter = _adapter(monkeypatch)
    owner = object()
    vc = object()
    channel = SimpleNamespace(id=8, guild=SimpleNamespace(id=123))

    async def create(_channel, _text_channel_id, _source):
        adapter._voice_clients[123] = vc
        return True

    adapter._join_voice_locked = AsyncMock(side_effect=create)
    assert await adapter.join_owned_voice_channel(channel, owner=owner, text_channel_id=10)
    assert adapter._voice_owners[123][0] is owner
    assert adapter._voice_owners[123][1] is vc


@pytest.mark.asyncio
async def test_owned_leave_rejects_foreign_stale_and_missing_leases(monkeypatch):
    adapter = _adapter(monkeypatch)
    owner, foreign = object(), object()
    vc, replacement = object(), object()
    adapter._voice_clients[123] = vc
    adapter._voice_owners[123] = (owner, vc)
    adapter._leave_voice_locked = AsyncMock()

    await adapter.leave_owned_voice_channel(123, owner=foreign)
    adapter._voice_clients[123] = replacement
    await adapter.leave_owned_voice_channel(123, owner=owner)
    adapter._voice_owners.pop(123)
    await adapter.leave_owned_voice_channel(123, owner=owner)
    adapter._leave_voice_locked.assert_not_awaited()
    adapter._voice_clients[123] = vc
    adapter._voice_owners[123] = (owner, vc)
    await adapter.leave_owned_voice_channel(123, owner=owner)
    adapter._leave_voice_locked.assert_awaited_once_with(123)


@pytest.mark.asyncio
async def test_explicit_manual_join_revokes_automation_ownership(monkeypatch):
    adapter = _adapter(monkeypatch)
    channel = SimpleNamespace(id=8, guild=SimpleNamespace(id=123))
    vc = object()
    adapter._voice_clients[123] = vc
    adapter._voice_owners[123] = (object(), vc)
    adapter._join_voice_locked = AsyncMock(return_value=True)

    assert await adapter.join_voice_channel(channel, text_channel_id=10)
    assert 123 not in adapter._voice_owners
    adapter._join_voice_locked.assert_awaited_once_with(channel, 10, None)


@pytest.mark.asyncio
async def test_stale_voice_client_is_force_disconnected_before_rejoin(monkeypatch):
    adapter = _adapter(monkeypatch)
    adapter._client = SimpleNamespace(get_guild=lambda _gid: None)
    adapter._voice_receivers = {}
    adapter._voice_listen_tasks = {}
    adapter._voice_text_channels = {}
    adapter._voice_sources = {}
    adapter._voice_timeout_tasks = {}
    adapter._voice_mixers = {}
    stale = SimpleNamespace(
        is_connected=lambda: False,
        disconnect=AsyncMock(),
    )
    adapter._voice_clients[123] = stale
    await adapter.leave_voice_channel(123)
    stale.disconnect.assert_awaited_once_with(force=True)
    assert 123 not in adapter._voice_clients
