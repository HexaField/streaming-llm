from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Dict, Iterable, List, Optional

from .agent_store import Agent
from .conversation_manager import ConversationManager
from .prompt_builder import PromptComposer, PromptSections
from .settings import Settings

logger = logging.getLogger(__name__)

try:  # pragma: no cover - runtime dependency detection
    from ace import (
        Curator,
        GeneratorOutput,
        LiteLLMClient,
        Playbook,
        Reflector,
    )
    from ace.roles import ReflectorOutput
    from ace.integrations.base import wrap_playbook_context

    ACE_AVAILABLE = True
except ImportError:  # pragma: no cover - fallback if ace-framework missing
    ACE_AVAILABLE = False

    @dataclass
    class _FallbackBullet:
        id: str
        section: str
        content: str
        helpful: int = 0
        harmful: int = 0
        neutral: int = 0

    class Playbook:  # type: ignore[override]
        def __init__(self) -> None:
            self._bullets: Dict[str, _FallbackBullet] = {}
            self._counter = 0

        def add_bullet(
            self,
            section: str,
            content: str,
            bullet_id: Optional[str] = None,
            metadata: Optional[Dict[str, int]] = None,
        ) -> _FallbackBullet:
            self._counter += 1
            bid = bullet_id or f"{section or 'general'}-{self._counter:05d}"
            bullet = _FallbackBullet(
                id=bid,
                section=section or "general",
                content=content,
            )
            if metadata:
                bullet.helpful = int(metadata.get("helpful", bullet.helpful))
                bullet.harmful = int(metadata.get("harmful", bullet.harmful))
                bullet.neutral = int(metadata.get("neutral", bullet.neutral))
            self._bullets[bid] = bullet
            return bullet
            
        def bullets(self) -> List[_FallbackBullet]:
            return list(self._bullets.values())

        def save_to_file(self, path: str) -> None:
            payload = {
                "bullets": {
                    bullet.id: {
                        "id": bullet.id,
                        "section": bullet.section,
                        "content": bullet.content,
                        "helpful": bullet.helpful,
                        "harmful": bullet.harmful,
                        "neutral": bullet.neutral,
                    }
                    for bullet in self._bullets.values()
                }
            }
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(json.dumps(payload, indent=2))

        @classmethod
        def load_from_file(cls, path: str) -> "Playbook":
            instance = cls()
            raw_path = Path(path)
            if not raw_path.exists():
                return instance
            payload = json.loads(raw_path.read_text())
            bullets = payload.get("bullets", {}) if isinstance(payload, dict) else {}
            for bullet_id, bullet_data in bullets.items():
                if not isinstance(bullet_data, dict):
                    continue
                instance.add_bullet(
                    bullet_data.get("section", "general"),
                    bullet_data.get("content", ""),
                    bullet_id=bullet_id,
                    metadata={
                        "helpful": bullet_data.get("helpful", 0),
                        "harmful": bullet_data.get("harmful", 0),
                        "neutral": bullet_data.get("neutral", 0),
                    },
                )
            return instance

        def stats(self) -> Dict[str, Any]:
            bullets = self.bullets()
            return {
                "sections": len({bullet.section for bullet in bullets}),
                "bullets": len(bullets),
                "tags": {
                    "helpful": sum(b.helpful for b in bullets),
                    "harmful": sum(b.harmful for b in bullets),
                    "neutral": sum(b.neutral for b in bullets),
                },
            }

    def wrap_playbook_context(playbook: Playbook) -> str:
        lines = ["Strategic Knowledge (fallback)"]
        for bullet in playbook.bullets()[:5]:
            lines.append(f"- {bullet.content}")
        return "\n".join(lines)


@dataclass
class _AceRuntime:
    client: Optional[Any]
    reflector: Optional[Reflector]
    curator: Optional[Curator]
    enabled: bool = False


