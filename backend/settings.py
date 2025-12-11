from functools import lru_cache
from pathlib import Path
import os
from pydantic import BaseModel


DEFAULT_AGENTS_DIR = Path("agents")
DEFAULT_CONVERSATIONS_DIR = Path("conversations")
DEFAULT_PLAYBOOKS_DIR = Path("playbooks")
DEFAULT_AGENT_STATE_DIR = Path("agent_state")
DEFAULT_LOGS_DIR = Path("logs")
DEFAULT_GLOBAL_PLAYBOOK = Path("global_playbook.json")


class Settings(BaseModel):
    model_name_or_path: str = os.environ.get(
        "STREAMING_LLM_MODEL", "llama3.2:latest"
    )
    enable_streaming: bool = os.environ.get("STREAMING_LLM_ENABLE", "1") == "1"
    start_size: int = int(os.environ.get("STREAMING_LLM_START_SIZE", "4"))
    recent_size: int = int(os.environ.get("STREAMING_LLM_RECENT_SIZE", "2048"))
    agents_dir: Path = Path(
        os.environ.get("STREAMING_LLM_AGENTS_DIR") or DEFAULT_AGENTS_DIR
    )
    conversations_dir: Path = Path(
        os.environ.get("STREAMING_LLM_CONVERSATIONS_DIR") or DEFAULT_CONVERSATIONS_DIR
    )
    playbooks_dir: Path = Path(
        os.environ.get("STREAMING_LLM_PLAYBOOKS_DIR") or DEFAULT_PLAYBOOKS_DIR
    )
    agent_state_dir: Path = Path(
        os.environ.get("STREAMING_LLM_AGENT_STATE_DIR") or DEFAULT_AGENT_STATE_DIR
    )
    logs_dir: Path = Path(
        os.environ.get("STREAMING_LLM_LOGS_DIR") or DEFAULT_LOGS_DIR
    )
    global_playbook_path: Path = Path(
        os.environ.get("STREAMING_LLM_GLOBAL_PLAYBOOK") or DEFAULT_GLOBAL_PLAYBOOK
    )
    conversation_max_turns: int = int(
        os.environ.get("STREAMING_LLM_CONVERSATION_MAX_TURNS", "200")
    )
    max_new_tokens: int = int(os.environ.get("STREAMING_LLM_MAX_NEW_TOKENS", "512"))
    ollama_base_url: str = os.environ.get(
        "STREAMING_LLM_OLLAMA_URL", "http://127.0.0.1:11434"
    )
    ace_model: str = os.environ.get("STREAMING_LLM_ACE_MODEL", "gpt-4o-mini")
    ace_max_tokens: int = int(os.environ.get("STREAMING_LLM_ACE_MAX_TOKENS", "2048"))
    ace_learning_enabled: bool = (
        os.environ.get("STREAMING_LLM_ACE_LEARNING_ENABLED", "1") == "1"
    )


@lru_cache()
def get_settings() -> Settings:
    return Settings()
