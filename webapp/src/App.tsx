import {
  Agent,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  createConversation,
  deleteConversation,
  getConversation,
  listAgents,
  listConversations,
  renameConversation,
  sendConversationMessage,
  updateAgent,
  updateConversationAgents,
} from '@ts-client/client'
import clsx from 'clsx'
import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'

const HTTP_BASE =
  import.meta.env.VITE_BACKEND_HTTP ?? import.meta.env.VITE_BACKEND ?? 'http://localhost:8000'
const RAW_WS_URL = import.meta.env.VITE_BACKEND_WS ?? 'ws://localhost:8000/ws/chat'
const WS_ROOT = RAW_WS_URL.replace(/\/ws\/chat$/, '')
const PERSON_ROLE = 'PERSON'
const PERSON_ID = 'person-local'

const conversationWsUrl = (conversationId: string) => `${WS_ROOT}/ws/conversations/${conversationId}`

const randomId = () => Math.random().toString(36).slice(2)

type SpeakerType = 'person' | 'agent'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  status?: 'pending' | 'done' | 'error'
  agentId?: string
  speakerType: SpeakerType
  speakerName?: string
  speakerId?: string
}

type ConversationState = {
  conversationId?: string
  title?: string
  messages: ChatMessage[]
}

const mapConversationMessage = (message: ConversationMessage): ChatMessage => {
  const normalizedRole = (message.role || '').toUpperCase()
  const speakerType: SpeakerType = normalizedRole === 'AGENT' ? 'agent' : 'person'
  return {
    id: message.id || randomId(),
    role: speakerType === 'agent' ? 'assistant' : 'user',
    content: message.content ?? '',
    speakerType,
    speakerName: message.name,
    speakerId: message.speaker_id,
    agentId: speakerType === 'agent' ? message.speaker_id : undefined,
    status: 'done',
  }
}

