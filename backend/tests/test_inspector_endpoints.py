import importlib
import json
from pathlib import Path
from typing import Tuple

import pytest
from fastapi.testclient import TestClient

from backend import settings as settings_module


@pytest.fixture()
def test_app(tmp_path, monkeypatch) -> Tuple[TestClient, object]:
    env_map = {
        "STREAMING_LLM_AGENTS_DIR": tmp_path / "agents",
        "STREAMING_LLM_CONVERSATIONS_DIR": tmp_path / "conversations",
        "STREAMING_LLM_PLAYBOOKS_DIR": tmp_path / "playbooks",
        "STREAMING_LLM_AGENT_STATE_DIR": tmp_path / "agent_state",
        "STREAMING_LLM_LOGS_DIR": tmp_path / "logs",
    }
    for env, path in env_map.items():
        path.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv(env, str(path))
    global_playbook_path = tmp_path / "global_playbook.json"
    monkeypatch.setenv("STREAMING_LLM_GLOBAL_PLAYBOOK", str(global_playbook_path))

    settings_module.get_settings.cache_clear()
    server_module = importlib.import_module("backend.server")
    server = importlib.reload(server_module)
    client = TestClient(server.app)
    try:
        yield client, server
    finally:
        client.close()


def test_agent_state_endpoint_returns_local_memory_and_metadata(test_app):
    client, server = test_app
    agent = server.agent_store.get_agent("planner")
    assert agent is not None

    state_path = server.ace_bridge.agent_state_dir / f"{agent.id}.json"
    payload = {
        "local_memory": {
            "summary": "Remember focus",
            "recent_messages": [
                {
                    "conversation_id": "abc",
                    "user": "Hello",
                    "agent": "Hi",
                    "timestamp": "2024-01-01T00:00:00Z",
                }
            ],
        },
        "logs": [
            {
                "timestamp": "2024-01-01T00:00:00Z",
                "event": "turn",
                "summary": "Sample",
            }
        ],
    }
    state_path.write_text(json.dumps(payload))

    response = client.get(f"/agents/{agent.id}/state")
    assert response.status_code == 200
    data = response.json()

    assert data["agent_id"] == agent.id
    assert data["name"] == agent.name
    assert data["system_prompt"] == agent.system_prompt
    assert data["local_memory"]["summary"] == "Remember focus"
    assert "global_memory" in data
    assert "playbook" in data


def test_conversation_state_endpoint_includes_timeline_and_memory(test_app):
    client, server = test_app
    conversation = server.conversation_manager.create(title="Inspectable")
    conversation_id = conversation["id"]
    server.conversation_manager.append(
        conversation_id,
        role="PERSON",
        content="User turn",
        name="Tester",
        speaker_id="user-1",
    )
    server.conversation_manager.record_memory(
        conversation_id,
        summary="Keep critical context",
        distilled="Snapshot 1",
    )
    server.conversation_manager.record_event(
        conversation_id,
        {"type": "diagnostic", "content": "ACE reflection"},
    )

    response = client.get(f"/conversations/{conversation_id}/state")
    assert response.status_code == 200
    data = response.json()

    assert data["id"] == conversation_id
    assert data["memory"]["summary"] == "Keep critical context"
    assert any(item.get("type") == "diagnostic" for item in data["timeline"])
    assert "global_playbook" in data


def test_reset_agent_playbook_endpoint_clears_bullets(test_app):
    client, server = test_app
    agent = server.agent_store.get_agent("planner")
    assert agent is not None

    playbook = server.ace_bridge._load_agent_playbook(agent.id)
    playbook.add_bullet(section="test", content="Always cite sources")
    server.ace_bridge._save_playbook(agent.id, playbook)

    before = server.ace_bridge.get_agent_playbook_payload(agent.id)
    assert before["playbook"]["bullets"]

    response = client.delete(f"/agents/{agent.id}/playbook")
    assert response.status_code == 200
    after = server.ace_bridge.get_agent_playbook_payload(agent.id)
    assert after["playbook"]["bullets"] == []
