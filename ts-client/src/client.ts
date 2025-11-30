export type ChatOptions = {
  temperature?: number;
  maxNewTokens?: number;
};

export type ChatEvent =
  | { type: "token"; token: string; conversationId?: string }
  | { type: "done"; conversationId?: string }
  | { type: "error"; message: string; conversationId?: string };

export type StreamChatParams = {
  backendUrl: string;
  agentId: string;
  conversationId?: string;
  message: string;
  options?: ChatOptions;
  speakerRole?: string;
  speakerName?: string;
  speakerId?: string;
  skipUserAppend?: boolean;
  promptFromLatest?: boolean;
  onEvent: (event: ChatEvent) => void;
  socketFactory?: (url: string) => WebSocket;
};

export interface Agent {
  id: string;
  name: string;
  system_prompt: string;
  markdown_context: string;
}

export interface AgentUpdateRequest {
  id: string;
  name: string;
  system_prompt: string;
  markdown_context: string;
}

export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  name?: string;
  speaker_id?: string;
  timestamp?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  message_count: number;
  last_message_preview?: string;
  active_agents: string[];
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
}

export interface ConversationMessageRequest {
  content: string;
  speaker_role?: string;
  speaker_name?: string;
  speaker_id?: string;
}

export function streamChat({
  backendUrl,
  agentId,
  conversationId,
  message,
  options,
  speakerRole,
  speakerName,
  speakerId,
  skipUserAppend,
  promptFromLatest,
  onEvent,
  socketFactory,
}: StreamChatParams): () => void {
  const socket = socketFactory ? socketFactory(backendUrl) : defaultSocketFactory(backendUrl);
  let isClosed = false;

  socket.onopen = () => {
    const payload = {
      agent_id: agentId,
      conversation_id: conversationId,
      user_message: message,
      options,
      speaker_role: speakerRole,
      speaker_name: speakerName,
      speaker_id: speakerId,
      skip_user_append: skipUserAppend,
      prompt_from_latest: promptFromLatest,
    };
    socket.send(JSON.stringify(payload));
  };

  socket.onmessage = (event: MessageEvent) => {
    try {
      const data = parseJson(event.data);
      const conversation = data.conversation_id ?? data.conversationId;
      if (data.type === "token") {
        onEvent({ type: "token", token: data.token ?? "", conversationId: conversation });
      } else if (data.type === "done") {
        onEvent({ type: "done", conversationId: conversation });
      } else if (data.type === "error") {
        onEvent({ type: "error", message: data.message ?? "Unknown error", conversationId: conversation });
      }
    } catch (err) {
      onEvent({ type: "error", message: (err as Error).message });
    }
  };

  socket.onerror = () => {
    onEvent({ type: "error", message: "WebSocket error" });
  };

  socket.onclose = () => {
    isClosed = true;
  };

  return () => {
    if (!isClosed) {
      socket.close();
      isClosed = true;
    }
  };
}

export async function listAgents(apiBase = "http://localhost:8000"): Promise<Agent[]> {
  const res = await fetch(`${apiBase}/agents`);
  await ensureOk(res);
  const payload = await res.json();
  return payload.agents;
}

export async function getAgent(agentId: string, apiBase = "http://localhost:8000"): Promise<Agent> {
  const res = await fetch(`${apiBase}/agents/${agentId}`);
  await ensureOk(res);
  return res.json();
}

export async function updateAgent(
  agent: AgentUpdateRequest,
  apiBase = "http://localhost:8000"
): Promise<Agent> {
  const res = await fetch(`${apiBase}/agents/${agent.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: agent.name,
      system_prompt: agent.system_prompt,
      markdown_context: agent.markdown_context,
    }),
  });
  await ensureOk(res);
  return res.json();
}

export async function listConversations(apiBase = "http://localhost:8000"): Promise<ConversationSummary[]> {
  const res = await fetch(`${apiBase}/conversations`);
  await ensureOk(res);
  return res.json();
}

export async function createConversation(
  payload: { title?: string } = {},
  apiBase = "http://localhost:8000"
): Promise<ConversationDetail> {
  const res = await fetch(`${apiBase}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await ensureOk(res);
  return res.json();
}

export async function getConversation(
  conversationId: string,
  apiBase = "http://localhost:8000"
): Promise<ConversationDetail> {
  const res = await fetch(`${apiBase}/conversations/${conversationId}`);
  await ensureOk(res);
  return res.json();
}

export async function renameConversation(
  conversationId: string,
  payload: { title?: string },
  apiBase = "http://localhost:8000"
): Promise<ConversationDetail> {
  const res = await fetch(`${apiBase}/conversations/${conversationId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await ensureOk(res);
  return res.json();
}

export async function deleteConversation(conversationId: string, apiBase = "http://localhost:8000"): Promise<void> {
  const res = await fetch(`${apiBase}/conversations/${conversationId}`, {
    method: "DELETE",
  });
  await ensureOk(res);
}

export async function sendConversationMessage(
  conversationId: string,
  payload: ConversationMessageRequest,
  apiBase = "http://localhost:8000"
): Promise<ConversationMessage> {
  const res = await fetch(`${apiBase}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await ensureOk(res);
  return res.json();
}

export async function updateConversationAgents(
  conversationId: string,
  agentIds: string[],
  apiBase = "http://localhost:8000"
): Promise<ConversationDetail> {
  const res = await fetch(`${apiBase}/conversations/${conversationId}/active_agents`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active_agent_ids: agentIds }),
  });
  await ensureOk(res);
  return res.json();
}

function defaultSocketFactory(url: string): WebSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error("Global WebSocket is not available. Provide socketFactory when using Node.js.");
  }
  return new WebSocket(url);
}

function parseJson(value: unknown): any {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

async function ensureOk(res: Response): Promise<void> {
  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || `HTTP ${res.status}`);
  }
}
