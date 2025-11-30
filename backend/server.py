from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .agent_store import AgentStore
from .conversation_events import ConversationEventBus
from .conversation_manager import ConversationManager
from .conversation_orchestrator import ConversationOrchestrator
from .model_engine import StreamingLLMEngine
from .settings import get_settings
from .ace_bridge import ACEBridge


class StreamCancelled(Exception):
    """Raised when a client disconnects during streaming."""

settings = get_settings()
agent_store = AgentStore(settings.agents_dir)
conversation_manager = ConversationManager(
    settings.conversations_dir,
    max_turns=settings.conversation_max_turns,
)
ace_bridge = ACEBridge(settings, conversation_manager)
event_bus = ConversationEventBus()
engine: Optional[StreamingLLMEngine] = None
orchestrator: Optional[ConversationOrchestrator] = None


def get_engine() -> StreamingLLMEngine:
    global engine
    if engine is None:
        engine = StreamingLLMEngine(settings)
    return engine


def get_orchestrator() -> ConversationOrchestrator:
    global orchestrator
    if orchestrator is None:
        orchestrator = ConversationOrchestrator(
            conversation_manager,
            agent_store,
            event_bus,
            get_engine(),
            ace_bridge,
        )
    return orchestrator


class AgentPayload(BaseModel):
    id: str
    name: str
    system_prompt: str
    markdown_context: str


class AgentUpdateRequest(BaseModel):
    name: str
    system_prompt: str
    markdown_context: str


class AgentListResponse(BaseModel):
    agents: list[AgentPayload]


class ConversationMessagePayload(BaseModel):
    id: str
    role: str
    content: str
    name: Optional[str] = None
    speaker_id: Optional[str] = None
    timestamp: Optional[str] = None


class ConversationSummaryPayload(BaseModel):
    id: str
    title: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    message_count: int
    last_message_preview: Optional[str] = None
    active_agents: List[str] = Field(default_factory=list)


class ConversationDetailPayload(ConversationSummaryPayload):
    messages: List[ConversationMessagePayload]


class ConversationCreateRequest(BaseModel):
    title: Optional[str] = None


class ConversationUpdateRequest(BaseModel):
    title: Optional[str] = None


class ConversationMessageRequest(BaseModel):
    content: str
    speaker_role: Optional[str] = None
    speaker_name: Optional[str] = None
    speaker_id: Optional[str] = None


class ConversationAgentUpdateRequest(BaseModel):
    active_agent_ids: List[str]


