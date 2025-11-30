from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional


@dataclass
class PromptSections:
    system_prompt: str
    agent_markdown: Optional[str]
    agent_playbook: Optional[str]
    global_playbook: Optional[str]
    conversation_memory: Optional[str]
    inter_agent_context: Optional[str]
    user_name: Optional[str]
    user_role: str
    user_id: Optional[str]
    user_message: str


class PromptComposer:
    """Deterministically composes the multi-section prompt required by ACE."""

    LABEL_SYSTEM = "SYSTEM PROMPT"
    LABEL_AGENT_MD = "AGENT MARKDOWN"
    LABEL_AGENT_PLAYBOOK = "AGENT PLAYBOOK"
    LABEL_GLOBAL_PLAYBOOK = "GLOBAL PLAYBOOK"
    LABEL_CONVERSATION = "CONVERSATION MEMORY"
    LABEL_INTER_AGENT = "INTER-AGENT CONTEXT"
    LABEL_USER_MESSAGE = "USER MESSAGE"

    def compose(self, sections: PromptSections) -> str:
        ordered: List[str] = []
        ordered.append(self._wrap(self.LABEL_SYSTEM, sections.system_prompt))
        if sections.agent_markdown:
            ordered.append(self._wrap(self.LABEL_AGENT_MD, sections.agent_markdown))
        if sections.agent_playbook:
            ordered.append(self._wrap(self.LABEL_AGENT_PLAYBOOK, sections.agent_playbook))
        if sections.global_playbook:
            ordered.append(self._wrap(self.LABEL_GLOBAL_PLAYBOOK, sections.global_playbook))
        if sections.conversation_memory:
            ordered.append(self._wrap(self.LABEL_CONVERSATION, sections.conversation_memory))
        if sections.inter_agent_context:
            ordered.append(self._wrap(self.LABEL_INTER_AGENT, sections.inter_agent_context))

        user_label = self._format_user_label(
            sections.user_role,
            sections.user_name,
            sections.user_id,
        )
        ordered.append(
            self._wrap(
                self.LABEL_USER_MESSAGE,
                f"{user_label}:\n{sections.user_message.strip()}".strip(),
            )
        )
        return "\n\n".join(part for part in ordered if part)

    @staticmethod
    def _wrap(label: str, content: str) -> str:
        clean = (content or "").strip()
        if not clean:
            return ""
        return f"[{label}]\n{clean.strip()}"

    @staticmethod
    def _format_user_label(role: str, name: Optional[str], user_id: Optional[str]) -> str:
        clean_role = (role or "PERSON").strip().upper()
        suffix_parts: List[str] = []
        if name:
            suffix_parts.append(name.strip())
        if user_id and user_id not in suffix_parts:
            suffix_parts.append(user_id)
        if suffix_parts:
            return f"{clean_role} ({' / '.join(suffix_parts)})"
        return clean_role


def build_prompt(**kwargs: object) -> str:
    """Helper for legacy call sites that prefer a function API."""
    composer = PromptComposer()
    return composer.compose(PromptSections(**kwargs))