const App = () => {
  const [agents, setAgents] = createSignal<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = createSignal<string>()
  const [draftAgents, setDraftAgents] = createStore<Record<string, Agent>>({})
  const [conversationState, setConversationState] = createSignal<ConversationState>({
    messages: [],
  })
  const [conversationSummaries, setConversationSummaries] = createSignal<ConversationSummary[]>([])
  const [isLoadingConversations, setIsLoadingConversations] = createSignal(false)
  const [activeAgentIds, setActiveAgentIds] = createSignal<string[]>([])
  const [messageInput, setMessageInput] = createSignal('')
  const [personName, setPersonName] = createSignal('You')
  const [temperature, setTemperature] = createSignal(0.2)
  const [chatError, setChatError] = createSignal<string | null>(null)
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null)
  const [isSavingAgent, setIsSavingAgent] = createSignal(false)
  const [isAgentModalOpen, setAgentModalOpen] = createSignal(false)
  const [loadingAgents, setLoadingAgents] = createSignal(false)
  const [socketStatus, setSocketStatus] = createSignal<'disconnected' | 'connecting' | 'connected'>('disconnected')

  let conversationSocket: WebSocket | null = null
  let socketReconnectTimer: number | undefined
  let socketConversationId: string | undefined
  const selectedAgent = () => agents().find((agent: Agent) => agent.id === selectedAgentId())
  const personLabel = () => personName().trim() || 'You'
  const conversation = () => conversationState()

  const canSendMessage = () => {
    if (!messageInput().trim()) return false
    if (!conversationState().conversationId) return false
    return true
  }

  const isStreaming = () => conversationState().messages.some((message) => message.streaming)

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

  const sortConversationSummaries = (list: ConversationSummary[]) => {
    const parseTime = (value?: string) => (value ? Date.parse(value) : 0)
    return [...list].sort((a, b) => parseTime(b.updated_at) - parseTime(a.updated_at))
  }

  function upsertConversationSummary(summary: ConversationSummary) {
    setConversationSummaries((prev) =>
      sortConversationSummaries([
        ...prev.filter((item) => item.id !== summary.id),
        summary,
      ]),
    )
  }

  createEffect(() => {
    if (!selectedAgentId()) {
      setAgentModalOpen(false)
    }
  })

  function updateSummaryWithMessage(conversationId: string | undefined, content: string) {
    if (!conversationId || !content.trim()) return
    const preview = content.slice(0, 160)
    setConversationSummaries((prev) => {
      const index = prev.findIndex((item) => item.id === conversationId)
      if (index === -1) {
        const fallback: ConversationSummary = {
          id: conversationId,
          title: conversationState().title ?? `Conversation ${conversationId.slice(0, 8)}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          message_count: 1,
          last_message_preview: preview,
          active_agents: activeAgentIds(),
        }
        return sortConversationSummaries([...prev, fallback])
      }
      const clone = [...prev]
      const summary = clone[index]
      clone[index] = {
        ...summary,
        updated_at: new Date().toISOString(),
        last_message_preview: preview,
        message_count: summary.message_count + 1,
        active_agents: activeAgentIds(),
      }
      return sortConversationSummaries(clone)
    })
  }

  function appendMessages(...messages: ChatMessage[]) {
    setConversationState((prev) => {
      const existing = new Map(prev.messages.map((message) => [message.id, message]))
      const nextMessages = [...prev.messages]
      messages.forEach((message) => {
        if (existing.has(message.id)) {
          const index = nextMessages.findIndex((item) => item.id === message.id)
          if (index >= 0) {
            nextMessages[index] = { ...nextMessages[index], ...message }
          }
        } else {
          nextMessages.push(message)
        }
      })
      return { ...prev, messages: nextMessages }
    })
  }

  function mutateMessage(messageId: string, transform: (message: ChatMessage) => ChatMessage) {
    setConversationState((prev) => ({
      ...prev,
      messages: prev.messages.map((message) => (message.id === messageId ? transform(message) : message)),
    }))
  }

  function applyConversationDetail(detail: ConversationDetail) {
    const normalized = detail.messages.map(mapConversationMessage)
    setConversationState({
      conversationId: detail.id,
      title: detail.title,
      messages: normalized,
    })
    setActiveAgentIds(detail.active_agents ?? [])
    upsertConversationSummary(detail)
    setMessageInput('')
  }

  async function initializeConversations() {
    setIsLoadingConversations(true)
    try {
      const summaries = await listConversations(HTTP_BASE)
      setConversationSummaries(sortConversationSummaries(summaries))
      if (summaries.length) {
        await openConversation(summaries[0].id, { silent: true })
      } else {
        const detail = await createConversation({}, HTTP_BASE)
        applyConversationDetail(detail)
      }
    } catch (err) {
      setStatusMessage(`Failed to load conversations: ${(err as Error).message}`)
    } finally {
      setIsLoadingConversations(false)
    }
  }

  async function openConversation(conversationId: string, options: { silent?: boolean } = {}) {
    if (!conversationId) return
    if (!options.silent) {
      setIsLoadingConversations(true)
    }
    try {
      const detail = await getConversation(conversationId, HTTP_BASE)
      applyConversationDetail(detail)
    } catch (err) {
      setStatusMessage(`Failed to load conversation: ${(err as Error).message}`)
    } finally {
      if (!options.silent) {
        setIsLoadingConversations(false)
      }
    }
  }

  async function handleCreateConversation(title?: string) {
    setIsLoadingConversations(true)
    try {
      const detail = await createConversation(title ? { title } : {}, HTTP_BASE)
      applyConversationDetail(detail)
    } catch (err) {
      setStatusMessage(`Failed to create conversation: ${(err as Error).message}`)
    } finally {
      setIsLoadingConversations(false)
    }
  }

  async function handleRenameConversation(conversationId: string) {
    const current = conversationSummaries().find((item) => item.id === conversationId)
    const nextTitle = window.prompt('Rename conversation', current?.title ?? 'Conversation')
    if (nextTitle === null) return
    try {
      const detail = await renameConversation(conversationId, { title: nextTitle }, HTTP_BASE)
      upsertConversationSummary(detail)
      if (conversationState().conversationId === conversationId) {
        setConversationState((prev) => ({ ...prev, title: detail.title }))
      }
    } catch (err) {
      setStatusMessage(`Failed to rename conversation: ${(err as Error).message}`)
    }
  }

  async function handleDeleteConversation(conversationId: string) {
    if (!window.confirm('Delete this conversation?')) return
    setIsLoadingConversations(true)
    try {
      await deleteConversation(conversationId, HTTP_BASE)
      const remaining = conversationSummaries().filter((item) => item.id !== conversationId)
      setConversationSummaries(remaining)
      if (conversationState().conversationId === conversationId) {
        setConversationState({ conversationId: undefined, title: undefined, messages: [] })
        if (remaining.length) {
          await openConversation(remaining[0].id, { silent: true })
        } else {
          await handleCreateConversation()
        }
      }
    } catch (err) {
      setStatusMessage(`Failed to delete conversation: ${(err as Error).message}`)
    } finally {
      setIsLoadingConversations(false)
    }
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

  async function persistActiveAgents(next: string[]) {
    const conversationId = conversationState().conversationId
    if (!conversationId) return
    try {
      const detail = await updateConversationAgents(conversationId, next, HTTP_BASE)
      setActiveAgentIds(detail.active_agents ?? [])
      upsertConversationSummary(detail)
    } catch (err) {
      setStatusMessage(`Failed to update active agents: ${(err as Error).message}`)
    }
  }

  function addAgentToConversation(agentId: string) {
    if (activeAgentIds().includes(agentId)) return
    const next = [...activeAgentIds(), agentId]
    setActiveAgentIds(next)
    setSelectedAgentId(agentId)
    void persistActiveAgents(next)
  }

  function removeAgentFromConversation(agentId: string) {
    const next = activeAgentIds().filter((id) => id !== agentId)
    setActiveAgentIds(next)
    if (selectedAgentId() === agentId) {
      setSelectedAgentId(next[0])
    }
    void persistActiveAgents(next)
  }

  function handleDraftChange(field: keyof Agent, value: string) {
    const agentId = selectedAgentId()
    if (!agentId) return
    const fallback =
      draftAgents[agentId] ??
      selectedAgent() ?? {
        id: agentId,
        name: '',
        system_prompt: '',
        markdown_context: '',
      }
    setDraftAgents(agentId, {
      ...fallback,
      [field]: value,
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
      markdown_context: '# Context\n- Add markdown knowledge here.\n',
    }
    setAgents((prev: Agent[]) => [...prev, template])
    setDraftAgents(id, { ...template })
    addAgentToConversation(id)
    setStatusMessage('New agent ready. Save to persist.')
    setAgentModalOpen(true)
  }

  async function handleSendMessage() {
    const text = messageInput().trim()
    if (!text) return
    const conversationId = conversationState().conversationId
    if (!conversationId) {
      setStatusMessage('Select or create a conversation to begin chatting.')
      return
    }
    setChatError(null)
    const speakerName = personLabel()
    try {
      const response = await sendConversationMessage(
        conversationId,
        {
          content: text,
          speaker_role: PERSON_ROLE,
          speaker_name: speakerName,
          speaker_id: PERSON_ID,
        },
        HTTP_BASE,
      )
      const mapped = mapConversationMessage(response)
      appendMessages(mapped)
      updateSummaryWithMessage(conversationId, mapped.content)
      setMessageInput('')
    } catch (err) {
      setChatError((err as Error).message)
    }
  }

  function handleMessageKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void handleSendMessage()
    }
  }

  function statusToneClass() {
    const message = (statusMessage() ?? '').toLowerCase()
    if (!message) return 'text-slate-400'
    if (message.includes('fail') || message.includes('error')) {
      return 'text-rose-300'
    }
    return 'text-emerald-300'
  }

  function cleanupSocket() {
    if (socketReconnectTimer) {
      clearTimeout(socketReconnectTimer)
      socketReconnectTimer = undefined
    }
    if (conversationSocket) {
      conversationSocket.close()
      conversationSocket = null
    }
    socketConversationId = undefined
    setSocketStatus('disconnected')
  }

  const socketUrlHint = () => {
    const base = `${WS_ROOT}/ws/conversations`
    const currentId = conversationState().conversationId
    return currentId ? `${base}/${currentId}` : `${base}/:id`
  }

  function handleSocketEvent(event: MessageEvent) {
    try {
      const payload = JSON.parse(event.data)
      const currentId = conversationState().conversationId
      if (payload.conversation_id && payload.conversation_id !== currentId) {
        return
      }
      switch (payload.type) {
        case 'ready':
          setSocketStatus('connected')
          break
        case 'message_appended':
          if (payload.message) {
            const mapped = mapConversationMessage(payload.message as ConversationMessage)
            appendMessages(mapped)
            updateSummaryWithMessage(currentId, mapped.content)
          }
          break
        case 'message_started':
          appendMessages({
            id: payload.message_id ?? randomId(),
            role: 'assistant',
            content: '',
            streaming: true,
            status: 'pending',
            agentId: payload.agent_id,
            speakerType: 'agent',
            speakerName: payload.speaker_name,
            speakerId: payload.agent_id,
          })
          break
        case 'token':
          if (payload.message_id && typeof payload.token === 'string') {
            mutateMessage(payload.message_id, (message) => ({
              ...message,
              content: (message.content ?? '') + payload.token,
              streaming: true,
              status: 'pending',
            }))
          }
          break
        case 'message_completed':
          if (payload.message_id) {
            mutateMessage(payload.message_id, (message) => ({
              ...message,
              content: payload.content ?? message.content,
              streaming: false,
              status: 'done',
            }))
          }
          break
        case 'message_error':
          if (payload.message_id) {
            mutateMessage(payload.message_id, (message) => ({
              ...message,
              streaming: false,
              status: 'error',
            }))
            setStatusMessage(payload.message ?? 'Agent error')
          }
          break
        case 'error':
          setStatusMessage(payload.message ?? 'Conversation socket error')
          break
        default:
          break
      }
    } catch (err) {
      setStatusMessage(`Failed to parse conversation event: ${(err as Error).message}`)
    }
  }

  function connectConversationSocket(conversationId: string) {
    if (!conversationId || conversationId === socketConversationId) return
    cleanupSocket()
    const url = conversationWsUrl(conversationId)
    setSocketStatus('connecting')
    socketConversationId = conversationId
    try {
      conversationSocket = new WebSocket(url)
    } catch (err) {
      setSocketStatus('disconnected')
      setStatusMessage(`Failed to connect conversation socket: ${(err as Error).message}`)
      return
    }
    conversationSocket.onopen = () => {
      setSocketStatus('connected')
    }
    conversationSocket.onmessage = handleSocketEvent
    conversationSocket.onerror = () => {
      setSocketStatus('disconnected')
    }
    conversationSocket.onclose = () => {
      setSocketStatus('disconnected')
      if (socketConversationId) {
        socketReconnectTimer = window.setTimeout(() => {
          connectConversationSocket(socketConversationId as string)
        }, 1500)
      }
    }
  }

  onMount(() => {
    refreshAgents()
    void initializeConversations()
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

  createEffect(() => {
    const conversationId = conversationState().conversationId
    if (conversationId) {
      connectConversationSocket(conversationId)
    } else {
      cleanupSocket()
    }
  })

  onCleanup(() => {
    cleanupSocket()
  })

  return (
    <div class="flex h-screen overflow-hidden bg-slate-950 text-slate-100">
      <aside class="w-72 border-r border-slate-800 bg-slate-900/70 p-4 overflow-y-auto">
        <div class="space-y-6">
          <section>
            <div class="flex items-center justify-between">
              <h1 class="text-lg font-semibold">Conversations</h1>
              <button
                class="rounded bg-emerald-500 px-3 py-1 text-sm font-semibold text-slate-900 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleCreateConversation()}
                disabled={isLoadingConversations()}
              >
                New Conversation
              </button>
            </div>
            <p class="mt-1 text-xs text-slate-400">Switch between persisted threads. Conversations survive reloads and server restarts.</p>
            <div class="mt-4 space-y-3">
              <Show when={conversationSummaries().length} fallback={<p class="text-xs text-slate-500">No conversations yet.</p>}>
                <For each={conversationSummaries()}>
                  {(summary: ConversationSummary) => {
                    const active = () => conversationState().conversationId === summary.id
                    return (
                      <div class="flex items-start gap-2">
                        <button
                          class={clsx(
                            'flex-1 rounded-xl border px-3 py-2 text-left text-sm transition',
                            active()
                              ? 'border-emerald-400 bg-emerald-500/10'
                              : 'border-slate-800 bg-slate-900/60 hover:border-slate-600'
                          )}
                          onClick={() => void openConversation(summary.id)}
                        >
                          <div class="font-semibold text-slate-100">{summary.title || 'Untitled conversation'}</div>
                          <div class="text-[11px] text-slate-400">
                            {summary.last_message_preview || 'No messages yet.'}
                          </div>
                        </button>
                        <div class="flex gap-1">
                          <button
                            class="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-500"
                            aria-label="Rename conversation"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleRenameConversation(summary.id)
                            }}
                          >
                            ✎
                          </button>
                          <button
                            class="rounded border border-slate-700 px-2 py-1 text-xs text-rose-200 hover:border-rose-400"
                            aria-label="Delete conversation"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleDeleteConversation(summary.id)
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </Show>
              <Show when={isLoadingConversations()}>
                <div class="text-xs text-slate-400">Loading conversations…</div>
              </Show>
            </div>
          </section>

          <section>
            <div class="flex items-center justify-between">
              <h2 class="text-lg font-semibold">Agents</h2>
              <button
                class="rounded bg-emerald-500 px-3 py-1 text-sm font-semibold text-slate-900 hover:bg-emerald-400"
                onClick={handleCreateAgent}
              >
                New Agent
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
          </section>
        </div>
      </aside>

      <main class="flex flex-1 min-h-0 flex-col gap-6 overflow-hidden p-6">
        <section class="flex flex-1 min-h-0 flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="space-y-1">
              <h2 class="text-lg font-semibold">
                {(conversationState().title ?? 'Conversation') + ' · '}
                {selectedAgent()?.name ?? 'Choose an active agent'}
              </h2>
              <p class="text-xs text-slate-400">Streaming responses via WebSocket ({socketUrlHint()}).</p>
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
                onClick={() => void handleCreateConversation()}
              >
                New Conversation
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
                onClick={() => void handleSendMessage()}
              >
                Send
              </button>
              <Show when={isStreaming()}>
                <span class="text-xs text-slate-400">Agents are responding…</span>
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
