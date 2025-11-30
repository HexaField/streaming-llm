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

export function streamChat({
  backendUrl,
  agentId,
  conversationId,
  message,
  options,
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
