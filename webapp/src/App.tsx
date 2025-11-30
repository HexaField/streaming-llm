import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import clsx from "clsx";
import {
  listAgents,
  streamChat,
  updateAgent,
  type Agent,
  type ChatEvent,
} from "@ts-client/client";

const HTTP_BASE = import.meta.env.VITE_BACKEND_HTTP ?? "http://localhost:8000";
const WS_URL = import.meta.env.VITE_BACKEND_WS ?? "ws://localhost:8000/ws/chat";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  status?: "done" | "error";
};

type ConversationState = {
  conversationId?: string;
  messages: ChatMessage[];
};

const randomId = () => Math.random().toString(36).slice(2);

const App = () => {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = createSignal<string>();
  const [draftAgents, setDraftAgents] = createStore<Record<string, Agent>>({});
  const [conversations, setConversations] = createSignal<Record<string, ConversationState>>({});
  const [messageInput, setMessageInput] = createSignal("");
  const [temperature, setTemperature] = createSignal(0.2);
  const [chatError, setChatError] = createSignal<string | null>(null);
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null);
  const [isSavingAgent, setIsSavingAgent] = createSignal(false);
  const [loadingAgents, setLoadingAgents] = createSignal(false);
  const [activeStream, setActiveStream] = createSignal<
    | {
        agentId: string;
        messageId: string;
        cancel: () => void;
      }
    | null
  >(null);

  const selectedAgent = () => agents().find((agent: Agent) => agent.id === selectedAgentId());

  const selectedConversation = () => {
    const agentId = selectedAgentId();
    if (!agentId) {
      return { messages: [] } satisfies ConversationState;
    }
    return conversations()[agentId] ?? { messages: [] };
  };

  onMount(() => {
    refreshAgents();
  });

  createEffect(() => {
    const agent = selectedAgent();
    if (agent && !draftAgents[agent.id]) {
      setDraftAgents(agent.id, { ...agent });
    }
  });

  async function refreshAgents() {
    setLoadingAgents(true);
    try {
      const result: Agent[] = await listAgents(HTTP_BASE);
      setAgents(result);
      if (!selectedAgentId() && result.length) {
        setSelectedAgentId(result[0].id);
      }
      result.forEach((agent: Agent) => setDraftAgents(agent.id, { ...agent }));
      setStatusMessage(null);
    } catch (err) {
      setStatusMessage(`Failed to load agents: ${(err as Error).message}`);
    } finally {
      setLoadingAgents(false);
    }
  }

  function handleDraftChange(field: keyof Agent, value: string) {
    const agentId = selectedAgentId();
    if (!agentId) return;
    const fallback =
      draftAgents[agentId] ??
      selectedAgent() ?? {
        id: agentId,
        name: "",
        system_prompt: "",
        markdown_context: "",
      };
    setDraftAgents(agentId, {
      ...fallback,
      [field]: value,
    } as Agent);
  }

  async function handleSaveAgent() {
    const agentId = selectedAgentId();
    if (!agentId) return;
    const draft = draftAgents[agentId];
    if (!draft) return;
    setIsSavingAgent(true);
    setStatusMessage("Saving agent...");
    try {
      const updated = await updateAgent(draft, HTTP_BASE);
      setAgents((prev: Agent[]) => {
        const existingIndex = prev.findIndex((item: Agent) => item.id === updated.id);
        if (existingIndex >= 0) {
          const clone = [...prev];
          clone[existingIndex] = updated;
          return clone;
        }
        return [...prev, updated];
      });
      setDraftAgents(updated.id, { ...updated });
      setStatusMessage("Agent saved");
    } catch (err) {
      setStatusMessage(`Save failed: ${(err as Error).message}`);
    } finally {
      setIsSavingAgent(false);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }

  function handleCreateAgent() {
    const id = `agent-${Date.now().toString(36)}`;
    const template: Agent = {
      id,
      name: "New Agent",
      system_prompt: "You are a helpful collaborator.",
      markdown_context: "# Context\n- Add markdown knowledge here.\n",
    };
    setAgents((prev: Agent[]) => [...prev, template]);
    setDraftAgents(id, { ...template });
    setSelectedAgentId(id);
    setStatusMessage("New agent ready. Save to persist.");
  }

  function updateConversation(agentId: string, builder: (state: ConversationState) => ConversationState) {
    setConversations((prev: Record<string, ConversationState>) => {
      const current = prev[agentId] ?? { messages: [] };
      const nextState = builder({
        conversationId: current.conversationId,
        messages: [...current.messages],
      });
      return { ...prev, [agentId]: nextState };
    });
  }

  function appendMessages(agentId: string, ...messages: ChatMessage[]) {
    updateConversation(agentId, (state) => ({
      conversationId: state.conversationId,
      messages: [...state.messages, ...messages],
    }));
  }

  function mutateMessage(agentId: string, messageId: string, transform: (message: ChatMessage) => ChatMessage) {
    updateConversation(agentId, (state) => ({
      ...state,
      messages: state.messages.map((message) =>
        message.id === messageId ? transform(message) : message
      ),
    }));
  }

  function setConversationId(agentId: string, conversationId: string | undefined) {
    updateConversation(agentId, (state) => ({
      ...state,
      conversationId: conversationId ?? state.conversationId,
    }));
  }

  function finalizeAssistant(agentId: string, messageId: string, isError = false) {
    mutateMessage(agentId, messageId, (message) => ({
      ...message,
      streaming: false,
      status: isError ? "error" : "done",
    }));
  }

  function handleChatEvent(agentId: string, messageId: string, event: ChatEvent) {
    if (event.conversationId) {
      setConversationId(agentId, event.conversationId);
    }
    if (event.type === "token") {
      mutateMessage(agentId, messageId, (message) => ({
        ...message,
        content: message.content + event.token,
      }));
    }
    if (event.type === "done") {
      finalizeAssistant(agentId, messageId);
      setActiveStream(null);
    }
    if (event.type === "error") {
      setChatError(event.message);
      finalizeAssistant(agentId, messageId, true);
      setActiveStream(null);
    }
  }

  function stopActiveStream(markError = false) {
    const stream = activeStream();
    if (!stream) return;
    stream.cancel();
    if (markError) {
      finalizeAssistant(stream.agentId, stream.messageId, true);
    }
    setActiveStream(null);
  }

  function handleClearConversation() {
    const agentId = selectedAgentId();
    if (!agentId) return;
    stopActiveStream(true);
    setConversations((prev: Record<string, ConversationState>) => ({
      ...prev,
      [agentId]: { messages: [] },
    }));
  }

  function handleSendMessage() {
    const agent = selectedAgent();
    const text = messageInput().trim();
    if (!agent || !text) return;
    setChatError(null);
    stopActiveStream(false);
    const userMessage: ChatMessage = { id: randomId(), role: "user", content: text };
    const assistantId = randomId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      streaming: true,
    };
    appendMessages(agent.id, userMessage, assistantMessage);
    setMessageInput("");
    const currentConversation = conversations()[agent.id];
    const cancel = streamChat({
      backendUrl: WS_URL,
      agentId: agent.id,
      conversationId: currentConversation?.conversationId,
      message: text,
      options: { temperature: temperature() },
      onEvent: (event: ChatEvent) => handleChatEvent(agent.id, assistantId, event),
    });
    setActiveStream({ agentId: agent.id, messageId: assistantId, cancel });
  }

  const isStreaming = () => {
    const stream = activeStream();
    return !!stream && stream.agentId === selectedAgentId();
  };

  return (
    <div class="flex min-h-screen bg-slate-950 text-slate-100">
      <aside class="w-64 border-r border-slate-800 bg-slate-900/70 p-4">
        <div class="flex items-center justify-between">
          <h1 class="text-lg font-semibold">Agents</h1>
          <button
            class="rounded bg-emerald-500 px-3 py-1 text-sm font-semibold text-slate-900 hover:bg-emerald-400"
            onClick={handleCreateAgent}
          >
            New
          </button>
        </div>
        <p class="mt-1 text-xs text-slate-400">Select an agent or create a new one.</p>
        <div class="mt-4 space-y-2">
          <For each={agents()}>
            {(agent: Agent) => (
              <button
                class={clsx(
                  "w-full rounded border px-3 py-2 text-left text-sm transition",
                  agent.id === selectedAgentId()
                    ? "border-emerald-400 bg-emerald-500/10"
                    : "border-transparent bg-slate-800 hover:bg-slate-800/80"
                )}
                onClick={() => setSelectedAgentId(agent.id)}
              >
                <div class="font-semibold">{agent.name}</div>
                <div class="text-xs text-slate-400">{agent.id}</div>
              </button>
            )}
          </For>
          <Show when={loadingAgents()}>
            <div class="text-xs text-slate-400">Loading agents…</div>
          </Show>
        </div>
      </aside>

      <main class="flex flex-1 flex-col gap-6 p-6">
        <section class="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-lg font-semibold">
                Chat · {selectedAgent()?.name ?? "Select an agent"}
              </h2>
              <p class="text-xs text-slate-400">
                Streaming responses via WebSocket ({WS_URL}).
              </p>
            </div>
            <div class="flex items-center gap-2 text-xs text-slate-400">
              <label class="flex items-center gap-2">
                Temp
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={temperature()}
                  onInput={(event) => setTemperature(Number(event.currentTarget.value))}
                />
                <span class="w-8 text-right text-sm text-slate-200">
                  {temperature().toFixed(1)}
                </span>
              </label>
              <button
                class="rounded border border-slate-700 px-2 py-1 text-xs hover:border-slate-500"
                onClick={handleClearConversation}
              >
                Clear Chat
              </button>
            </div>
          </div>

          <div class="h-96 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4 scroll-container">
            <Show when={selectedAgentId()} fallback={<p class="text-sm text-slate-400">Select an agent to start chatting.</p>}>
              <For each={selectedConversation().messages}>
                {(message: ChatMessage) => (
                  <div
                    data-testid={`message-${message.role}`}
                    class={clsx(
                      "mb-3 flex flex-col gap-1",
                      message.role === "user" ? "items-end" : "items-start"
                    )}
                  >
                    <div
                      class={clsx(
                        "max-w-2xl rounded-2xl px-4 py-2 text-sm",
                        message.role === "user"
                          ? "bg-emerald-500/20 text-emerald-50"
                          : "bg-slate-800 text-slate-100"
                      )}
                    >
                      <pre class="whitespace-pre-wrap font-sans text-sm">{message.content || (message.streaming ? "…" : "")}</pre>
                    </div>
                    <Show when={message.streaming}>
                      <span class="text-[10px] uppercase tracking-wide text-slate-500">
                        streaming…
                      </span>
                    </Show>
                    <Show when={message.status === "error"}>
                      <span class="text-[10px] text-rose-400">stopped</span>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <Show when={chatError()}>
            <div class="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
              {chatError()}
            </div>
          </Show>

          <div class="flex flex-col gap-3">
            <textarea
              rows={3}
              class="w-full rounded-2xl border border-slate-700 bg-slate-950/80 p-3 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
              placeholder="Send a message…"
              value={messageInput()}
              onInput={(event) => setMessageInput(event.currentTarget.value)}
            />
            <div class="flex items-center gap-3">
              <button
                class="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700"
                disabled={!messageInput().trim() || !selectedAgentId()}
                onClick={handleSendMessage}
              >
                Send
              </button>
              <Show when={isStreaming()}>
                <button
                  class="rounded-2xl border border-amber-400 px-4 py-2 text-sm text-amber-200 hover:bg-amber-500/10"
                  onClick={() => stopActiveStream(true)}
                >
                  Stop
                </button>
              </Show>
            </div>
          </div>
        </section>

        <section class="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 class="text-lg font-semibold">Agent settings</h2>
          <p class="text-xs text-slate-400">System prompt + markdown context get stored on the backend.</p>
          <Show when={selectedAgentId()} fallback={<p class="mt-4 text-sm text-slate-400">Select or create an agent to edit settings.</p>}>
            <div class="mt-5 space-y-4 text-sm">
              <div class="flex flex-col gap-1">
                <label class="text-xs uppercase tracking-wide text-slate-400" for="agent-name-input">Agent Name</label>
                <input
                  id="agent-name-input"
                  class="rounded-xl border border-slate-700 bg-slate-950/80 p-2"
                  value={selectedAgentId() ? draftAgents[selectedAgentId()!]?.name ?? "" : ""}
                  onInput={(event) => handleDraftChange("name", event.currentTarget.value)}
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs uppercase tracking-wide text-slate-400" for="agent-system-prompt">System Prompt</label>
                <textarea
                  id="agent-system-prompt"
                  rows={3}
                  class="rounded-xl border border-slate-700 bg-slate-950/80 p-2"
                  value={selectedAgentId() ? draftAgents[selectedAgentId()!]?.system_prompt ?? "" : ""}
                  onInput={(event) => handleDraftChange("system_prompt", event.currentTarget.value)}
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs uppercase tracking-wide text-slate-400" for="agent-markdown-context">Markdown Context</label>
                <textarea
                  id="agent-markdown-context"
                  rows={10}
                  class="rounded-xl border border-slate-700 bg-slate-950/80 p-2 font-mono"
                  value={selectedAgentId() ? draftAgents[selectedAgentId()!]?.markdown_context ?? "" : ""}
                  onInput={(event) => handleDraftChange("markdown_context", event.currentTarget.value)}
                />
              </div>
              <div class="flex items-center gap-3">
                <button
                  class="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700"
                  disabled={!selectedAgentId() || isSavingAgent()}
                  onClick={handleSaveAgent}
                >
                  {isSavingAgent() ? "Saving…" : "Save"}
                </button>
                <Show when={statusMessage()}>
                  <span class="text-xs text-slate-400">{statusMessage()}</span>
                </Show>
              </div>
            </div>
          </Show>
        </section>
      </main>
    </div>
  );
};

export default App;
