import { listAgents, streamChat, updateAgent, type Agent, type ChatEvent } from '@ts-client/client'
import clsx from 'clsx'
import { For, Show, createEffect, createSignal, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'

const HTTP_BASE = import.meta.env.VITE_BACKEND_HTTP ?? 'http://localhost:8000'
const WS_URL = import.meta.env.VITE_BACKEND_WS ?? 'ws://localhost:8000/ws/chat'

type SpeakerType = 'person' | 'agent'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  status?: 'done' | 'error'
  agentId?: string
  speakerType: SpeakerType
  speakerName?: string
  speakerId?: string
}

type ConversationState = {
  conversationId?: string
  messages: ChatMessage[]
}

const randomId = () => Math.random().toString(36).slice(2)
const PERSON_ROLE = 'PERSON'
const PERSON_ID = 'person-local'
const RESPONSE_DELAY_MS = 600
const RESPONSE_DELAY_STEP_MS = 200

type ResponseTask = {
  agentId: string
  conversationId: string
  trigger: ChatMessage
  skipUserAppend: boolean
  promptFromLatest: boolean
  delayMs: number
}

const App = () => {
  const [agents, setAgents] = createSignal<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = createSignal<string>()
  const [draftAgents, setDraftAgents] = createStore<Record<string, Agent>>({})
  const [conversationState, setConversationState] = createSignal<ConversationState>({
    messages: [],
  })
  const [activeAgentIds, setActiveAgentIds] = createSignal<string[]>([])
  const [messageInput, setMessageInput] = createSignal('')
  const [personName, setPersonName] = createSignal('You')
  const [temperature, setTemperature] = createSignal(0.2)
  const [chatError, setChatError] = createSignal<string | null>(null)
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null)
  const [isSavingAgent, setIsSavingAgent] = createSignal(false)
  const [isAgentModalOpen, setAgentModalOpen] = createSignal(false)
  const [loadingAgents, setLoadingAgents] = createSignal(false)
  const [activeStream, setActiveStream] = createSignal<{
    agentId: string
    messageId: string
    cancel: () => void
  } | null>(null)
  const pendingResponseResolvers = new Map<string, () => void>()
  const queuedResponseAgents = new Set<string>()
  let responseQueue: ResponseTask[] = []
  let responseQueueProcessing = false
  let responseQueueToken = 0

  const selectedAgent = () => agents().find((agent: Agent) => agent.id === selectedAgentId())
  const personLabel = () => personName().trim() || 'You'

  const conversation = () => conversationState()

  const findMessageById = (messageId: string) =>
    conversationState().messages.find((message) => message.id === messageId)

  const activeAgents = () =>
    activeAgentIds()
      .map((id) => agents().find((agent: Agent) => agent.id === id))
      .filter(Boolean) as Agent[]

  const isAgentActive = (agentId: string | undefined) => {
    if (!agentId) return false
    return activeAgentIds().includes(agentId)
  }

  const getAgentName = (agentId: string | undefined) => {
    if (!agentId) return undefined
    return agents().find((agent: Agent) => agent.id === agentId)?.name
  }

  const messageSpeakerLabel = (message: ChatMessage) => {
    if (message.speakerName && message.speakerName.trim()) {
      return message.speakerName.trim()
    }
    if (message.speakerType === 'agent' && message.agentId) {
      return getAgentName(message.agentId) ?? message.agentId
    }
    return message.role === 'user' ? 'You' : 'Assistant'
  }

  const canSendMessage = () => {
    if (!messageInput().trim()) return false
    return activeAgents().length > 0
  }

  onMount(() => {
    refreshAgents()
  })

  createEffect(() => {
    const agent = selectedAgent()
    if (agent && !draftAgents[agent.id]) {
      setDraftAgents(agent.id, { ...agent })
    }
  })

  createEffect(() => {
    if (!selectedAgentId()) {
      setAgentModalOpen(false)
    }
  })

  function updateActiveAgents(updater: (prev: string[]) => string[]) {
    setActiveAgentIds((prev: string[]) => {
      const next = updater(prev)
      if (!next.length) {
        setSelectedAgentId(undefined)
      } else {
        const current = selectedAgentId()
        if (!current || !next.includes(current)) {
          setSelectedAgentId(next[0])
        }
      }
      return next
    })
  }

  function addAgentToConversation(agentId: string) {
    updateActiveAgents((prev) => (prev.includes(agentId) ? prev : [...prev, agentId]))
    setSelectedAgentId(agentId)
  }

  function removeAgentFromConversation(agentId: string) {
    updateActiveAgents((prev) => prev.filter((id) => id !== agentId))
    const stream = activeStream()
    if (stream?.agentId === agentId) {
      stopActiveStream(true)
    }
  }

  function ensureConversationId(): string {
    const existing = conversationState().conversationId
    if (existing) {
      return existing
    }
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `conversation-${Date.now().toString(36)}-${randomId()}`
    setConversationState((prev) => ({ conversationId: generated, messages: [...prev.messages] }))
    return generated
  }

  function resetResponseQueue() {
    responseQueue = []
    responseQueueToken += 1
    responseQueueProcessing = false
    queuedResponseAgents.clear()
  }

  function enqueueResponseTasks(tasks: ResponseTask[]) {
    const eligible = tasks.filter((task) => !queuedResponseAgents.has(task.agentId))
    if (!eligible.length) return
    eligible.forEach((task) => queuedResponseAgents.add(task.agentId))
    responseQueue = [...responseQueue, ...eligible]
    void processResponseQueue(responseQueueToken)
  }

  async function processResponseQueue(token: number) {
    if (responseQueueProcessing) return
    responseQueueProcessing = true
    while (responseQueue.length && token === responseQueueToken) {
      const task = responseQueue[0]
      await waitMs(task.delayMs)
      if (token !== responseQueueToken) {
        break
      }
      await runResponseTask(task)
      if (token !== responseQueueToken) {
        break
      }
      responseQueue = responseQueue.slice(1)
    }
    responseQueueProcessing = false
    if (responseQueue.length) {
      void processResponseQueue(responseQueueToken)
    }
  }

  function waitMs(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  function resolveResponse(messageId: string) {
    const resolver = pendingResponseResolvers.get(messageId)
    if (resolver) {
      resolver()
      pendingResponseResolvers.delete(messageId)
    }
    const message = findMessageById(messageId)
    if (message?.agentId) {
      queuedResponseAgents.delete(message.agentId)
    }
  }

  function queueAgentResponses(message: ChatMessage, conversationId: string) {
    const availableAgents = [...activeAgentIds()]
    if (!availableAgents.length) {
      return
    }
    const speakerAgentId =
      message.speakerType === 'agent' ? message.agentId ?? message.speakerId : undefined
    let targets = availableAgents.filter((agentId) => agentId !== speakerAgentId)
    if (!targets.length) {
      return
    }
    if (message.speakerType === 'person') {
      const preferred = selectedAgentId()
      if (preferred && targets.includes(preferred)) {
        targets = targets.filter((agentId) => agentId !== preferred)
        targets.unshift(preferred)
      }
    }
    const tasks: ResponseTask[] = targets.map((agentId, index) => ({
      agentId,
      conversationId,
      trigger: message,
      skipUserAppend: message.speakerType === 'person' ? index !== 0 : true,
      promptFromLatest: message.speakerType === 'person' ? index !== 0 : true,
      delayMs: RESPONSE_DELAY_MS + index * RESPONSE_DELAY_STEP_MS,
    }))
    enqueueResponseTasks(tasks)
  }

  function runResponseTask(task: ResponseTask): Promise<void> {
    return new Promise((resolve) => {
      const agent = agents().find((item: Agent) => item.id === task.agentId)
      if (!agent || !isAgentActive(agent.id)) {
        queuedResponseAgents.delete(task.agentId)
        resolve()
        return
      }
      const assistantId = randomId()
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        streaming: true,
        agentId: agent.id,
        speakerType: 'agent',
        speakerName: agent.name,
        speakerId: agent.id,
      }
      appendMessages(assistantMessage)
      try {
        const cancel = streamChat({
          backendUrl: WS_URL,
          agentId: agent.id,
          conversationId: task.conversationId,
          message: task.trigger.content,
          speakerRole: task.trigger.speakerType === 'person' ? PERSON_ROLE : 'AGENT',
          speakerName:
            task.trigger.speakerName ??
            (task.trigger.speakerType === 'person' ? personLabel() : agent.name),
          speakerId:
            task.trigger.speakerType === 'person'
              ? task.trigger.speakerId ?? PERSON_ID
              : task.trigger.agentId ?? task.trigger.speakerId ?? agent.id,
          skipUserAppend: task.skipUserAppend,
          promptFromLatest: task.promptFromLatest,
          options: { temperature: temperature() },
          onEvent: (event: ChatEvent) => handleChatEvent(assistantId, event)
        })
        pendingResponseResolvers.set(assistantId, resolve)
        setActiveStream({ agentId: agent.id, messageId: assistantId, cancel })
      } catch (err) {
        mutateMessage(assistantId, (message) => ({
          ...message,
          streaming: false,
          status: 'error',
        }))
        setChatError((err as Error).message)
        queuedResponseAgents.delete(agent.id)
        resolve()
      }
    })
  }

  async function refreshAgents() {
    setLoadingAgents(true)
    try {
      const result: Agent[] = await listAgents(HTTP_BASE)
      setAgents(result)
      const validActive = activeAgentIds().filter((id) => result.some((agent: Agent) => agent.id === id))
      let nextActive = validActive
      if (!nextActive.length && result.length) {
        nextActive = [result[0].id]
      }
      setActiveAgentIds(nextActive)
      const currentSelected = selectedAgentId()
      if (!nextActive.length) {
        setSelectedAgentId(undefined)
      } else if (!currentSelected || !nextActive.includes(currentSelected)) {
        setSelectedAgentId(nextActive[0])
      }
      result.forEach((agent: Agent) => setDraftAgents(agent.id, { ...agent }))
      setStatusMessage(null)
    } catch (err) {
      setStatusMessage(`Failed to load agents: ${(err as Error).message}`)
    } finally {
      setLoadingAgents(false)
    }
  }

  function handleDraftChange(field: keyof Agent, value: string) {
    const agentId = selectedAgentId()
    if (!agentId) return
    const fallback = draftAgents[agentId] ??
      selectedAgent() ?? {
        id: agentId,
        name: '',
        system_prompt: '',
        markdown_context: ''
      }
    setDraftAgents(agentId, {
      ...fallback,
      [field]: value
    } as Agent)
  }

  async function handleSaveAgent() {
    const agentId = selectedAgentId()
    if (!agentId) return
    const draft = draftAgents[agentId]
    if (!draft) return
    setIsSavingAgent(true)
    setStatusMessage('Saving agent...')
    try {
      const updated = await updateAgent(draft, HTTP_BASE)
      setAgents((prev: Agent[]) => {
        const existingIndex = prev.findIndex((item: Agent) => item.id === updated.id)
        if (existingIndex >= 0) {
          const clone = [...prev]
          clone[existingIndex] = updated
          return clone
        }
        return [...prev, updated]
      })
      setDraftAgents(updated.id, { ...updated })
      setStatusMessage('Agent saved')
    } catch (err) {
      setStatusMessage(`Save failed: ${(err as Error).message}`)
    } finally {
      setIsSavingAgent(false)
      setTimeout(() => setStatusMessage(null), 3000)
    }
  }

  function handleCreateAgent() {
    const id = `agent-${Date.now().toString(36)}`
    const template: Agent = {
      id,
      name: 'New Agent',
      system_prompt: 'You are a helpful collaborator.',
      markdown_context: '# Context\n- Add markdown knowledge here.\n'
    }
    setAgents((prev: Agent[]) => [...prev, template])
    setDraftAgents(id, { ...template })
    addAgentToConversation(id)
    setStatusMessage('New agent ready. Save to persist.')
    setAgentModalOpen(true)
  }

  function updateConversation(builder: (state: ConversationState) => ConversationState) {
    setConversationState((prev: ConversationState) => {
      const nextState = builder({
        conversationId: prev.conversationId,
        messages: [...prev.messages]
      })
      return nextState
    })
  }

  function appendMessages(...messages: ChatMessage[]) {
    updateConversation((state) => ({
      conversationId: state.conversationId,
      messages: [...state.messages, ...messages]
    }))
  }

  function mutateMessage(messageId: string, transform: (message: ChatMessage) => ChatMessage) {
    updateConversation((state) => ({
      ...state,
      messages: state.messages.map((message) => (message.id === messageId ? transform(message) : message))
    }))
  }

  function setConversationId(conversationId: string | undefined) {
    updateConversation((state) => ({
      ...state,
      conversationId: conversationId ?? state.conversationId
    }))
  }

  function finalizeAssistant(messageId: string, isError = false) {
    mutateMessage(messageId, (message: ChatMessage) => ({
      ...message,
      streaming: false,
      status: isError ? 'error' : 'done'
    }))
  }

  function handleChatEvent(messageId: string, event: ChatEvent) {
    if (event.conversationId) {
      setConversationId(event.conversationId)
    }
    if (event.type === 'token') {
      mutateMessage(messageId, (message: ChatMessage) => ({
        ...message,
        content: message.content + event.token
      }))
    }
    if (event.type === 'done') {
      finalizeAssistant(messageId)
      setActiveStream(null)
      resolveResponse(messageId)
      const nextConversationId = conversationState().conversationId
      const completedMessage = findMessageById(messageId)
      if (nextConversationId && completedMessage?.speakerType === 'agent') {
        queueAgentResponses(completedMessage, nextConversationId)
      }
    }
    if (event.type === 'error') {
      setChatError(event.message)
      finalizeAssistant(messageId, true)
      setActiveStream(null)
      resolveResponse(messageId)
    }
  }

  function stopActiveStream(markError = false) {
    const stream = activeStream()
    if (!stream) return
    stream.cancel()
    if (markError) {
      finalizeAssistant(stream.messageId, true)
    }
    setActiveStream(null)
    resolveResponse(stream.messageId)
  }

  function cancelAllResponses(markError: boolean) {
    stopActiveStream(markError)
    resetResponseQueue()
  }

  function handleClearConversation() {
    cancelAllResponses(true)
    setConversationState({ messages: [], conversationId: undefined })
  }

  function handleMessageKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      handleSendMessage()
    }
  }

  function handleSendMessage() {
    const text = messageInput().trim()
    if (!text || activeAgents().length === 0) return
    setChatError(null)
    cancelAllResponses(false)
    const speakerName = personLabel()
    const conversationId = ensureConversationId()
    const userMessage: ChatMessage = {
      id: randomId(),
      role: 'user',
      content: text,
      speakerType: 'person',
      speakerName,
      speakerId: PERSON_ID,
    }
    appendMessages(userMessage)
    setMessageInput('')
    queueAgentResponses(userMessage, conversationId)
  }

  const isStreaming = () => !!activeStream()

  const statusToneClass = () => {
    const message = (statusMessage() ?? '').toLowerCase()
    if (!message) return 'text-slate-400'
    if (message.includes('fail') || message.includes('error')) {
      return 'text-rose-300'
    }
    return 'text-emerald-300'
  }

  return (
    <div class="flex h-screen overflow-hidden bg-slate-950 text-slate-100">
      <aside class="w-64 border-r border-slate-800 bg-slate-900/70 p-4 overflow-y-auto">
        <div class="flex items-center justify-between">
          <h1 class="text-lg font-semibold">Agents</h1>
          <button
            class="rounded bg-emerald-500 px-3 py-1 text-sm font-semibold text-slate-900 hover:bg-emerald-400"
            onClick={handleCreateAgent}
          >
            New
          </button>
        </div>
        <p class="mt-1 text-xs text-slate-400">Toggle agents into the shared conversation and edit their settings.</p>
        <div class="mt-4 space-y-2">
          <For each={agents()}>
            {(agent: Agent) => {
              const active = () => isAgentActive(agent.id)
              return (
                <div class="flex items-center gap-2">
                  <button
                    class={clsx(
                      'flex-1 rounded border px-3 py-2 text-left text-sm transition',
                      agent.id === selectedAgentId()
                        ? 'border-emerald-400 bg-emerald-500/10'
                        : 'border-transparent bg-slate-800 hover:bg-slate-800/80'
                    )}
                    onClick={() => setSelectedAgentId(agent.id)}
                  >
                    <div class="font-semibold">{agent.name}</div>
                    <div class="text-xs text-slate-400">{agent.id}</div>
                  </button>
                  <button
                    class={clsx(
                      'rounded-full border px-2 py-1 text-sm transition',
                      active() ? 'border-emerald-400 text-emerald-300' : 'border-slate-700 text-slate-300 hover:border-slate-500'
                    )}
                    aria-label={`${active() ? 'Remove' : 'Add'} ${agent.name} ${active() ? 'from' : 'to'} conversation`}
                    onClick={(event) => {
                      event.stopPropagation()
                      active() ? removeAgentFromConversation(agent.id) : addAgentToConversation(agent.id)
                    }}
                  >
                    {active() ? '−' : '+'}
                  </button>
                </div>
              )
            }}
          </For>
          <Show when={loadingAgents()}>
            <div class="text-xs text-slate-400">Loading agents…</div>
          </Show>
        </div>
      </aside>

      <main class="flex flex-1 min-h-0 flex-col gap-6 overflow-hidden p-6">
        <section class="flex flex-1 min-h-0 flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="space-y-1">
              <h2 class="text-lg font-semibold">Chat · {selectedAgent()?.name ?? 'Choose an active agent'}</h2>
              <p class="text-xs text-slate-400">Streaming responses via WebSocket ({WS_URL}).</p>
              <Show when={statusMessage()}>
                <p class={`text-xs ${statusToneClass()}`}>{statusMessage()}</p>
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
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
                <span class="w-8 text-right text-sm text-slate-200">{temperature().toFixed(1)}</span>
              </label>
              <button
                class="rounded border border-slate-700 px-2 py-1 text-xs hover:border-slate-500"
                onClick={handleClearConversation}
              >
                Clear Chat
              </button>
              <div class="flex flex-col gap-1 text-[11px] text-slate-400">
                <label class="uppercase tracking-wide" for="person-name-input">
                  Your name
                </label>
                <input
                  id="person-name-input"
                  class="w-40 rounded-xl border border-slate-700 bg-slate-950/80 px-2 py-1 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                  value={personName()}
                  onInput={(event) => setPersonName(event.currentTarget.value)}
                />
              </div>
              <button
                class="rounded border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600"
                onClick={() => setAgentModalOpen(true)}
                disabled={!selectedAgentId()}
              >
                Agent Settings
              </button>
            </div>
          </div>

          <Show when={activeAgents().length}>
            <div class="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
              <p class="mb-2 font-semibold uppercase tracking-wide text-[10px] text-slate-500">Active agents</p>
              <div class="flex flex-wrap gap-2">
                <For each={activeAgents()}>
                  {(agent: Agent) => (
                    <div
                      class={clsx(
                        'flex items-center gap-2 rounded-full border px-3 py-1',
                        agent.id === selectedAgentId()
                          ? 'border-emerald-400 bg-emerald-500/10 text-emerald-100'
                          : 'border-slate-700 bg-slate-900/70 text-slate-200'
                      )}
                    >
                      <button
                        class="text-xs font-semibold uppercase tracking-wide"
                        onClick={() => setSelectedAgentId(agent.id)}
                      >
                        {agent.name}
                      </button>
                      <button
                        type="button"
                        class="rounded-full border border-slate-700 px-1 text-[10px] text-slate-300 hover:border-slate-500"
                        aria-label={`Remove ${agent.name} from conversation`}
                        onClick={(event) => {
                          event.stopPropagation()
                          removeAgentFromConversation(agent.id)
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="scroll-container flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <Show
              when={activeAgents().length}
              fallback={<p class="text-sm text-slate-400">Add at least one agent to the conversation to start chatting.</p>}
            >
              <For each={conversation().messages}>
                {(message: ChatMessage) => (
                  <div
                    data-testid={`message-${message.role}`}
                    class={clsx('mb-3 flex flex-col gap-1', message.role === 'user' ? 'items-end' : 'items-start')}
                  >
                    <div class="text-[10px] uppercase tracking-wide text-slate-500">{messageSpeakerLabel(message)}</div>
                    <div
                      class={clsx(
                        'max-w-2xl rounded-2xl px-4 py-2 text-sm',
                        message.role === 'user' ? 'bg-emerald-500/20 text-emerald-50' : 'bg-slate-800 text-slate-100'
                      )}
                    >
                      <pre class="whitespace-pre-wrap font-sans text-sm">
                        {message.content || (message.streaming ? '…' : '')}
                      </pre>
                    </div>
                    <Show when={message.streaming}>
                      <span class="text-[10px] uppercase tracking-wide text-slate-500">streaming…</span>
                    </Show>
                    <Show when={message.status === 'error'}>
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
              onKeyDown={handleMessageKeyDown}
            />
            <div class="flex items-center gap-3">
              <button
                class="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700"
                disabled={!canSendMessage()}
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
      </main>

      <Show when={isAgentModalOpen()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
          onClick={() => setAgentModalOpen(false)}
        >
          <div
            class="w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900/90 p-6 text-sm text-slate-100"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="flex items-center justify-between">
              <div>
                <h2 class="text-xl font-semibold">Agent settings</h2>
                <p class="text-xs text-slate-400">System prompt + markdown context get stored on the backend.</p>
              </div>
              <button
                class="rounded-xl border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500"
                onClick={() => setAgentModalOpen(false)}
              >
                Close
              </button>
            </div>
            <Show
              when={selectedAgentId()}
              fallback={<p class="mt-6 text-sm text-slate-400">Select or create an agent to edit settings.</p>}
            >
              <div class="mt-6 space-y-4">
                <div class="flex flex-col gap-1">
                  <label class="text-xs uppercase tracking-wide text-slate-400" for="agent-name-input">
                    Agent Name
                  </label>
                  <input
                    id="agent-name-input"
                    class="rounded-xl border border-slate-700 bg-slate-950/80 p-2"
                    value={selectedAgentId() ? (draftAgents[selectedAgentId()!]?.name ?? '') : ''}
                    onInput={(event) => handleDraftChange('name', event.currentTarget.value)}
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-xs uppercase tracking-wide text-slate-400" for="agent-system-prompt">
                    System Prompt
                  </label>
                  <textarea
                    id="agent-system-prompt"
                    rows={3}
                    class="rounded-xl border border-slate-700 bg-slate-950/80 p-2"
                    value={selectedAgentId() ? (draftAgents[selectedAgentId()!]?.system_prompt ?? '') : ''}
                    onInput={(event) => handleDraftChange('system_prompt', event.currentTarget.value)}
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-xs uppercase tracking-wide text-slate-400" for="agent-markdown-context">
                    Markdown Context
                  </label>
                  <textarea
                    id="agent-markdown-context"
                    rows={10}
                    class="rounded-xl border border-slate-700 bg-slate-950/80 p-2 font-mono"
                    value={selectedAgentId() ? (draftAgents[selectedAgentId()!]?.markdown_context ?? '') : ''}
                    onInput={(event) => handleDraftChange('markdown_context', event.currentTarget.value)}
                  />
                </div>
                <div class="flex items-center gap-3">
                  <button
                    class="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700"
                    disabled={!selectedAgentId() || isSavingAgent()}
                    onClick={handleSaveAgent}
                  >
                    {isSavingAgent() ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default App
