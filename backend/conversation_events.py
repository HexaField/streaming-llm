from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from typing import Any, Dict, Set

from fastapi import WebSocket


class ConversationEventBus:
    def __init__(self) -> None:
        self._subscribers: dict[str, Set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def subscribe(self, conversation_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._subscribers[conversation_id].add(websocket)

    async def unsubscribe(self, conversation_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            if conversation_id in self._subscribers and websocket in self._subscribers[conversation_id]:
                self._subscribers[conversation_id].remove(websocket)
            if conversation_id in self._subscribers and not self._subscribers[conversation_id]:
                del self._subscribers[conversation_id]

    async def broadcast(self, conversation_id: str, event: Dict[str, Any]) -> None:
        payload = json.dumps(event)
        async with self._lock:
            subscribers = list(self._subscribers.get(conversation_id, set()))
        for websocket in subscribers:
            try:
                await websocket.send_text(payload)
            except Exception:
                await self.unsubscribe(conversation_id, websocket)

    async def broadcast_system_message(self, event: Dict[str, Any]) -> None:
        payload = json.dumps(event)
        async with self._lock:
            subscribers = [
                (conversation_id, websocket)
                for conversation_id, conns in self._subscribers.items()
                for websocket in conns
            ]
        for conversation_id, websocket in subscribers:
            try:
                await websocket.send_text(payload)
            except Exception:
                await self.unsubscribe(conversation_id, websocket)