class ACEBridge:
    """Coordinates ACE-driven learning, persistence, and prompt assembly."""

    def __init__(self, settings: Settings, manager: ConversationManager):
        self.settings = settings
        self.manager = manager
        self.playbooks_dir = settings.playbooks_dir
        self.agent_state_dir = settings.agent_state_dir
        self.logs_dir = settings.logs_dir
        self.global_playbook_path = settings.global_playbook_path
        self.prompt_composer = PromptComposer()
        self._lock = RLock()
        self._agent_playbooks: Dict[str, Playbook] = {}
        self._learning_tasks: List[asyncio.Task[Any]] = []

        self.playbooks_dir.mkdir(parents=True, exist_ok=True)
        self.agent_state_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.global_playbook_path.parent.mkdir(parents=True, exist_ok=True)

        self._global_playbook = self._load_global_playbook()
        self._ace_runtime = self._init_runtime()

    # ------------------------------------------------------------------
    # Prompt assembly
    # ------------------------------------------------------------------

    def build_prompt(
        self,
        *,
        agent: Agent,
        conversation_id: str,
        history: Iterable[Dict[str, Any]],
        user_message: str,
        speaker_role: str,
        speaker_name: Optional[str],
        speaker_id: Optional[str],
    ) -> str:
        agent_playbook = self._load_agent_playbook(agent.id)
        agent_playbook_text = self._format_playbook_for_prompt(
            agent_playbook, user_message, label=f"{agent.name} strategies"
        )
        global_context = self._format_playbook_for_prompt(
            self._global_playbook,
            user_message,
            label="Global playbook",
        )
        conversation_memory = self._conversation_memory_text(conversation_id, history)
        inter_agent_context = self._inter_agent_context(conversation_id, agent.id)

        sections = PromptSections(
            system_prompt=agent.system_prompt,
            agent_markdown=agent.markdown_context,
            agent_playbook=agent_playbook_text,
            global_playbook=global_context,
            conversation_memory=conversation_memory,
            inter_agent_context=inter_agent_context,
            user_name=speaker_name,
            user_role=speaker_role,
            user_id=speaker_id,
            user_message=user_message,
        )
        prompt = self.prompt_composer.compose(sections)
        self._remember_last_prompt(agent.id, prompt, conversation_id)
        return prompt

    # ------------------------------------------------------------------
    # Learning + persistence
    # ------------------------------------------------------------------

    def schedule_learning(
        self,
        *,
        agent: Agent,
        conversation_id: str,
        user_message: str,
        agent_response: str,
        prompt: str,
        diagnostics: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not agent_response.strip():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.warning("ACE learning requires an active event loop; skipping.")
            return
        task = loop.create_task(
            self._learn_async(
                agent,
                conversation_id,
                user_message,
                agent_response,
                prompt,
                diagnostics or {},
            )
        )
        self._learning_tasks.append(task)
        task.add_done_callback(lambda t: self._learning_tasks.remove(t))

    async def _learn_async(
        self,
        agent: Agent,
        conversation_id: str,
        user_message: str,
        agent_response: str,
        prompt: str,
        diagnostics: Dict[str, Any],
    ) -> None:
        await asyncio.to_thread(
            self._process_learning,
            agent,
            conversation_id,
            user_message,
            agent_response,
            prompt,
            diagnostics,
        )

    def _process_learning(
        self,
        agent: Agent,
        conversation_id: str,
        user_message: str,
        agent_response: str,
        prompt: str,
        diagnostics: Dict[str, Any],
    ) -> None:
        playbook = self._load_agent_playbook(agent.id)
        runtime = self._ace_runtime if self._ace_runtime.enabled else None
        reflection_payload: Optional[Dict[str, Any]] = None
        curation_payload: Optional[Dict[str, Any]] = None

        if runtime and runtime.reflector and runtime.curator:
            try:
                generator_output = GeneratorOutput(
                    reasoning=user_message,
                    final_answer=agent_response,
                    bullet_ids=[],
                )
                reflection = runtime.reflector.reflect(
                    question=user_message,
                    generator_output=generator_output,
                    playbook=playbook,
                    feedback=None,
                )
                curator_output = runtime.curator.curate(
                    reflection=reflection,
                    playbook=playbook,
                    question_context=f"conversation:{conversation_id}",
                    progress="streaming",
                )
                playbook.apply_delta(curator_output.delta)
                self._global_playbook.apply_delta(curator_output.delta)
                reflection_payload = reflection.model_dump()
                curation_payload = curator_output.delta.model_dump()
            except Exception:  # pragma: no cover - network/provider errors
                logger.exception("ACE reflection failed; falling back to heuristics")
                self._heuristic_learn(playbook, user_message, agent_response)
        else:
            self._heuristic_learn(playbook, user_message, agent_response)

        self._save_playbook(agent.id, playbook)
        self._save_global_playbook()
        self._update_agent_state(
            agent,
            conversation_id,
            user_message,
            agent_response,
            prompt,
            diagnostics,
            reflection_payload,
            curation_payload,
        )
        summary = self._summarize_turn(user_message, agent_response)
        self.manager.record_memory(conversation_id, summary=summary)
        self._append_log(agent.id, user_message, agent_response)

    def _heuristic_learn(self, playbook: Playbook, user_message: str, agent_response: str) -> None:
        preview = agent_response.strip().splitlines()[0][:240]
        content = (
            f"When the user intent resembles '{user_message[:80].strip()}...', "
            f"remember to respond with: {preview}"
        )
        playbook.add_bullet(
            section="conversation",
            content=content,
            metadata={"helpful": 1},
        )
        self._global_playbook.add_bullet(
            section="global",
            content=content,
            metadata={"helpful": 1},
        )

    # ------------------------------------------------------------------
    # Agent + conversation inspection
    # ------------------------------------------------------------------

    def get_agent_state(self, agent_id: str) -> Optional[Dict[str, Any]]:
        agent_state = self._load_agent_state(agent_id)
        if agent_state is None:
            agent_state = self._default_agent_state()
            self._write_agent_state(agent_id, agent_state)
        playbook = self._load_agent_playbook(agent_id)
        payload = {
            "agent_id": agent_id,
            "playbook": self._playbook_snapshot(playbook),
            "local_memory": agent_state.get("local_memory", {}),
            "diagnostics": agent_state.get("diagnostics", {}),
            "reflection": agent_state.get("reflection"),
            "curation": agent_state.get("curation"),
            "last_run": agent_state.get("last_run"),
            "logs": agent_state.get("logs", [])[-50:],
            "global_memory": self.get_global_playbook_state(),
        }
        return payload

    def get_agent_playbook_payload(self, agent_id: str) -> Dict[str, Any]:
        playbook = self._load_agent_playbook(agent_id)
        return {"playbook": self._playbook_snapshot(playbook)}

    def reset_agent_playbook(self, agent_id: str) -> None:
        with self._lock:
            self._agent_playbooks[agent_id] = Playbook()
            self._save_playbook(agent_id, self._agent_playbooks[agent_id])

    def get_conversation_state(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        record = self.manager.inspect(conversation_id)
        if not record:
            return None
        record["global_playbook"] = self.get_global_playbook_state()
        return record

    def get_global_playbook_state(self) -> Dict[str, Any]:
        return self._playbook_snapshot(self._global_playbook)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _init_runtime(self) -> _AceRuntime:
        if not (ACE_AVAILABLE and self.settings.ace_learning_enabled):
            return _AceRuntime(client=None, reflector=None, curator=None, enabled=False)
        try:
            client = LiteLLMClient(
                model=self.settings.ace_model,
                max_tokens=self.settings.ace_max_tokens,
            )
            reflector = Reflector(client)
            curator = Curator(client)
            return _AceRuntime(
                client=client,
                reflector=reflector,
                curator=curator,
                enabled=True,
            )
        except Exception:  # pragma: no cover - dependency issues
            logger.exception("Failed to initialize ACE runtime; continuing in heuristic mode")
            return _AceRuntime(client=None, reflector=None, curator=None, enabled=False)

    def _load_agent_playbook(self, agent_id: str) -> Playbook:
        with self._lock:
            if agent_id in self._agent_playbooks:
                return self._agent_playbooks[agent_id]
            path = self._playbook_path(agent_id)
            if path.exists():
                playbook = Playbook.load_from_file(str(path))
            else:
                playbook = Playbook()
            self._agent_playbooks[agent_id] = playbook
            return playbook

    def _save_playbook(self, agent_id: str, playbook: Playbook) -> None:
        path = self._playbook_path(agent_id)
        playbook.save_to_file(str(path))

    def _load_global_playbook(self) -> Playbook:
        if self.global_playbook_path.exists():
            try:
                return Playbook.load_from_file(str(self.global_playbook_path))
            except Exception:  # pragma: no cover - corrupted file recovery
                logger.exception("Failed to load global playbook; starting fresh")
        return Playbook()

    def _save_global_playbook(self) -> None:
        self._global_playbook.save_to_file(str(self.global_playbook_path))

    def _playbook_path(self, agent_id: str) -> Path:
        safe = agent_id.replace("/", "_")
        return self.playbooks_dir / f"{safe}.json"

    def _format_playbook_for_prompt(
        self,
        playbook: Playbook,
        query: str,
        *,
        label: str,
        limit: int = 6,
    ) -> str:
        bullets = self._select_relevant_bullets(playbook, query, limit=limit)
        if not bullets:
            return ""
        lines = [f"{label}:"]
        for bullet in bullets:
            helpful = getattr(bullet, "helpful", 0)
            harmful = getattr(bullet, "harmful", 0)
            lines.append(
                f"- [{getattr(bullet, 'section', 'general')}] (+{helpful}/-{harmful}) "
                f"{getattr(bullet, 'content', '').strip()}"
            )
        if ACE_AVAILABLE:
            try:
                wrapped = wrap_playbook_context(playbook)
            except Exception:  # pragma: no cover - defensive against provider errors
                wrapped = ""
            if wrapped:
                lines.append("")
                lines.append(wrapped.strip())
        return "\n".join(lines)

    def _select_relevant_bullets(
        self,
        playbook: Playbook,
        query: str,
        *,
        limit: int,
    ) -> List[Any]:
        tokens = {token for token in re.findall(r"[a-zA-Z0-9]+", query.lower()) if token}
        bullets = list(playbook.bullets())
        if not bullets:
            return []

        def score(bullet: Any) -> tuple[int, int, int]:
            text = getattr(bullet, "content", "").lower()
            token_hits = sum(1 for token in tokens if token in text) if tokens else 0
            helpful = int(getattr(bullet, "helpful", 0))
            harmful = int(getattr(bullet, "harmful", 0))
            return (token_hits, helpful - harmful, helpful)

        bullets.sort(key=score, reverse=True)
        return bullets[:limit]

    def _conversation_memory_text(
        self,
        conversation_id: str,
        history: Iterable[Dict[str, Any]],
    ) -> str:
        record = self.manager.get(conversation_id)
        lines: List[str] = []
        if record:
            memory = record.get("memory") or {}
            summary = memory.get("summary")
            if summary:
                lines.append(f"Summary: {summary}")
            snapshots = memory.get("snapshots") or []
            if snapshots:
                latest = snapshots[-1]
                lines.append(f"Last distilled insight: {latest.get('text')}")
        timeline_lines = []
        for turn in list(history)[-6:]:
            role = str(turn.get("role", "?"))
            speaker = turn.get("name") or turn.get("speaker_id") or role
            snippet = (turn.get("content") or "").strip().replace("\n", " ")[:220]
            timeline_lines.append(f"- {role}::{speaker}: {snippet}")
        if timeline_lines:
            lines.append("Timeline:")
            lines.extend(timeline_lines)
        return "\n".join(lines).strip()

    def _inter_agent_context(self, conversation_id: str, current_agent_id: str) -> str:
        history = self.manager.history(conversation_id)
        seen: Dict[str, Dict[str, Any]] = {}
        for turn in reversed(history):
            agent_id = turn.get("speaker_id")
            if not agent_id or agent_id == current_agent_id:
                continue
            if str(turn.get("role", "")).upper() != "AGENT":
                continue
            if agent_id in seen:
                continue
            seen[agent_id] = turn
            if len(seen) >= 4:
                break
        if not seen:
            active = self.manager.get_active_agents(conversation_id)
            return f"Active agents: {', '.join(active) if active else 'none'}"
        lines = ["Recent agent outputs:"]
        for agent_id, turn in seen.items():
            speaker = turn.get("name") or agent_id
            snippet = (turn.get("content") or "").strip().replace("\n", " ")[:200]
            lines.append(f"- {speaker}: {snippet}")
        active = self.manager.get_active_agents(conversation_id)
        if active:
            lines.append(f"Active agents: {', '.join(active)}")
        return "\n".join(lines)

    def _remember_last_prompt(self, agent_id: str, prompt: str, conversation_id: str) -> None:
        state = self._load_agent_state(agent_id) or {}
        state.setdefault("last_run", {})
        state["last_run"].update(
            {
                "prompt_preview": prompt[-1500:],
                "conversation_id": conversation_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )
        self._write_agent_state(agent_id, state)

    def _update_agent_state(
        self,
        agent: Agent,
        conversation_id: str,
        user_message: str,
        agent_response: str,
        prompt: str,
        diagnostics: Dict[str, Any],
        reflection: Optional[Dict[str, Any]],
        curation: Optional[Dict[str, Any]],
    ) -> None:
        state = self._load_agent_state(agent.id) or {}
        messages = state.setdefault("local_memory", {}).setdefault("recent_messages", [])
        messages.append(
            {
                "conversation_id": conversation_id,
                "user": user_message,
                "agent": agent_response,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )
        state["local_memory"]["summary"] = self._summarize_memory(messages)
        state["diagnostics"] = diagnostics
        if reflection:
            state["reflection"] = reflection
        if curation:
            state["curation"] = curation
        state["last_run"] = {
            "prompt_preview": prompt[-1500:],
            "response_preview": agent_response[:1500],
            "conversation_id": conversation_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        logs = state.setdefault("logs", [])
        logs.append(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "event": "turn",
                "conversation_id": conversation_id,
                "summary": self._summarize_turn(user_message, agent_response),
            }
        )
        state["logs"] = logs[-200:]
        self._write_agent_state(agent.id, state)

    def _load_agent_state(self, agent_id: str) -> Optional[Dict[str, Any]]:
        path = self.agent_state_dir / f"{agent_id}.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            logger.warning("Agent state file %s is corrupt; resetting", path)
            return None

    def _write_agent_state(self, agent_id: str, payload: Dict[str, Any]) -> None:
        path = self.agent_state_dir / f"{agent_id}.json"
        path.write_text(json.dumps(payload, indent=2))

    def _default_agent_state(self) -> Dict[str, Any]:
        return {
            "local_memory": {"summary": None, "recent_messages": []},
            "diagnostics": {},
            "reflection": None,
            "curation": None,
            "last_run": {},
            "logs": [],
        }

    def _playbook_snapshot(self, playbook: Playbook) -> Dict[str, Any]:
        bullets_payload: List[Dict[str, Any]] = []
        for bullet in playbook.bullets():
            bullets_payload.append(
                {
                    "id": getattr(bullet, "id", "unknown"),
                    "section": getattr(bullet, "section", "general"),
                    "content": getattr(bullet, "content", ""),
                    "helpful": getattr(bullet, "helpful", 0),
                    "harmful": getattr(bullet, "harmful", 0),
                    "neutral": getattr(bullet, "neutral", 0),
                }
            )
        return {
            "stats": playbook.stats() if hasattr(playbook, "stats") else {},
            "bullets": bullets_payload,
        }

    def _summarize_memory(self, messages: List[Dict[str, Any]]) -> str:
        latest = messages[-3:]
        lines = []
        for item in latest:
            user = item.get("user", "")[:80]
            agent_resp = item.get("agent", "")[:80]
            lines.append(f"User: {user} -> Agent: {agent_resp}")
        return " | ".join(lines)

    def _summarize_turn(self, user_message: str, agent_response: str) -> str:
        return (
            f"U: {user_message[:80].strip()} | A: {agent_response[:80].strip()}"
        )

    def _append_log(self, agent_id: str, user_message: str, agent_response: str) -> None:
        path = self.logs_dir / f"{agent_id}.log"
        timestamp = datetime.now(timezone.utc).isoformat()
        line = f"[{timestamp}] U> {user_message.strip()}\n[{timestamp}] A> {agent_response.strip()}\n"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
        conductor_path = self.logs_dir / "conductor.log"
        with conductor_path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{timestamp}] {agent_id} responded in conversation turn\n")
