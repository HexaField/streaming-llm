from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Optional
from uuid import uuid4


class ConversationManager:
    def __init__(
        self,
        storage_dir: Optional[Path] = None,
        *,
        max_turns: int = 200,
    ) -> None:
        self.storage_dir = Path(storage_dir or Path(".conversations"))
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.max_turns = max_turns
        self._lock = RLock()

    def ensure(self, conversation_id: Optional[str], *, title: Optional[str] = None) -> str:
        with self._lock:
            if conversation_id and self._conversation_path(conversation_id).exists():
                return conversation_id
            new_id = conversation_id or str(uuid4())
            conversation = self._base_conversation(new_id, title)
            self._write_conversation(conversation)
            return new_id

    def create(self, *, title: Optional[str] = None) -> Dict[str, Any]:
        conversation_id = self.ensure(None, title=title)
        return self.get(conversation_id) or {}

    def list_conversations(self) -> List[Dict[str, Any]]:
        summaries: List[Dict[str, Any]] = []
        with self._lock:
            for path in self.storage_dir.glob("*.json"):
                data = self._read_conversation(path)
                if not data:
                    continue
                messages = data.get("messages", [])
                last_content = messages[-1]["content"] if messages else None
                summaries.append(
                    {
                        "id": data["id"],
                        "title": data.get("title") or self._default_title(data["id"]),
                        "created_at": data.get("created_at"),
                        "updated_at": data.get("updated_at"),
                        "message_count": len(messages),
                        "last_message_preview": (last_content or "")[:160] if last_content else None,
                        "active_agents": list(data.get("active_agents") or []),
                    }
                )
        summaries.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
        return summaries

    def get(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            path = self._conversation_path(conversation_id)
            if not path.exists():
                return None
            data = self._read_conversation(path)
            if data and self.max_turns and len(data.get("messages", [])) > self.max_turns:
                data["messages"] = data["messages"][-self.max_turns :]
            return data

    def rename(self, conversation_id: str, title: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            conversation = self.get(conversation_id)
            if not conversation:
                return None
            conversation["title"] = title.strip() or conversation.get("title") or self._default_title(conversation_id)
            conversation["updated_at"] = self._timestamp()
            self._write_conversation(conversation)
            return conversation

    def delete(self, conversation_id: str) -> bool:
        with self._lock:
            path = self._conversation_path(conversation_id)
            if not path.exists():
                return False
            try:
                path.unlink()
            except OSError:
                return False
            return True

    def append(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        name: Optional[str] = None,
        speaker_id: Optional[str] = None,
        message_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            conversation = self.get(conversation_id)
            if not conversation:
                self.ensure(conversation_id)
                conversation = self.get(conversation_id) or {}
            message = {
                "id": message_id or str(uuid4()),
                "role": role,
                "name": name,
                "speaker_id": speaker_id,
                "content": content,
                "timestamp": self._timestamp(),
            }
            messages = conversation.setdefault("messages", [])
            messages.append(message)
            if self.max_turns and len(messages) > self.max_turns:
                conversation["messages"] = messages[-self.max_turns :]
            conversation["updated_at"] = self._timestamp()
            self._write_conversation(conversation)
            return message

    def history(self, conversation_id: str) -> List[Dict[str, Any]]:
        conversation = self.get(conversation_id)
        if not conversation:
            return []
        return list(conversation.get("messages", []))

    def get_active_agents(self, conversation_id: str) -> List[str]:
        conversation = self.get(conversation_id)
        if not conversation:
            return []
        return list(conversation.get("active_agents") or [])

    def set_active_agents(self, conversation_id: str, agent_ids: List[str]) -> Optional[Dict[str, Any]]:
        with self._lock:
            conversation = self.get(conversation_id)
            if not conversation:
                return None
            cleaned = [agent_id.strip() for agent_id in agent_ids if agent_id and agent_id.strip()]
            conversation["active_agents"] = cleaned
            conversation["updated_at"] = self._timestamp()
            self._write_conversation(conversation)
            return conversation

    def _base_conversation(self, conversation_id: str, title: Optional[str] = None) -> Dict[str, Any]:
        now = self._timestamp()
        return {
            "id": conversation_id,
            "title": title or self._default_title(conversation_id),
            "created_at": now,
            "updated_at": now,
            "messages": [],
            "active_agents": [],
        }

    def _conversation_path(self, conversation_id: str) -> Path:
        safe = conversation_id.replace("/", "_").replace("\\", "_")
        while ".." in safe:
            safe = safe.replace("..", "_")
        return self.storage_dir / f"{safe}.json"

    def _read_conversation(self, path: Path) -> Optional[Dict[str, Any]]:
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            return None

    def _write_conversation(self, data: Dict[str, Any]) -> None:
        path = self._conversation_path(data["id"])
        path.write_text(json.dumps(data, indent=2))

    def _default_title(self, conversation_id: str) -> str:
        return f"Conversation {conversation_id[:8]}"

    def _timestamp(self) -> str:
        return datetime.now(timezone.utc).isoformat()
