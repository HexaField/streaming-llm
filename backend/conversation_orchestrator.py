from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from uuid import uuid4

from .conversation_events import ConversationEventBus
from .conversation_manager import ConversationManager
from .model_engine import StreamingLLMEngine
from .agent_store import AgentStore
from .ace_bridge import ACEBridge


RESPONSE_DELAY_MS = 0.6
RESPONSE_DELAY_STEP_MS = 0.2


@dataclass
class TriggerMessage:
    conversation_id: str
    speaker_role: str
    speaker_name: Optional[str]
    speaker_id: Optional[str]
    content: str


class ConversationOrchestrator:
    def __init__(
        self,
        manager: ConversationManager,
        agent_store: AgentStore,
        event_bus: ConversationEventBus,
        engine: StreamingLLMEngine,
        ace_bridge: ACEBridge,
        *,
        temperature: float = 0.2,
    ) -> None:
        self.manager = manager
        self.agent_store = agent_store
        self.event_bus = event_bus
        self.engine = engine
        self.ace_bridge = ace_bridge
        self.temperature = temperature
        self._locks: Dict[str, asyncio.Lock] = {}
        self._active_tasks: Dict[str, Dict[str, asyncio.Task]] = {}

    async def handle_new_message(self, conversation_id: str, message: Dict[str, Any]) -> None:
        if not conversation_id or not message:
            return
        trigger = TriggerMessage(
            conversation_id=conversation_id,
            speaker_role=str(message.get("role") or "").upper(),
            speaker_name=message.get("name"),
            speaker_id=message.get("speaker_id"),
            content=message.get("content") or "",
        )
        await self._schedule(conversation_id, trigger)

    async def update_active_agents(self, conversation_id: str, agent_ids: List[str]) -> None:
        await self._schedule(conversation_id, None, override_agents=agent_ids)

    async def _schedule(
        self,
        conversation_id: str,
        trigger: Optional[TriggerMessage],
        *,
        override_agents: Optional[List[str]] = None,
    ) -> None:
        lock = self._locks.setdefault(conversation_id, asyncio.Lock())
        async with lock:
            active_agents = override_agents or self.manager.get_active_agents(conversation_id)
            if not active_agents:
                return
            speaker_agent = None
            if trigger and trigger.speaker_role == "AGENT":
                speaker_agent = trigger.speaker_id
            sequence: List[str] = [agent_id for agent_id in active_agents if agent_id != speaker_agent]
            if not sequence:
                return
            for index, agent_id in enumerate(sequence):
                if self._is_agent_busy(conversation_id, agent_id):
                    continue
                delay = RESPONSE_DELAY_MS + index * RESPONSE_DELAY_STEP_MS
                task = asyncio.create_task(
                    self._run_agent_response(conversation_id, agent_id, trigger, delay)
                )
                self._active_tasks.setdefault(conversation_id, {})[agent_id] = task

    def _is_agent_busy(self, conversation_id: str, agent_id: str) -> bool:
        return (
            conversation_id in self._active_tasks
            and agent_id in self._active_tasks[conversation_id]
            and not self._active_tasks[conversation_id][agent_id].done()
        )

    async def _run_agent_response(
        self,
        conversation_id: str,
        agent_id: str,
        trigger: Optional[TriggerMessage],
        delay_seconds: float,
    ) -> None:
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)
        agent = self.agent_store.get_agent(agent_id)
        if not agent:
            return
        history = self.manager.history(conversation_id)
        speaker_role = trigger.speaker_role if trigger else "PERSON"
        speaker_name = trigger.speaker_name if trigger else "User"
        speaker_id = trigger.speaker_id if trigger else None
        message_id = str(uuid4())
        await self.event_bus.broadcast(
            conversation_id,
            {
                "type": "message_started",
                "conversation_id": conversation_id,
                "agent_id": agent_id,
                "message_id": message_id,
                "speaker_name": agent.name,
            },
        )
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def worker() -> None:
            try:
                prompt = self.ace_bridge.build_prompt(
                    agent=agent,
                    conversation_id=conversation_id,
                    history=history,
                    user_message=trigger.content if trigger else "",
                    speaker_role=speaker_role,
                    speaker_name=speaker_name,
                    speaker_id=speaker_id,
                )
                for token in self.engine.stream(
                    prompt=prompt,
                    temperature=self.temperature,
                ):
                    loop.call_soon_threadsafe(queue.put_nowait, ("token", token))
                loop.call_soon_threadsafe(queue.put_nowait, ("done", None))
            except Exception as exc:  # noqa: BLE001
                loop.call_soon_threadsafe(queue.put_nowait, ("error", str(exc)))

        worker_future = loop.run_in_executor(None, worker)
        content = ""
        error_message: Optional[str] = None
        while True:
            kind, payload = await queue.get()
            if kind == "token":
                token = payload or ""
                content += token
                await self.event_bus.broadcast(
                    conversation_id,
                    {
                        "type": "token",
                        "conversation_id": conversation_id,
                        "agent_id": agent_id,
                        "message_id": message_id,
                        "token": token,
                    },
                )
            elif kind == "done":
                break
            elif kind == "error":
                error_message = payload or "Unknown error"
                break
        await worker_future
        if error_message:
            await self.event_bus.broadcast(
                conversation_id,
                {
                    "type": "message_error",
                    "conversation_id": conversation_id,
                    "agent_id": agent_id,
                    "message_id": message_id,
                    "message": error_message,
                },
            )
            self._active_tasks.get(conversation_id, {}).pop(agent_id, None)
            return
        result = self.manager.append(
            conversation_id,
            "AGENT",
            content.strip(),
            name=agent.name,
            speaker_id=agent.id,
            message_id=message_id,
        )
        self.ace_bridge.schedule_learning(
            agent=agent,
            conversation_id=conversation_id,
            user_message=trigger.content if trigger else "",
            agent_response=content.strip(),
            prompt=prompt,
            diagnostics={"temperature": self.temperature},
        )
        await self.event_bus.broadcast(
            conversation_id,
            {
                "type": "message_completed",
                "conversation_id": conversation_id,
                "agent_id": agent_id,
                "message_id": message_id,
                "content": result.get("content", ""),
            },
        )
        self._active_tasks.get(conversation_id, {}).pop(agent_id, None)
        await self.handle_new_message(conversation_id, result)