app = FastAPI(title="StreamingLLM Multi-Agent Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger(__name__)


@app.get("/healthz")
def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/agents", response_model=AgentListResponse)
def list_agents() -> AgentListResponse:
    agents = [AgentPayload(**agent.to_dict()) for agent in agent_store.list_agents()]
    return AgentListResponse(agents=agents)


@app.get("/agents/{agent_id}", response_model=AgentPayload)
def get_agent(agent_id: str) -> AgentPayload:
    agent = agent_store.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return AgentPayload(**agent.to_dict())


@app.put("/agents/{agent_id}", response_model=AgentPayload)
def upsert_agent(agent_id: str, payload: AgentUpdateRequest) -> AgentPayload:
    clean_id = agent_id.strip()
    if not clean_id:
        raise HTTPException(status_code=400, detail="Agent id cannot be blank")
    agent = agent_store.save_agent(
        agent_id=clean_id,
        name=payload.name.strip() or clean_id,
        system_prompt=payload.system_prompt.strip(),
        markdown_context=payload.markdown_context,
    )
    return AgentPayload(**agent.to_dict())


@app.get("/conversations", response_model=List[ConversationSummaryPayload])
def list_conversations() -> List[ConversationSummaryPayload]:
    summaries = conversation_manager.list_conversations()
    return [_serialize_conversation_summary(item) for item in summaries]


@app.post("/conversations", response_model=ConversationDetailPayload)
def create_conversation(payload: ConversationCreateRequest) -> ConversationDetailPayload:
    conversation = conversation_manager.create(title=payload.title)
    return _serialize_conversation_detail(conversation)


@app.get("/conversations/{conversation_id}", response_model=ConversationDetailPayload)
def get_conversation(conversation_id: str) -> ConversationDetailPayload:
    conversation = conversation_manager.get(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _serialize_conversation_detail(conversation)


@app.put("/conversations/{conversation_id}", response_model=ConversationDetailPayload)
def rename_conversation(
    conversation_id: str, payload: ConversationUpdateRequest
) -> ConversationDetailPayload:
    conversation = conversation_manager.rename(conversation_id, payload.title or "")
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _serialize_conversation_detail(conversation)


@app.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str) -> Dict[str, str]:
    deleted = conversation_manager.delete(conversation_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"status": "deleted"}


@app.post(
    "/conversations/{conversation_id}/messages",
    response_model=ConversationMessagePayload,
)
async def post_conversation_message(
    conversation_id: str, payload: ConversationMessageRequest
) -> ConversationMessagePayload:
    conversation = conversation_manager.get(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message content cannot be blank")
    role = (payload.speaker_role or "PERSON").strip().upper() or "PERSON"
    message = conversation_manager.append(
        conversation_id,
        role,
        content,
        name=payload.speaker_name,
        speaker_id=payload.speaker_id,
        message_id=str(uuid4()),
    )
    await event_bus.broadcast(
        conversation_id,
        {
            "type": "message_appended",
            "conversation_id": conversation_id,
            "message": _serialize_message(message).dict(),
        },
    )
    await get_orchestrator().handle_new_message(conversation_id, message)
    return _serialize_message(message)


@app.put(
    "/conversations/{conversation_id}/active_agents",
    response_model=ConversationDetailPayload,
)
async def update_conversation_agents(
    conversation_id: str,
    payload: ConversationAgentUpdateRequest,
) -> ConversationDetailPayload:
    updated = conversation_manager.set_active_agents(
        conversation_id, payload.active_agent_ids
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _serialize_conversation_detail(updated)


@app.websocket("/ws/conversations/{conversation_id}")
async def conversation_events(websocket: WebSocket, conversation_id: str) -> None:
    await websocket.accept()
    if not conversation_manager.get(conversation_id):
        await websocket.send_text(
            json.dumps({"type": "error", "message": "Conversation not found"})
        )
        await websocket.close()
        return
    await event_bus.subscribe(conversation_id, websocket)
    await websocket.send_text(
        json.dumps({"type": "ready", "conversation_id": conversation_id})
    )
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await event_bus.unsubscribe(conversation_id, websocket)


@app.websocket("/ws/chat")
async def chat(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        raw = await websocket.receive_text()
    except WebSocketDisconnect:
        return
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        await _send_ws_error(websocket, "Invalid JSON")
        await websocket.close()
        return
    required = {"agent_id", "user_message"}
    if not required.issubset(payload.keys()):
        await _send_ws_error(websocket, "Missing required fields")
        await websocket.close()
        return
    agent_id = payload["agent_id"]
    user_message = str(payload["user_message"]).strip()
    options: Dict[str, Any] = payload.get("options") or {}
    agent = agent_store.get_agent(agent_id)
    if not agent:
        await _send_ws_error(websocket, f"Agent {agent_id} not found")
        await websocket.close()
        return
    try:
        conversation_id = conversation_manager.ensure(payload.get("conversation_id"))
        history = conversation_manager.history(conversation_id)
        speaker_role_raw = str(payload.get("speaker_role") or "").strip()
        speaker_role = (speaker_role_raw or "PERSON").upper()
        speaker_name = str(payload.get("speaker_name") or "User").strip() or "User"
        speaker_id = str(payload.get("speaker_id") or "person-local").strip() or "person-local"
        skip_user_append = _as_bool(payload.get("skip_user_append"))
        prompt_from_latest = _as_bool(payload.get("prompt_from_latest"))

        if user_message and not skip_user_append:
            conversation_manager.append(
                conversation_id,
                speaker_role,
                user_message,
                name=speaker_name,
                speaker_id=speaker_id,
            )

        effective_message = user_message
        effective_role = speaker_role
        effective_name = speaker_name
        effective_id = speaker_id
        if prompt_from_latest and history:
            latest = history[-1]
            effective_message = latest.get("content", "")
            effective_role = str(latest.get("role") or effective_role).upper()
            effective_name = latest.get("name") or latest.get("speaker_name") or effective_name
            effective_id = latest.get("speaker_id") or effective_id

        prompt = ace_bridge.build_prompt(
            agent=agent,
            conversation_id=conversation_id,
            history=history,
            user_message=effective_message,
            speaker_role=effective_role,
            speaker_name=effective_name,
            speaker_id=effective_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to prepare chat session")
        await _send_ws_error(websocket, f"Backend error: {exc}")
        await websocket.close()
        return
    assistant_chunks: list[str] = []
    cancelled = False
    loop = asyncio.get_running_loop()

    def send_event(event: Dict[str, Any]) -> None:
        event.setdefault("conversation_id", conversation_id)
        try:
            asyncio.run_coroutine_threadsafe(
                websocket.send_text(json.dumps(event)),
                loop,
            ).result()
        except WebSocketDisconnect as exc:
            raise StreamCancelled from exc
        except RuntimeError as exc:
            raise StreamCancelled from exc

    def run_generation() -> None:
        nonlocal cancelled
        try:
            for token in get_engine().stream(
                prompt=prompt,
                temperature=_safe_float(options.get("temperature")),
                max_new_tokens=_safe_int(options.get("max_new_tokens")),
            ):
                assistant_chunks.append(token)
                send_event({"type": "token", "token": token})
            send_event({"type": "done"})
        except StreamCancelled:
            cancelled = True
        except Exception as exc:  # noqa: BLE001 - surface model errors
            send_event({"type": "error", "message": str(exc)})

    await loop.run_in_executor(None, run_generation)
    assistant_text = "".join(assistant_chunks).strip()
    if assistant_text and not cancelled:
        conversation_manager.append(
            conversation_id,
            "AGENT",
            assistant_text,
            name=agent.name,
            speaker_id=agent.id,
        )
        ace_bridge.schedule_learning(
            agent=agent,
            conversation_id=conversation_id,
            user_message=effective_message,
            agent_response=assistant_text,
            prompt=prompt,
            diagnostics={
                "temperature": _safe_float(options.get("temperature")),
                "max_new_tokens": _safe_int(options.get("max_new_tokens")),
            },
        )
    if not cancelled:
        await websocket.close()


@app.get("/agents/{agent_id}/state")
def inspect_agent(agent_id: str) -> Dict[str, Any]:
    state = ace_bridge.get_agent_state(agent_id)
    if not state:
        raise HTTPException(status_code=404, detail="Agent state not found")
    agent = agent_store.get_agent(agent_id)
    if agent:
        state["system_prompt"] = agent.system_prompt
        state["markdown_context"] = agent.markdown_context
        state["name"] = agent.name
    return state


@app.get("/agents/{agent_id}/playbook")
def get_agent_playbook_state(agent_id: str) -> Dict[str, Any]:
    if not agent_store.get_agent(agent_id):
        raise HTTPException(status_code=404, detail="Agent not found")
    return ace_bridge.get_agent_playbook_payload(agent_id)


@app.delete("/agents/{agent_id}/playbook")
def reset_agent_playbook(agent_id: str) -> Dict[str, str]:
    if not agent_store.get_agent(agent_id):
        raise HTTPException(status_code=404, detail="Agent not found")
    ace_bridge.reset_agent_playbook(agent_id)
    return {"status": "cleared"}


@app.get("/conversations/{conversation_id}/state")
def inspect_conversation(conversation_id: str) -> Dict[str, Any]:
    state = ace_bridge.get_conversation_state(conversation_id)
    if not state:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return state


@app.get("/playbooks/global")
def get_global_playbook() -> Dict[str, Any]:
    return ace_bridge.get_global_playbook_state()


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(value, (int, float)):
        return value != 0
    return False


async def _send_ws_error(websocket: WebSocket, message: str) -> None:
    try:
        await websocket.send_text(json.dumps({"type": "error", "message": message}))
    except Exception:  # noqa: BLE001
        logger.debug("Unable to send websocket error message", exc_info=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.server:app", host="0.0.0.0", port=8000, reload=False)


def _serialize_conversation_summary(data: Dict[str, Any]) -> ConversationSummaryPayload:
    messages = data.get("messages") or []
    raw_count = data.get("message_count")
    message_count = int(raw_count) if raw_count is not None else len(messages)
    preview = data.get("last_message_preview")
    if not preview and messages:
        preview = messages[-1].get("content", "")[:160]
    return ConversationSummaryPayload(
        id=data["id"],
        title=data.get("title") or f"Conversation {data['id'][:8]}",
        created_at=data.get("created_at"),
        updated_at=data.get("updated_at"),
        message_count=message_count,
        last_message_preview=preview,
        active_agents=list(data.get("active_agents") or []),
    )


def _serialize_conversation_detail(data: Dict[str, Any]) -> ConversationDetailPayload:
    messages = data.get("messages", [])
    summary = _serialize_conversation_summary(
        {
            **data,
            "message_count": len(messages),
            "last_message_preview": (messages[-1]["content"][:160] if messages else None),
        }
    )
    return ConversationDetailPayload(
        **summary.dict(),
        messages=[_serialize_message(message) for message in messages],
    )


def _serialize_message(message: Dict[str, Any]) -> ConversationMessagePayload:
    return ConversationMessagePayload(
        id=message.get("id") or str(uuid4()),
        role=message.get("role", ""),
        content=message.get("content", ""),
        name=message.get("name"),
        speaker_id=message.get("speaker_id"),
        timestamp=message.get("timestamp"),
    )
