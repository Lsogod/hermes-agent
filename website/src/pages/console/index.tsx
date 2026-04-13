import React, {useEffect, useMemo, useRef, useState} from 'react';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import styles from './styles.module.css';

type MessageRole = 'user' | 'assistant' | 'error' | 'system' | 'tool';
type RunStatus = 'idle' | 'connecting' | 'streaming' | 'complete' | 'error' | 'cancelled';
type SessionView = 'web' | 'gateway';
type RemoteState = 'idle' | 'loading' | 'ready' | 'error';

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  pending?: boolean;
  toolName?: string;
}

interface ConsoleSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  messageCount?: number;
  messages: ChatMessage[];
  toolEvents: ToolEvent[];
  serverSessionId?: string;
  totalUsage?: Usage;
}

interface ToolEvent {
  id: string;
  type: 'started' | 'completed';
  tool: string;
  label: string;
  emoji?: string;
  timestamp: number;
  duration?: number;
  error?: boolean;
  args?: string;
  result?: string;
}

interface GatewaySessionSummary {
  id: string;
  source: string;
  model?: string | null;
  title?: string | null;
  preview?: string;
  started_at: number;
  ended_at?: number | null;
  last_active?: number;
  message_count?: number;
  is_active?: boolean;
}

interface GatewayMessageState {
  status: RemoteState;
  messages: ChatMessage[];
  error?: string;
  refreshedAt?: number;
}

interface LogViewerState {
  file: string;
  level: string;
  component: string;
  lines: number;
  entries: string[];
  status: RemoteState;
  error?: string;
  refreshedAt?: number;
  availableFiles: string[];
  availableComponents: string[];
}

interface ImageAttachment {
  name: string;
  dataUrl: string;
  size: number;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface RequestState {
  status: RunStatus;
  startedAt?: number;
  endedAt?: number;
  usage?: Usage;
  error?: string;
}

interface ConsoleSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  stream: boolean;
  personality: string;
  reasoning: string;
  yolo: boolean;
}

interface ConnectionState {
  state: 'idle' | 'probing' | 'ready' | 'error';
  message: string;
}

const STORAGE_KEY = 'hermes-web-console:v1';
const DEFAULT_MODEL = 'hermes-agent';
const DEFAULT_SETTINGS: ConsoleSettings = {
  endpoint: 'http://localhost:8642/v1',
  apiKey: 'change-me-local-dev',
  model: DEFAULT_MODEL,
  systemPrompt: '',
  stream: true,
  personality: '',
  reasoning: 'medium',
  yolo: false,
};

const PERSONALITIES: {name: string; label: string; prompt: string}[] = [
  {name: 'default', label: '默认', prompt: ''},
  {name: 'concise', label: '简洁', prompt: 'Be concise. Respond with the minimum necessary words. No fluff, no filler.'},
  {name: 'expert', label: '专家', prompt: 'You are a senior staff engineer. Provide thorough, technically precise responses with concrete examples and edge-case analysis.'},
  {name: 'teacher', label: '教师', prompt: 'Explain concepts step by step as if teaching a student. Use analogies and examples.'},
  {name: 'creative', label: '创意', prompt: 'Be creative, think outside the box. Explore unconventional approaches and novel solutions.'},
  {name: 'reviewer', label: '审查员', prompt: 'Act as a meticulous code reviewer. Focus on correctness, security, performance, and maintainability.'},
];

const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const LOG_LEVEL_OPTIONS = ['', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;
const DEFAULT_LOG_STATE: LogViewerState = {
  file: 'gateway',
  level: '',
  component: '',
  lines: 160,
  entries: [],
  status: 'idle',
  availableFiles: ['agent', 'errors', 'gateway'],
  availableComponents: [],
};

const QUICK_PROMPTS = [
  '检查当前项目并总结整体架构。',
  '列出可用工具，并说明各自适合的场景。',
  '审查仓库里的新手入门问题。',
  '为当前分支起草一份发布检查清单。',
];

const SLASH_COMMANDS = [
  {name: '/help', description: '显示可用命令列表'},
  {name: '/clear', description: '清空当前会话'},
  {name: '/new', description: '创建新会话'},
  {name: '/retry', description: '重新发送上一条消息'},
  {name: '/undo', description: '撤销最近一轮对话'},
  {name: '/title', description: '设置会话标题 (/title 新标题)'},
  {name: '/usage', description: '显示当前会话 Token 用量'},
  {name: '/model', description: '显示/切换模型信息'},
  {name: '/tools', description: '显示工具执行记录'},
  {name: '/status', description: '显示会话详细状态'},
  {name: '/personality', description: '切换人格预设 (/personality expert)'},
  {name: '/reasoning', description: '设置推理深度 (/reasoning high)'},
  {name: '/yolo', description: '切换 YOLO 模式 (跳过确认)'},
  {name: '/export', description: '导出当前会话为 JSON'},
];

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function createSession(): ConsoleSession {
  const now = Date.now();
  return {
    id: makeId('session'),
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    toolEvents: [],
  };
}

function normalizeEndpoint(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function normalizeApiRoot(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

function extractHost(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return '--';
  }
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    return url.host;
  } catch {
    return trimmed;
  }
}

function formatRelativeTime(timestamp: number): string {
  const diffSeconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds} 秒前`;
  }
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }
  return `${Math.round(diffHours / 24)} 天前`;
}

function formatDuration(state: RequestState): string {
  if (!state.startedAt) {
    return '空闲';
  }
  const end = state.endedAt ?? Date.now();
  const diff = Math.max(0, end - state.startedAt);
  if (diff < 1000) {
    return `${diff} ms`;
  }
  return `${(diff / 1000).toFixed(diff < 10000 ? 1 : 0)} s`;
}

function summarizeSessionTitle(input: string): string {
  const compact = input.trim().replace(/\s+/g, ' ');
  if (!compact) {
    return '新会话';
  }
  return compact.length > 44 ? `${compact.slice(0, 44)}...` : compact;
}

function formatRole(role: MessageRole): string {
  switch (role) {
    case 'user':
      return '用户';
    case 'assistant':
      return 'Hermes';
    case 'system':
      return '系统';
    case 'tool':
      return '工具';
    case 'error':
      return '错误';
    default:
      return role;
  }
}

function normalizeMessageRole(role: unknown): MessageRole {
  if (role === 'user' || role === 'assistant' || role === 'error' || role === 'system' || role === 'tool') {
    return role;
  }
  return 'assistant';
}

function normalizeMessageTimestamp(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return Date.now();
  }
  return value > 1_000_000_000_000 ? value : Math.round(value * 1000);
}

function formatSourceLabel(source: string | null | undefined): string {
  if (!source) {
    return 'unknown';
  }
  switch (source) {
    case 'api_server':
      return 'API Server';
    case 'wechat':
      return 'WeChat';
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord';
    case 'slack':
      return 'Slack';
    case 'whatsapp':
      return 'WhatsApp';
    case 'cli':
      return 'CLI';
    default:
      return source;
  }
}

function formatMessageCount(value: number | undefined): string {
  return typeof value === 'number' ? `${value} 条消息` : '--';
}

function mapGatewayMessage(message: Record<string, unknown>): ChatMessage {
  const toolName = typeof message.tool_name === 'string' ? message.tool_name : undefined;
  const content = typeof message.content === 'string'
    ? message.content
    : toolName
      ? `工具 ${toolName} 已执行。`
      : '';

  return {
    id: `gateway-${String(message.id ?? makeId('msg'))}`,
    role: normalizeMessageRole(message.role),
    content,
    createdAt: normalizeMessageTimestamp(message.timestamp),
    toolName,
  };
}

function usageFromSessionSummary(summary: GatewaySessionSummary & Record<string, unknown>): Usage | undefined {
  const prompt = typeof summary.input_tokens === 'number' ? summary.input_tokens : undefined;
  const completion = typeof summary.output_tokens === 'number' ? summary.output_tokens : undefined;
  const total = typeof summary.total_tokens === 'number'
    ? summary.total_tokens
    : (prompt ?? 0) + (completion ?? 0);

  if (prompt == null && completion == null && !total) {
    return undefined;
  }

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || undefined,
  };
}

function mapWebSessionSummary(
  summary: GatewaySessionSummary & Record<string, unknown>,
  existing?: ConsoleSession,
): ConsoleSession {
  return {
    id: summary.id,
    title: summary.title || summary.preview || existing?.title || '新会话',
    createdAt: normalizeMessageTimestamp(summary.started_at),
    updatedAt: normalizeMessageTimestamp(summary.last_active ?? summary.started_at),
    preview: summary.preview || existing?.preview,
    messageCount: typeof summary.message_count === 'number' ? summary.message_count : existing?.messageCount,
    messages: existing?.messages ?? [],
    toolEvents: existing?.toolEvents ?? [],
    serverSessionId: summary.id,
    totalUsage: usageFromSessionSummary(summary) ?? existing?.totalUsage,
  };
}

function formatRunStatus(status: RunStatus): string {
  switch (status) {
    case 'idle':
      return '空闲';
    case 'connecting':
      return '连接中';
    case 'streaming':
      return '流式返回中';
    case 'complete':
      return '已完成';
    case 'error':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}

function buildRequestMessages(
  messages: ChatMessage[],
  systemPrompt: string,
): Array<{role: 'system' | 'user' | 'assistant'; content: string}> {
  const history: Array<{role: 'user' | 'assistant'; content: string}> = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content,
    }));

  if (!systemPrompt.trim()) {
    return history;
  }

  return [
    {role: 'system', content: systemPrompt.trim()},
    ...history,
  ];
}

function parseErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload && 'error' in payload) {
    const inner = (payload as {error?: {message?: string}}).error;
    if (inner?.message) {
      return inner.message;
    }
  }
  return fallback;
}

function accumulateUsage(prev: Usage | undefined, delta: Usage | undefined): Usage {
  if (!delta) {
    return prev ?? {};
  }
  return {
    prompt_tokens: (prev?.prompt_tokens ?? 0) + (delta.prompt_tokens ?? 0),
    completion_tokens: (prev?.completion_tokens ?? 0) + (delta.completion_tokens ?? 0),
    total_tokens: (prev?.total_tokens ?? 0) + (delta.total_tokens ?? 0),
  };
}

function renderInlineTokens(text: string): React.ReactNode[] {
  // Handle: **bold**, *italic*, `inline code`, [link](url)
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`\n]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(regex);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && !part.startsWith('**')) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i} className={styles.inlineCode}>{part.slice(1, -1)}</code>;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return <a key={i} className={styles.mdLink} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">{linkMatch[1]}</a>;
    }
    return part;
  });
}

function CodeBlock({lang, code}: {lang: string; code: string}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  function handleCopy(): void {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <pre className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        {lang ? <span className={styles.codeLang}>{lang}</span> : <span />}
        <button type="button" className={styles.codeCopyBtn} onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <code>{code}</code>
    </pre>
  );
}

function renderBlock(line: string, key: string | number): React.ReactNode {
  // Headings
  const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const Tag = `h${Math.min(level + 2, 6)}` as keyof React.JSX.IntrinsicElements;
    return <Tag key={key} className={styles.mdHeading}>{renderInlineTokens(headingMatch[2])}</Tag>;
  }
  // Horizontal rule
  if (/^[-*_]{3,}\s*$/.test(line)) {
    return <hr key={key} className={styles.mdHr} />;
  }
  return null;
}

function renderMessageContent(content: string): React.ReactNode {
  if (!content) {
    return null;
  }

  // Split by fenced code blocks first
  const segments = content.split(/(```[\s\S]*?```)/g);
  const elements: React.ReactNode[] = [];

  segments.forEach((segment, segIdx) => {
    if (segment.startsWith('```') && segment.endsWith('```')) {
      const body = segment.slice(3, -3);
      const nlPos = body.indexOf('\n');
      const lang = nlPos >= 0 ? body.slice(0, nlPos).trim() : '';
      const code = nlPos >= 0 ? body.slice(nlPos + 1) : body;
      elements.push(<CodeBlock key={`code-${segIdx}`} lang={lang} code={code} />);
      return;
    }

    if (!segment.trim()) {
      return;
    }

    // Process line-level markdown within non-code segments
    const lines = segment.split('\n');
    let listBuffer: {ordered: boolean; items: string[]} | null = null;

    const flushList = (): void => {
      if (!listBuffer) {
        return;
      }
      const Tag = listBuffer.ordered ? 'ol' : 'ul';
      elements.push(
        <Tag key={`list-${segIdx}-${elements.length}`} className={styles.mdList}>
          {listBuffer.items.map((item, li) => (
            <li key={li}>{renderInlineTokens(item)}</li>
          ))}
        </Tag>,
      );
      listBuffer = null;
    };

    lines.forEach((line, lineIdx) => {
      const lineKey = `${segIdx}-${lineIdx}`;

      // Unordered list item
      const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (ulMatch) {
        if (listBuffer && listBuffer.ordered) {
          flushList();
        }
        if (!listBuffer) {
          listBuffer = {ordered: false, items: []};
        }
        listBuffer.items.push(ulMatch[2]);
        return;
      }

      // Ordered list item
      const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
      if (olMatch) {
        if (listBuffer && !listBuffer.ordered) {
          flushList();
        }
        if (!listBuffer) {
          listBuffer = {ordered: true, items: []};
        }
        listBuffer.items.push(olMatch[2]);
        return;
      }

      flushList();

      // Block-level elements
      const block = renderBlock(line, lineKey);
      if (block) {
        elements.push(block);
        return;
      }

      // Plain text (preserve whitespace/newlines)
      if (line === '') {
        elements.push(<br key={lineKey} />);
      } else {
        elements.push(
          <span key={lineKey} className={styles.proseText}>
            {renderInlineTokens(line)}
            {'\n'}
          </span>,
        );
      }
    });

    flushList();
  });

  return <div className={styles.mdBody}>{elements}</div>;
}

export default function ConsolePage(): React.JSX.Element {
  const [hydrated, setHydrated] = useState(false);
  const [sessions, setSessions] = useState<ConsoleSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [sessionView, setSessionView] = useState<SessionView>('web');
  const [settings, setSettings] = useState<ConsoleSettings>(DEFAULT_SETTINGS);
  const [composer, setComposer] = useState('');
  const [requestState, setRequestState] = useState<RequestState>({status: 'idle'});
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    state: 'idle',
    message: '等待连接检测',
  });
  const [models, setModels] = useState<string[]>([DEFAULT_MODEL]);
  const [backendMeta, setBackendMeta] = useState<{provider: string; model: string} | null>(null);
  const [webSessionsState, setWebSessionsState] = useState<RemoteState>('idle');
  const [webSessionsError, setWebSessionsError] = useState('');
  const [gatewaySessions, setGatewaySessions] = useState<GatewaySessionSummary[]>([]);
  const [gatewaySessionsState, setGatewaySessionsState] = useState<RemoteState>('idle');
  const [gatewaySessionsError, setGatewaySessionsError] = useState('');
  const [currentGatewaySessionId, setCurrentGatewaySessionId] = useState('');
  const [gatewayMessagesBySession, setGatewayMessagesBySession] = useState<Record<string, GatewayMessageState>>({});
  const [logState, setLogState] = useState<LogViewerState>(DEFAULT_LOG_STATE);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [imageAttachment, setImageAttachment] = useState<ImageAttachment | null>(null);
  const [sessionSearch, setSessionSearch] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);

  useEffect(() => {
    setHydrated(true);
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        settings?: ConsoleSettings;
        sessions?: ConsoleSession[];
        currentSessionId?: string;
        sessionView?: SessionView;
      };

      const restoredSessions = (parsed.sessions ?? []).map((session) => ({
        ...session,
        title: session.title === 'New thread' ? '新会话' : session.title,
        toolEvents: Array.isArray(session.toolEvents) ? session.toolEvents : [],
      }));
      const restoredSettings = parsed.settings ? {...DEFAULT_SETTINGS, ...parsed.settings} : DEFAULT_SETTINGS;

      setSessions(restoredSessions);
      setSettings(restoredSettings);
      setSessionView(parsed.sessionView === 'gateway' ? 'gateway' : 'web');
      setCurrentSessionId(parsed.currentSessionId ?? '');
    } catch {
      setSessions([]);
      setCurrentSessionId('');
    }
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        settings,
        sessions,
        currentSessionId,
        sessionView,
      }),
    );
  }, [currentSessionId, hydrated, sessionView, sessions, settings]);

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? sessions[0],
    [currentSessionId, sessions],
  );
  const currentGatewaySession = useMemo(
    () => gatewaySessions.find((session) => session.id === currentGatewaySessionId) ?? gatewaySessions[0],
    [currentGatewaySessionId, gatewaySessions],
  );
  const toolEvents = currentSession?.toolEvents ?? [];
  const currentGatewayMessageState = currentGatewaySession
    ? gatewayMessagesBySession[currentGatewaySession.id]
    : undefined;

  useEffect(() => {
    if (!currentSession && sessions.length) {
      setCurrentSessionId(sessions[0].id);
    }
  }, [currentSession, sessions]);

  useEffect(() => {
    if (!currentGatewaySession && gatewaySessions.length) {
      setCurrentGatewaySessionId(gatewaySessions[0].id);
    }
  }, [currentGatewaySession, gatewaySessions]);

  const endpoint = normalizeEndpoint(settings.endpoint);
  const apiRoot = normalizeApiRoot(settings.endpoint);
  const activeMessages = sessionView === 'gateway'
    ? (currentGatewayMessageState?.messages ?? [])
    : (currentSession?.messages ?? []);
  const activeToolEvents = sessionView === 'gateway' ? [] : toolEvents;
  const transcriptCount = currentSession?.messages.filter((message) => message.role !== 'error').length ?? 0;

  function buildAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers = {...extra};
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    }
    return headers;
  }

  function scrollMessagesToBottom(instant?: boolean): void {
    const container = messagesRef.current;
    if (!container) {
      return;
    }
    if (instant) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTo({top: container.scrollHeight, behavior: 'smooth'});
    }
  }

  function handleMessagesScroll(): void {
    const container = messagesRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 120;
  }

  useEffect(() => {
    if (userScrolledUpRef.current) {
      return;
    }
    // Streaming: instant scroll so it keeps up; otherwise smooth
    scrollMessagesToBottom(requestState.status === 'streaming');
  }, [activeMessages, activeToolEvents, requestState.status]);

  // Always scroll to bottom when user sends a new message
  useEffect(() => {
    if (requestState.status === 'connecting') {
      userScrolledUpRef.current = false;
      scrollMessagesToBottom(true);
    }
  }, [requestState.status]);

  function patchSession(sessionId: string, updater: (session: ConsoleSession) => ConsoleSession): void {
    setSessions((prev) => prev.map((session) => (
      session.id === sessionId ? updater(session) : session
    )));
  }

  function patchCurrentSession(updater: (session: ConsoleSession) => ConsoleSession): void {
    if (!currentSessionId) {
      return;
    }
    patchSession(currentSessionId, updater);
  }

  function patchMessage(
    sessionId: string,
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage,
  ): void {
    patchSession(sessionId, (session) => ({
      ...session,
      updatedAt: Date.now(),
      messages: session.messages.map((message) => (
        message.id === messageId ? updater(message) : message
      )),
    }));
  }

  function patchSessionToolEvents(
    sessionId: string,
    updater: (events: ToolEvent[]) => ToolEvent[],
  ): void {
    patchSession(sessionId, (session) => ({
      ...session,
      updatedAt: Date.now(),
      toolEvents: updater(session.toolEvents ?? []),
    }));
  }

  function appendToolEvent(
    sessionId: string,
    event: {type?: string; tool: string; label?: string; emoji?: string; duration?: number; error?: boolean; args?: string; result?: string},
  ): void {
    if (event.type === 'completed') {
      patchSessionToolEvents(sessionId, (prev) => {
        const idx = prev.findIndex((e) => e.tool === event.tool && e.type === 'started');
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            type: 'completed',
            duration: event.duration,
            error: event.error,
            result: event.result ?? updated[idx].result,
          };
          return updated;
        }
        return [
          {
            id: makeId('tool'),
            type: 'completed',
            tool: event.tool,
            label: event.label ?? event.tool,
            emoji: event.emoji,
            timestamp: Date.now(),
            duration: event.duration,
            error: event.error,
            result: event.result,
          },
          ...prev,
        ];
      });
      return;
    }
    patchSessionToolEvents(sessionId, (prev) => [
      {
        id: makeId('tool'),
        type: 'started',
        tool: event.tool,
        label: event.label ?? event.tool,
        emoji: event.emoji,
        timestamp: Date.now(),
        args: event.args,
        result: event.result,
      },
      ...prev,
    ]);
  }

  async function probeModels(): Promise<void> {
    if (!endpoint) {
      setConnectionState({
        state: 'error',
        message: '请先填写接口地址。',
      });
      return;
    }

    setConnectionState({
      state: 'probing',
      message: '正在检查 /v1/models ...',
    });

    try {
      const response = await fetch(`${endpoint}/models`, {
        headers: buildAuthHeaders(),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Model probe failed with ${response.status}`));
      }

      const dataItems = Array.isArray(payload?.data) ? payload.data : [];

      const ids = dataItems
        .map((item: {id?: string}) => item?.id)
        .filter((value: unknown): value is string => typeof value === 'string' && Boolean(value));

      const firstItem = dataItems[0] as {meta?: {provider?: string; model?: string}} | undefined;
      if (firstItem?.meta?.provider && firstItem?.meta?.model) {
        setBackendMeta({provider: firstItem.meta.provider, model: firstItem.meta.model});
      } else {
        setBackendMeta(null);
      }

      const nextModels = ids.length ? ids : [DEFAULT_MODEL];
      setModels(nextModels);
      setSettings((prev) => ({
        ...prev,
        model: nextModels.includes(prev.model) ? prev.model : nextModels[0],
      }));
      setConnectionState({
        state: 'ready',
        message: `已连接，发现 ${nextModels.length} 个模型。`,
      });
    } catch (error) {
      setConnectionState({
        state: 'error',
        message: error instanceof Error ? error.message : '无法连接 Hermes API Server。',
      });
    }
  }

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    void probeModels();
  }, [hydrated, endpoint, settings.apiKey]);

  async function fetchWebSessions(silent = false): Promise<void> {
    if (!apiRoot) {
      return;
    }
    if (!silent) {
      setWebSessionsState('loading');
      setWebSessionsError('');
    }

    try {
      const response = await fetch(
        `${apiRoot}/api/sessions?source=${encodeURIComponent('api_server')}&limit=80`,
        {headers: buildAuthHeaders()},
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Web session fetch failed with ${response.status}`));
      }

      const items = Array.isArray(payload?.sessions) ? payload.sessions as Array<GatewaySessionSummary & Record<string, unknown>> : [];
      setSessions((prev) => {
        const previousById = new Map(prev.map((session) => [session.serverSessionId || session.id, session]));
        return items.map((session) => mapWebSessionSummary(session, previousById.get(session.id)));
      });
      setWebSessionsState('ready');
      setWebSessionsError('');
      setCurrentSessionId((prev) => {
        if (prev && items.some((item) => item.id === prev)) {
          return prev;
        }
        return items[0]?.id ?? '';
      });
    } catch (error) {
      setWebSessionsState('error');
      setWebSessionsError(error instanceof Error ? error.message : '无法加载 Web 会话。');
    }
  }

  async function fetchWebSessionMessages(sessionId: string, silent = false): Promise<void> {
    if (!apiRoot || !sessionId) {
      return;
    }

    patchSession(sessionId, (session) => ({
      ...session,
      messages: silent && session.messages.length ? session.messages : [],
    }));

    try {
      const response = await fetch(`${apiRoot}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: buildAuthHeaders(),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Message fetch failed with ${response.status}`));
      }

      const items = Array.isArray(payload?.messages) ? payload.messages : [];
      patchSession(sessionId, (session) => ({
        ...session,
        updatedAt: Date.now(),
        messages: items.map((message: Record<string, unknown>) => mapGatewayMessage(message)),
        messageCount: items.length,
        preview: session.preview || (typeof items[0]?.content === 'string' ? items[0].content.slice(0, 80) : session.preview),
      }));
    } catch (error) {
      if (!silent) {
        setRequestState({
          status: 'error',
          startedAt: Date.now(),
          endedAt: Date.now(),
          error: error instanceof Error ? error.message : '无法加载 Web 会话消息。',
        });
      }
    }
  }

  async function createPersistedWebSession(title = '新会话'): Promise<ConsoleSession | null> {
    if (!apiRoot) {
      setConnectionState({
        state: 'error',
        message: '请先填写接口地址。',
      });
      return null;
    }

    try {
      const response = await fetch(`${apiRoot}/api/sessions`, {
        method: 'POST',
        headers: buildAuthHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify({
          title,
          source: 'api_server',
          model: settings.model || DEFAULT_MODEL,
          system_prompt: settings.systemPrompt || undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Session create failed with ${response.status}`));
      }

      const session = mapWebSessionSummary(payload as GatewaySessionSummary & Record<string, unknown>);
      setSessions((prev) => [session, ...prev.filter((item) => item.id !== session.id)]);
      setCurrentSessionId(session.id);
      setSessionView('web');
      return session;
    } catch (error) {
      setConnectionState({
        state: 'error',
        message: error instanceof Error ? error.message : '无法创建 Web 会话。',
      });
      return null;
    }
  }

  async function updatePersistedWebSession(sessionId: string, title: string): Promise<void> {
    if (!apiRoot || !sessionId) {
      return;
    }
    try {
      const response = await fetch(`${apiRoot}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: buildAuthHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify({title}),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Session update failed with ${response.status}`));
      }

      patchSession(sessionId, (session) => ({
        ...session,
        title: (payload.title as string) || title,
        updatedAt: normalizeMessageTimestamp(payload.last_active ?? payload.started_at ?? Date.now()),
      }));
    } catch {
      // Keep local title; failure is non-fatal.
    }
  }

  async function deletePersistedWebSession(sessionId: string): Promise<void> {
    if (!apiRoot || !sessionId) {
      return;
    }

    const response = await fetch(`${apiRoot}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: buildAuthHeaders(),
    });
    if (!response.ok) {
      let message = `Delete failed with ${response.status}`;
      try {
        const payload = await response.json();
        message = parseErrorMessage(payload, message);
      } catch {
        // Ignore response parsing failure.
      }
      throw new Error(message);
    }
  }

  async function fetchGatewaySessions(silent = false): Promise<void> {
    if (!apiRoot) {
      return;
    }
    if (!silent) {
      setGatewaySessionsState('loading');
      setGatewaySessionsError('');
    }

    try {
      const response = await fetch(
        `${apiRoot}/api/sessions?exclude_sources=${encodeURIComponent('api_server')}&limit=80`,
        {
          headers: buildAuthHeaders(),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Session fetch failed with ${response.status}`));
      }

      const items = Array.isArray(payload?.sessions) ? payload.sessions : [];
      setGatewaySessions(items as GatewaySessionSummary[]);
      setGatewaySessionsState('ready');
      setGatewaySessionsError('');
      setCurrentGatewaySessionId((prev) => {
        if (prev && items.some((item: GatewaySessionSummary) => item.id === prev)) {
          return prev;
        }
        return items[0]?.id ?? '';
      });
    } catch (error) {
      setGatewaySessionsState('error');
      setGatewaySessionsError(error instanceof Error ? error.message : '无法加载服务端会话。');
    }
  }

  async function fetchGatewayMessages(sessionId: string, silent = false): Promise<void> {
    if (!apiRoot || !sessionId) {
      return;
    }

    setGatewayMessagesBySession((prev) => ({
      ...prev,
      [sessionId]: {
        status: silent && prev[sessionId]?.messages?.length ? prev[sessionId].status : 'loading',
        messages: prev[sessionId]?.messages ?? [],
        error: undefined,
        refreshedAt: prev[sessionId]?.refreshedAt,
      },
    }));

    try {
      const response = await fetch(`${apiRoot}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: buildAuthHeaders(),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Message fetch failed with ${response.status}`));
      }

      const items = Array.isArray(payload?.messages) ? payload.messages : [];
      setGatewayMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: {
          status: 'ready',
          messages: items.map((message: Record<string, unknown>) => mapGatewayMessage(message)),
          error: undefined,
          refreshedAt: Date.now(),
        },
      }));
    } catch (error) {
      setGatewayMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: {
          status: 'error',
          messages: prev[sessionId]?.messages ?? [],
          error: error instanceof Error ? error.message : '无法加载会话消息。',
          refreshedAt: prev[sessionId]?.refreshedAt,
        },
      }));
    }
  }

  async function fetchLogs(silent = false): Promise<void> {
    if (!apiRoot) {
      return;
    }

    setLogState((prev) => ({
      ...prev,
      status: silent && prev.entries.length ? prev.status : 'loading',
      error: undefined,
    }));

    const params = new URLSearchParams({
      file: logState.file,
      lines: String(logState.lines),
    });
    if (logState.level) {
      params.set('level', logState.level);
    }
    if (logState.component) {
      params.set('component', logState.component);
    }

    try {
      const response = await fetch(`${apiRoot}/api/logs?${params.toString()}`, {
        headers: buildAuthHeaders(),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Log fetch failed with ${response.status}`));
      }

      setLogState((prev) => ({
        ...prev,
        entries: Array.isArray(payload?.lines) ? payload.lines : [],
        status: 'ready',
        error: undefined,
        refreshedAt: Date.now(),
        availableFiles: Array.isArray(payload?.available_files) && payload.available_files.length
          ? payload.available_files
          : prev.availableFiles,
        availableComponents: Array.isArray(payload?.available_components)
          ? payload.available_components
          : prev.availableComponents,
      }));
    } catch (error) {
      setLogState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : '无法读取日志。',
      }));
    }
  }

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    void fetchWebSessions();
    const timer = window.setInterval(() => {
      void fetchWebSessions(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [apiRoot, hydrated, settings.apiKey]);

  useEffect(() => {
    if (!hydrated || !currentSessionId) {
      return;
    }
    if (requestState.status === 'connecting' || requestState.status === 'streaming') {
      return;
    }
    void fetchWebSessionMessages(currentSessionId);
    const timer = window.setInterval(() => {
      void fetchWebSessionMessages(currentSessionId, true);
    }, sessionView === 'web' ? 5000 : 15000);
    return () => window.clearInterval(timer);
  }, [apiRoot, currentSessionId, hydrated, requestState.status, sessionView, settings.apiKey]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    void fetchGatewaySessions();
    const timer = window.setInterval(() => {
      void fetchGatewaySessions(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [apiRoot, hydrated, settings.apiKey]);

  useEffect(() => {
    if (!hydrated || !currentGatewaySessionId) {
      return;
    }
    void fetchGatewayMessages(currentGatewaySessionId);
    const timer = window.setInterval(() => {
      void fetchGatewayMessages(currentGatewaySessionId, true);
    }, sessionView === 'gateway' ? 5000 : 15000);
    return () => window.clearInterval(timer);
  }, [apiRoot, currentGatewaySessionId, hydrated, sessionView, settings.apiKey]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    void fetchLogs();
    const timer = window.setInterval(() => {
      void fetchLogs(true);
    }, 6000);
    return () => window.clearInterval(timer);
  }, [apiRoot, hydrated, logState.component, logState.file, logState.level, logState.lines, settings.apiKey]);

  async function consumeStreamingResponse(
    response: Response,
    sessionId: string,
    assistantMessageId: string,
  ): Promise<void> {
    if (!response.body) {
      throw new Error('流式响应体不存在。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantText = '';
    let finalUsage: Usage | undefined;

    const handleEvent = (rawEvent: string): boolean => {
      const lines = rawEvent.split(/\r?\n/);
      let eventName = 'message';
      const dataLines: string[] = [];

      for (const line of lines) {
        if (!line || line.startsWith(':')) {
          continue;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (!dataLines.length) {
        return false;
      }

      const data = dataLines.join('\n');
      if (data === '[DONE]') {
        return true;
      }

      if (eventName === 'hermes.tool.progress') {
        try {
          const payload = JSON.parse(data) as {type?: string; tool: string; label?: string; emoji?: string; duration?: number; error?: boolean; args?: string; result?: string};
          appendToolEvent(sessionId, payload);
          setRequestState((prev) => ({
            ...prev,
            status: prev.status === 'connecting' ? 'streaming' : prev.status,
          }));
        } catch {
          // Ignore malformed tool events; they are auxiliary.
        }
        return false;
      }

      const payload = JSON.parse(data) as {
        choices?: Array<{delta?: {content?: string}; finish_reason?: string | null}>;
        usage?: Usage;
      };
      const delta = payload.choices?.[0]?.delta?.content;

      if (delta) {
        assistantText += delta;
        patchMessage(sessionId, assistantMessageId, (message) => ({
          ...message,
          content: assistantText,
          pending: true,
        }));
        setRequestState((prev) => ({
          ...prev,
          status: 'streaming',
        }));
      }

      if (payload.usage) {
        finalUsage = payload.usage;
      }

      return false;
    };

    while (true) {
      const {value, done} = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, {stream: true}).replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (rawEvent) {
          const reachedDone = handleEvent(rawEvent);
          if (reachedDone) {
            patchMessage(sessionId, assistantMessageId, (message) => ({
              ...message,
              pending: false,
            }));
            setRequestState((prev) => ({
              ...prev,
              status: 'complete',
              endedAt: Date.now(),
              usage: finalUsage,
            }));
            return;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    patchMessage(sessionId, assistantMessageId, (message) => ({
      ...message,
      pending: false,
    }));
    setRequestState((prev) => ({
      ...prev,
      status: 'complete',
      endedAt: Date.now(),
      usage: finalUsage,
    }));
  }

  async function sendMessage(text: string): Promise<void> {
    if (!text.trim() || requestState.status === 'connecting' || requestState.status === 'streaming') {
      return;
    }

    if (!endpoint) {
      setConnectionState({
        state: 'error',
        message: '发送前请先填写接口地址。',
      });
      return;
    }

    const ensuredSession = currentSession ?? await createPersistedWebSession();
    if (!ensuredSession) {
      return;
    }

    const sessionId = ensuredSession.serverSessionId ?? ensuredSession.id;
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: imageAttachment ? `${text.trim()}\n\n📷 *已附加图片: ${imageAttachment.name}*` : text.trim(),
      createdAt: now,
    };

    const assistantMessage: ChatMessage = {
      id: makeId('assistant'),
      role: 'assistant',
      content: '',
      createdAt: now,
      pending: true,
    };

    const outboundMessages = buildRequestMessages(
      [userMessage],
      settings.systemPrompt,
    );

    // If there's an image attachment, make the last user message multimodal
    if (imageAttachment) {
      const lastIdx = outboundMessages.length - 1;
      if (lastIdx >= 0 && outboundMessages[lastIdx].role === 'user') {
        (outboundMessages[lastIdx] as any).content = [
          {type: 'image_url', image_url: {url: imageAttachment.dataUrl}},
          {type: 'text', text: text.trim()},
        ];
      }
    }

    patchSession(sessionId, (session) => ({
      ...session,
      title: session.messages.length === 0 ? summarizeSessionTitle(text) : session.title,
      updatedAt: now,
      messages: [...session.messages, userMessage, assistantMessage],
      messageCount: (session.messageCount ?? session.messages.length) + 2,
      preview: text.trim(),
      serverSessionId: session.serverSessionId ?? session.id,
    }));

    setComposer('');
    setImageAttachment(null);
    setRequestState({
      status: 'connecting',
      startedAt: now,
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(),
      };
      requestHeaders['X-Hermes-Session-Id'] = sessionId;

      const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          model: settings.model || DEFAULT_MODEL,
          stream: settings.stream,
          messages: outboundMessages,
          ...(settings.reasoning && settings.reasoning !== 'medium' ? {reasoning_effort: settings.reasoning} : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Request failed with ${response.status}`;
        try {
          const payload = await response.json();
          message = parseErrorMessage(payload, message);
        } catch {
          const textPayload = await response.text();
          if (textPayload) {
            message = textPayload;
          }
        }
        throw new Error(message);
      }

      const returnedSessionId = response.headers.get('X-Hermes-Session-Id');
      if (returnedSessionId) {
        patchSession(sessionId, (session) => ({...session, serverSessionId: returnedSessionId}));
      }

      let requestUsage: Usage | undefined;

      if (settings.stream) {
        await consumeStreamingResponse(response, sessionId, assistantMessage.id);
        // Read usage that was set during streaming
        setRequestState((prev) => {
          requestUsage = prev.usage;
          return prev;
        });
      } else {
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content ?? '（未生成回复）';
        requestUsage = payload?.usage;
        patchMessage(sessionId, assistantMessage.id, (message) => ({
          ...message,
          content,
          pending: false,
        }));
        setRequestState({
          status: 'complete',
          startedAt: now,
          endedAt: Date.now(),
          usage: requestUsage,
        });
      }

      // Accumulate token usage into session for persistent tracking
      if (requestUsage) {
        patchSession(sessionId, (session) => ({
          ...session,
          totalUsage: accumulateUsage(session.totalUsage, requestUsage),
        }));
      }

      if (ensuredSession.messages.length === 0) {
        const nextTitle = summarizeSessionTitle(text);
        patchSession(sessionId, (session) => ({...session, title: nextTitle}));
        void updatePersistedWebSession(sessionId, nextTitle);
      }

      void fetchWebSessionMessages(sessionId, true);
      void fetchWebSessions(true);

      setConnectionState({
        state: 'ready',
        message: '连接正常，可继续对话。',
      });
    } catch (error) {
      if (controller.signal.aborted) {
        patchMessage(sessionId, assistantMessage.id, (message) => ({
          ...message,
          pending: false,
          content: message.content || '本次运行已取消。',
        }));
        setRequestState((prev) => ({
          ...prev,
          status: 'cancelled',
          endedAt: Date.now(),
        }));
      } else {
        const message = error instanceof Error ? error.message : '请求失败。';
        patchMessage(sessionId, assistantMessage.id, () => ({
          id: assistantMessage.id,
          role: 'error',
          content: message,
          createdAt: now,
          pending: false,
        }));
        setRequestState({
          status: 'error',
          startedAt: now,
          endedAt: Date.now(),
          error: message,
        });
        setConnectionState({
          state: 'error',
          message,
        });
      }
    } finally {
      abortRef.current = null;
    }
  }

  // ── Slash commands ────────────────────────────────
  const filteredSlashCommands = useMemo(() => {
    if (!slashFilter) return SLASH_COMMANDS;
    const q = slashFilter.toLowerCase();
    return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(q));
  }, [slashFilter]);

  function executeSlashCommand(command: string): void {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    const insertInfoMessage = (content: string): void => {
      if (!currentSession) return;
      const msg: ChatMessage = {
        id: makeId('sys'),
        role: 'assistant',
        content,
        createdAt: Date.now(),
      };
      patchCurrentSession((s) => ({
        ...s,
        updatedAt: Date.now(),
        messages: [...s.messages, msg],
      }));
    };

    if (cmd === '/help') {
      const lines = SLASH_COMMANDS.map((c) => `\`${c.name}\` — ${c.description}`).join('\n- ');
      insertInfoMessage(`## 📋 可用命令\n\n- ${lines}\n\n> 在输入框中键入 \`/\` 可快速选择命令。`);

    } else if (cmd === '/clear') {
      void clearCurrentSession();

    } else if (cmd === '/new') {
      void createNewSession();

    } else if (cmd === '/retry') {
      if (!currentSession) return;
      insertInfoMessage('⚠️ 持久化 Web 会话当前不支持 `/retry`，因为服务端历史已经写入 SessionDB。请直接重新发送一条消息。');
      setComposer('');
      setShowSlashMenu(false);
      return;

    } else if (cmd === '/undo') {
      if (!currentSession || currentSession.messages.length === 0) {
        insertInfoMessage('⚠️ 没有可撤销的对话。');
      } else {
        insertInfoMessage('⚠️ 持久化 Web 会话当前不支持 `/undo`，因为服务端历史已经写入 SessionDB。请新建会话或删除当前会话。');
        setComposer('');
        setShowSlashMenu(false);
        return;
      }

    } else if (cmd === '/title') {
      if (!arg) {
        insertInfoMessage(`当前标题: **${currentSession?.title ?? '新会话'}**\n\n用法: \`/title 新标题\``);
      } else {
        patchCurrentSession((s) => ({...s, title: arg, updatedAt: Date.now()}));
        if (currentSession?.id) {
          void updatePersistedWebSession(currentSession.id, arg);
        }
        insertInfoMessage(`✏️ 会话标题已更新为: **${arg}**`);
      }

    } else if (cmd === '/usage') {
      const u = currentSession?.totalUsage;
      const msgCount = currentSession?.messages.filter((m) => m.role !== 'error').length ?? 0;
      insertInfoMessage(
        `## 📊 Token 用量\n\n` +
        `| 指标 | 值 |\n|------|------|\n` +
        `| 输入 Token | ${u?.prompt_tokens?.toLocaleString() ?? '--'} |\n` +
        `| 输出 Token | ${u?.completion_tokens?.toLocaleString() ?? '--'} |\n` +
        `| 总计 Token | ${u?.total_tokens?.toLocaleString() ?? '--'} |\n` +
        `| 会话消息数 | ${msgCount} |\n` +
        `| 创建时间 | ${currentSession ? new Date(currentSession.createdAt).toLocaleString() : '--'} |`,
      );

    } else if (cmd === '/model') {
      if (arg) {
        // Switch model
        if (models.includes(arg)) {
          setSettings((prev) => ({...prev, model: arg}));
          insertInfoMessage(`🤖 模型已切换为: **${arg}**`);
        } else {
          insertInfoMessage(`⚠️ 未知模型: \`${arg}\`\n\n可用模型: ${models.map((m) => `\`${m}\``).join(', ')}`);
        }
      } else {
        insertInfoMessage(
          `## 🤖 模型信息\n\n` +
          `- **接口模型**: ${settings.model}\n` +
          `- **提供商**: ${backendMeta?.provider ?? '未知'}\n` +
          `- **实际模型**: ${backendMeta?.model ?? settings.model}\n` +
          `- **端点**: ${settings.endpoint}\n` +
          `- **可用模型**: ${models.map((m) => `\`${m}\``).join(', ')}`,
        );
      }

    } else if (cmd === '/tools') {
      if (!toolEvents.length) {
        insertInfoMessage('## 🔧 工具记录\n\n当前会话暂无工具执行记录。');
      } else {
        const lines = toolEvents.slice(0, 30).map((e) => {
          const status = e.error ? '❌' : e.type === 'completed' ? '✅' : '⏳';
          const dur = e.duration != null ? ` (${e.duration.toFixed(1)}s)` : '';
          return `- ${status} ${e.emoji ?? '🔧'} **${e.tool}**${dur} — ${e.label}`;
        }).join('\n');
        insertInfoMessage(`## 🔧 工具执行记录 (最近 ${Math.min(toolEvents.length, 30)} 条)\n\n${lines}`);
      }

    } else if (cmd === '/status') {
      const session = currentSession;
      const u = session?.totalUsage;
      insertInfoMessage(
        `## 📋 会话状态\n\n` +
        `- **会话 ID**: \`${session?.id ?? '--'}\`\n` +
        `- **服务端 Session**: \`${session?.serverSessionId ?? '未建立'}\`\n` +
        `- **标题**: ${session?.title ?? '--'}\n` +
        `- **消息数**: ${session?.messages.length ?? 0}\n` +
        `- **累计 Token**: ${u?.total_tokens?.toLocaleString() ?? '--'}\n` +
        `- **创建时间**: ${session ? new Date(session.createdAt).toLocaleString() : '--'}\n` +
        `- **最后更新**: ${session ? new Date(session.updatedAt).toLocaleString() : '--'}\n` +
        `- **流式模式**: ${settings.stream ? '✅ 开启' : '❌ 关闭'}\n` +
        `- **YOLO 模式**: ${settings.yolo ? '✅ 开启' : '❌ 关闭'}\n` +
        `- **人格**: ${settings.personality || '默认'}\n` +
        `- **推理深度**: ${settings.reasoning}\n` +
        `- **连接状态**: ${connectionState.message}`,
      );

    } else if (cmd === '/personality') {
      if (!arg) {
        const lines = PERSONALITIES.map((p) => `- \`${p.name}\` — ${p.label}${settings.personality === p.name ? ' ✅ 当前' : ''}`).join('\n');
        insertInfoMessage(`## 🎭 人格预设\n\n${lines}\n\n用法: \`/personality <name>\``);
      } else {
        const match = PERSONALITIES.find((p) => p.name === arg.toLowerCase());
        if (match) {
          setSettings((prev) => ({
            ...prev,
            personality: match.name,
            systemPrompt: match.prompt,
          }));
          insertInfoMessage(`🎭 已切换人格为: **${match.label}** (${match.name})`);
        } else {
          insertInfoMessage(`⚠️ 未知人格: \`${arg}\`\n\n可用: ${PERSONALITIES.map((p) => `\`${p.name}\``).join(', ')}`);
        }
      }

    } else if (cmd === '/reasoning') {
      if (!arg) {
        insertInfoMessage(`## 🧠 推理深度\n\n当前: **${settings.reasoning}**\n\n可用级别: ${REASONING_LEVELS.map((l) => `\`${l}\``).join(', ')}\n\n用法: \`/reasoning <level>\``);
      } else {
        const level = arg.toLowerCase();
        if ((REASONING_LEVELS as readonly string[]).includes(level)) {
          setSettings((prev) => ({...prev, reasoning: level}));
          insertInfoMessage(`🧠 推理深度已设为: **${level}**`);
        } else {
          insertInfoMessage(`⚠️ 未知推理级别: \`${arg}\`\n\n可用: ${REASONING_LEVELS.map((l) => `\`${l}\``).join(', ')}`);
        }
      }

    } else if (cmd === '/yolo') {
      setSettings((prev) => ({...prev, yolo: !prev.yolo}));
      insertInfoMessage(`⚡ YOLO 模式已${settings.yolo ? '关闭' : '开启'}。${!settings.yolo ? '\n\n> 危险操作将不再弹出确认提示。' : ''}`);

    } else if (cmd === '/export') {
      if (!currentSession) return;
      const exportData = {
        id: currentSession.id,
        title: currentSession.title,
        createdAt: new Date(currentSession.createdAt).toISOString(),
        updatedAt: new Date(currentSession.updatedAt).toISOString(),
        messages: currentSession.messages.map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: new Date(m.createdAt).toISOString(),
        })),
        totalUsage: currentSession.totalUsage,
        settings: {
          model: settings.model,
          personality: settings.personality,
          reasoning: settings.reasoning,
        },
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hermes-session-${currentSession.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      insertInfoMessage(`📥 会话已导出为 \`hermes-session-${currentSession.id}.json\``);

    } else {
      insertInfoMessage(`未知命令: \`${cmd}\`\n\n输入 \`/help\` 查看可用命令。`);
    }
    setComposer('');
    setShowSlashMenu(false);
  }

  // ── Image handling ──────────────────────────────────
  function handleImageUpload(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageAttachment({name: file.name, dataUrl: e.target?.result as string, size: file.size});
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }

  function handleComposerPaste(event: React.ClipboardEvent): void {
    const items = event.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = (e) => {
          setImageAttachment({name: file.name || 'clipboard.png', dataUrl: e.target?.result as string, size: file.size});
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) {
      return;
    }
    // Slash menu keyboard navigation
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashSelectedIdx((prev) => Math.min(prev + 1, filteredSlashCommands.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashSelectedIdx((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        executeSlashCommand(filteredSlashCommands[slashSelectedIdx].name);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (composer.startsWith('/')) {
        executeSlashCommand(composer.trim());
      } else {
        void sendMessage(composer);
      }
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    const hadOtherSessions = sessions.some((session) => session.id !== sessionId);
    if (requestState.status === 'streaming' || requestState.status === 'connecting') {
      if (sessionId === currentSessionId) {
        stopCurrentRun();
      }
    }
    try {
      await deletePersistedWebSession(sessionId);
      setSessions((prev) => {
        const next = prev.filter((session) => session.id !== sessionId);
        if (sessionId === currentSessionId) {
          const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
          setCurrentSessionId(sorted[0]?.id ?? '');
        }
        return next;
      });
      setRequestState({status: 'idle'});
      void fetchWebSessions(true);
      if (sessionId === currentSessionId && !hadOtherSessions) {
        void createNewSession();
      }
    } catch (error) {
      setConnectionState({
        state: 'error',
        message: error instanceof Error ? error.message : '删除会话失败。',
      });
    }
  }

  async function createNewSession(): Promise<void> {
    await createPersistedWebSession();
    setSessionView('web');
    setComposer('');
    setRequestState({status: 'idle'});
  }

  async function clearCurrentSession(): Promise<void> {
    if (!currentSession) {
      return;
    }
    if (currentSession.messages.length > 0 && !window.confirm('确认清空当前会话的所有消息？')) {
      return;
    }
    await deleteSession(currentSession.id);
    setComposer('');
    setRequestState({status: 'idle'});
  }

  function stopCurrentRun(): void {
    abortRef.current?.abort();
  }

  const sessionItems = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const gatewaySessionItems = [...gatewaySessions].sort(
    (a, b) => (b.last_active ?? b.started_at ?? 0) - (a.last_active ?? a.started_at ?? 0),
  );
  const filteredSessions = useMemo(() => {
    if (!sessionSearch.trim()) return sessionItems;
    const q = sessionSearch.trim().toLowerCase();
    return sessionItems.filter((s) =>
      s.title.toLowerCase().includes(q) ||
      (s.preview ?? '').toLowerCase().includes(q) ||
      s.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  }, [sessionItems, sessionSearch]);
  const filteredGatewaySessions = useMemo(() => {
    if (!sessionSearch.trim()) return gatewaySessionItems;
    const q = sessionSearch.trim().toLowerCase();
    return gatewaySessionItems.filter((session) =>
      (session.title ?? '').toLowerCase().includes(q) ||
      (session.preview ?? '').toLowerCase().includes(q) ||
      formatSourceLabel(session.source).toLowerCase().includes(q),
    );
  }, [gatewaySessionItems, sessionSearch]);
  const lastUsage = requestState.usage;
  const totalUsage = currentSession?.totalUsage;
  const isGatewayView = sessionView === 'gateway';
  const visibleMessages = activeMessages;
  const selectedRemoteMeta = currentGatewaySession;
  const selectedRemoteState = currentGatewayMessageState;
  const sessionListCount = isGatewayView ? filteredGatewaySessions.length : filteredSessions.length;

  return (
    <Layout
      title="Hermes 网页控制台"
      description="用于直连 Hermes API Server 的浏览器控制台。"
    >
      <div className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className={styles.heroEyebrow}>浏览器控制台</span>
            <h1 className={styles.heroTitle}>Hermes 网页控制台</h1>
            <p className={styles.heroText}>
              一个面向操作者的 Hermes 控制台。除了浏览器里的 Web 会话，这里也能镜像查看
              Hermes SessionDB 中的服务端会话，例如微信、Telegram、Slack，并直接查看 agent /
              gateway / errors 日志，不需要离开文档站。
            </p>
          </div>
          <div className={styles.heroStats}>
            <div className={styles.heroStat}>
              <span className={styles.heroStatValue}>{backendMeta?.provider ?? extractHost(settings.endpoint)}</span>
              <span className={styles.heroStatLabel}>提供商</span>
            </div>
            <div className={styles.heroStat}>
              <span className={styles.heroStatValue}>{backendMeta?.model ?? settings.model ?? DEFAULT_MODEL}</span>
              <span className={styles.heroStatLabel}>模型</span>
            </div>
            <div className={styles.heroStat}>
              <span className={styles.heroStatValue}>
                {sessionItems.length}
                <span className={styles.heroStatSep}>/</span>
                {gatewaySessionItems.length}
              </span>
              <span className={styles.heroStatLabel}>Web / Gateway 会话</span>
            </div>
            <div className={styles.heroStat}>
              <span className={styles.heroStatValue}>
                {isGatewayView
                  ? formatSourceLabel(selectedRemoteMeta?.source)
                  : (totalUsage?.total_tokens != null
                    ? totalUsage.total_tokens.toLocaleString()
                    : 'Web Session')}
              </span>
              <span className={styles.heroStatLabel}>{isGatewayView ? '当前来源' : '累计 Token'}</span>
            </div>
          </div>
        </section>

        <section className={styles.shell}>
          <aside className={clsx(styles.panel, styles.sidebar)}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.panelEyebrow}>会话</p>
                <h2 className={styles.panelTitle}>{isGatewayView ? '服务端会话镜像' : '持久化 Web 会话'}</h2>
              </div>
              {isGatewayView ? (
                <button className={styles.ghostButton} type="button" onClick={() => void fetchGatewaySessions()}>
                  刷新列表
                </button>
              ) : (
                <button className={styles.primaryButton} type="button" onClick={() => { void createNewSession(); }}>
                  新建会话
                </button>
              )}
            </div>

            <div className={styles.viewToggle}>
              <button
                type="button"
                className={clsx(styles.viewToggleButton, !isGatewayView && styles.viewToggleButtonActive)}
                onClick={() => setSessionView('web')}
              >
                Web 会话
              </button>
              <button
                type="button"
                className={clsx(styles.viewToggleButton, isGatewayView && styles.viewToggleButtonActive)}
                onClick={() => setSessionView('gateway')}
              >
                Gateway 会话
              </button>
            </div>

            <div className={styles.sessionSearchWrap}>
              <input
                type="text"
                className={styles.sessionSearchInput}
                placeholder={isGatewayView ? '搜索来源、标题或预览...' : '搜索会话...'}
                value={sessionSearch}
                onChange={(e) => setSessionSearch(e.target.value)}
              />
              {sessionSearch && (
                <button
                  type="button"
                  className={styles.sessionSearchClear}
                  onClick={() => setSessionSearch('')}
                >×</button>
              )}
            </div>

            <div className={styles.sessionList}>
              {sessionListCount === 0 ? (
                <div className={styles.traceEmpty} style={{textAlign: 'center', fontSize: '0.85rem'}}>
                  {sessionSearch
                    ? '未找到匹配的会话'
                    : (isGatewayView
                      ? (gatewaySessionsState === 'loading' ? '正在加载服务端会话...' : '暂时没有可镜像的服务端会话')
                      : (webSessionsState === 'loading' ? '正在加载 Web 会话...' : '当前没有持久化 Web 会话'))}
                </div>
              ) : null}
              {!isGatewayView && filteredSessions.map((session) => (
                <div
                  key={session.id}
                  className={clsx(styles.sessionItem, session.id === currentSession?.id && styles.sessionItemActive)}
                >
                  <button
                    type="button"
                    className={styles.sessionContent}
                    onClick={() => {
                      setCurrentSessionId(session.id);
                      setRequestState({status: 'idle'});
                      setSessionView('web');
                    }}
                  >
                    <span className={styles.sessionTitle}>{session.title}</span>
                    <span className={styles.sessionMeta}>
                      {(session.messageCount ?? session.messages.length)} 条消息 · {formatRelativeTime(session.updatedAt)}
                    </span>
                    {session.preview ? <span className={styles.sessionPreview}>{session.preview}</span> : null}
                  </button>
                  <button
                    type="button"
                    className={styles.sessionDeleteBtn}
                    title="删除会话"
                    onClick={() => { void deleteSession(session.id); }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {isGatewayView && filteredGatewaySessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={clsx(styles.sessionItem, styles.remoteSessionItem, session.id === currentGatewaySession?.id && styles.sessionItemActive)}
                  onClick={() => {
                    setCurrentGatewaySessionId(session.id);
                    void fetchGatewayMessages(session.id);
                  }}
                >
                  <span className={styles.sessionContent}>
                    <span className={styles.sessionRow}>
                      <span className={styles.sessionTitle}>{session.title || session.id}</span>
                      <span className={styles.sessionSourceTag}>{formatSourceLabel(session.source)}</span>
                    </span>
                    <span className={styles.sessionMeta}>
                      {formatMessageCount(session.message_count)} · {formatRelativeTime(normalizeMessageTimestamp(session.last_active ?? session.started_at))}
                    </span>
                    {session.preview ? <span className={styles.sessionPreview}>{session.preview}</span> : null}
                  </span>
                </button>
              ))}
            </div>

            {!isGatewayView ? (
              <>
                <div className={styles.panelBlock}>
                  <p className={styles.blockLabel}>快捷提示</p>
                  <div className={styles.promptGrid}>
                    {QUICK_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className={styles.promptChip}
                        onClick={() => setComposer(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.panelBlock}>
                  <p className={styles.blockLabel}>启动检查</p>
                  <ul className={styles.checkList}>
                    <li>在 <code>~/.hermes/.env</code> 里设置 <code>API_SERVER_ENABLED=true</code>。</li>
                    <li>如果浏览器直接请求 Hermes，需要给当前来源开放 CORS。</li>
                    <li>启动 <code>hermes gateway</code>，然后检测 <code>/v1/models</code>。</li>
                  </ul>
                  {webSessionsError ? <p className={styles.errorNote}>{webSessionsError}</p> : null}
                </div>
              </>
            ) : (
              <div className={styles.panelBlock}>
                <p className={styles.blockLabel}>镜像说明</p>
                <p className={styles.noteText}>
                  这里读取的是 Hermes `SessionDB` 中的服务端会话。适合查看刚接入的微信等平台消息，
                  当前为只读镜像，不会替代原平台的收发链路。
                </p>
                {gatewaySessionsError ? <p className={styles.errorNote}>{gatewaySessionsError}</p> : null}
              </div>
            )}
          </aside>

          <main className={clsx(styles.panel, styles.chatPanel)}>
            <div className={styles.chatHeader}>
              <div>
                <p className={styles.panelEyebrow}>{isGatewayView ? '平台会话' : '对话'}</p>
                <h2 className={styles.panelTitle}>
                  {isGatewayView
                    ? (selectedRemoteMeta?.title || selectedRemoteMeta?.id || '未选择会话')
                    : (currentSession?.title ?? '新会话')}
                </h2>
              </div>
              <div className={styles.chatHeaderActions}>
                {isGatewayView ? (
                  <>
                    <button
                      className={styles.ghostButton}
                      type="button"
                      onClick={() => {
                        if (currentGatewaySessionId) {
                          void fetchGatewayMessages(currentGatewaySessionId);
                        }
                      }}
                      disabled={!currentGatewaySessionId}
                    >
                      刷新会话
                    </button>
                    <button className={styles.ghostButton} type="button" onClick={() => setSessionView('web')}>
                      切回 Web
                    </button>
                  </>
                ) : (
                  <>
                    <button className={styles.ghostButton} type="button" onClick={() => { void clearCurrentSession(); }}>
                      清空会话
                    </button>
                    {requestState.status === 'connecting' || requestState.status === 'streaming' ? (
                      <button className={styles.dangerButton} type="button" onClick={stopCurrentRun}>
                        停止运行
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>

            <div className={styles.messages} ref={messagesRef} onScroll={handleMessagesScroll}>
              {!visibleMessages.length ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyEyebrow}>{isGatewayView ? '等待服务端会话' : '等待第一轮输入'}</span>
                  {isGatewayView ? (
                    <>
                      <h3>这里会镜像显示 Hermes 服务端会话。</h3>
                      <p>
                        打开左侧的 Gateway 会话后，消息会从 API server 的 `/api/sessions/*` 接口读取。
                        如果刚接入了微信等平台，会在进入 SessionDB 后出现在这里。
                      </p>
                      {selectedRemoteState?.status === 'loading' ? (
                        <p className={styles.noteText}>正在加载会话消息...</p>
                      ) : null}
                      {selectedRemoteState?.error ? (
                        <p className={styles.errorNote}>{selectedRemoteState.error}</p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <h3>直接在浏览器里和 Hermes 对话。</h3>
                      <p>
                        这个页面会把 OpenAI 兼容请求直接发到 Hermes API Server。
                        Web 会话现在会持久化到 Hermes 的 SessionDB，不再依赖当前浏览器的 localStorage。
                      </p>
                      <pre className={styles.commandBlock}>
                        <code>{`API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev
API_SERVER_CORS_ORIGINS=http://localhost:3000
hermes gateway`}</code>
                      </pre>
                    </>
                  )}
                </div>
              ) : (
                visibleMessages.map((message) => (
                  <article
                    key={message.id}
                    className={clsx(
                      styles.messageCard,
                      message.role === 'user' && styles.messageUser,
                      message.role === 'assistant' && styles.messageAssistant,
                      message.role === 'system' && styles.messageSystem,
                      message.role === 'tool' && styles.messageTool,
                      message.role === 'error' && styles.messageError,
                    )}
                  >
                    <div className={styles.messageHeader}>
                      <div className={styles.messageHeaderMeta}>
                        <span className={styles.messageRole}>{formatRole(message.role)}</span>
                        {message.toolName ? <span className={styles.messageMetaChip}>{message.toolName}</span> : null}
                      </div>
                      <span className={styles.messageTime}>{new Date(message.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <div className={styles.messageBody}>
                      {message.content
                        ? renderMessageContent(message.content)
                        : (message.pending ? '正在等待回复...' : '')}
                    </div>
                    {message.pending ? <div className={styles.pendingBar} /> : null}
                  </article>
                ))
              )}
              <div ref={bottomRef} aria-hidden="true" />
            </div>

            <div className={styles.composerWrap}>
              {isGatewayView ? (
                <div className={styles.readOnlyState}>
                  <p className={styles.composerLabel}>只读镜像</p>
                  <p className={styles.noteText}>
                    当前正在查看 Hermes 服务端会话。这里不会直接回写到微信等平台，适合排查消息流、
                    对比 SessionDB 和结合右侧日志做诊断。
                  </p>
                </div>
              ) : (
                <>
                  <label className={styles.composerLabel} htmlFor="hermes-console-composer">
                    输入消息
                  </label>

                  {imageAttachment && (
                    <div className={styles.imagePreview}>
                      <img src={imageAttachment.dataUrl} alt={imageAttachment.name} className={styles.imagePreviewThumb} />
                      <span className={styles.imagePreviewName}>{imageAttachment.name}</span>
                      <span className={styles.imagePreviewSize}>
                        {imageAttachment.size < 1024 * 1024
                          ? `${(imageAttachment.size / 1024).toFixed(0)} KB`
                          : `${(imageAttachment.size / 1024 / 1024).toFixed(1)} MB`}
                      </span>
                      <button type="button" className={styles.imageRemoveBtn} onClick={() => setImageAttachment(null)}>×</button>
                    </div>
                  )}

                  {showSlashMenu && filteredSlashCommands.length > 0 && (
                    <div className={styles.slashMenu}>
                      {filteredSlashCommands.map((cmd, idx) => (
                        <button
                          key={cmd.name}
                          type="button"
                          className={clsx(styles.slashItem, idx === slashSelectedIdx && styles.slashItemActive)}
                          onMouseEnter={() => setSlashSelectedIdx(idx)}
                          onClick={() => executeSlashCommand(cmd.name)}
                        >
                          <span className={styles.slashName}>{cmd.name}</span>
                          <span className={styles.slashDesc}>{cmd.description}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <textarea
                    id="hermes-console-composer"
                    className={styles.composer}
                    rows={1}
                    value={composer}
                    placeholder="输入消息，或键入 / 使用命令..."
                    onChange={(event) => {
                      const val = event.target.value;
                      setComposer(val);
                      if (val.startsWith('/')) {
                        setShowSlashMenu(true);
                        setSlashFilter(val);
                        setSlashSelectedIdx(0);
                      } else {
                        setShowSlashMenu(false);
                      }
                      const el = event.target;
                      el.style.height = 'auto';
                      el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
                    }}
                    onKeyDown={handleComposerKeyDown}
                    onPaste={handleComposerPaste}
                  />

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{display: 'none'}}
                    onChange={handleImageUpload}
                  />

                  <div className={styles.composerActions}>
                    <p className={styles.composerHint}>
                      Enter 发送 · Shift+Enter 换行 · 键入 / 查看命令 · 可粘贴或上传图片
                    </p>
                    <div className={styles.composerButtons}>
                      <button
                        className={styles.ghostButton}
                        type="button"
                        title="上传图片"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        📎
                      </button>
                      <button
                        className={styles.primaryButton}
                        type="button"
                        onClick={() => {
                          if (composer.startsWith('/')) {
                            executeSlashCommand(composer.trim());
                          } else {
                            void sendMessage(composer);
                          }
                        }}
                        disabled={!composer.trim() || requestState.status === 'connecting' || requestState.status === 'streaming'}
                      >
                        发送
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </main>

          <aside className={clsx(styles.panel, styles.inspector)}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.panelEyebrow}>运行时</p>
                <h2 className={styles.panelTitle}>连接、追踪与日志</h2>
              </div>
              <span
                className={clsx(
                  styles.statusBadge,
                  connectionState.state === 'ready' && styles.statusReady,
                  connectionState.state === 'probing' && styles.statusWorking,
                  connectionState.state === 'error' && styles.statusError,
                )}
              >
                {connectionState.message}
              </span>
            </div>

            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>API 地址</span>
                <input
                  className={styles.fieldInput}
                  type="text"
                  value={settings.endpoint}
                  onChange={(event) => setSettings((prev) => ({...prev, endpoint: event.target.value}))}
                  placeholder="http://localhost:8642/v1"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>API Key</span>
                <input
                  className={styles.fieldInput}
                  type="password"
                  value={settings.apiKey}
                  onChange={(event) => setSettings((prev) => ({...prev, apiKey: event.target.value}))}
                  placeholder="change-me-local-dev"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>接口模型</span>
                <div className={styles.modelRow}>
                  <select
                    className={styles.fieldInput}
                    value={settings.model}
                    onChange={(event) => setSettings((prev) => ({...prev, model: event.target.value}))}
                  >
                    {models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                  <button className={styles.ghostButton} type="button" onClick={() => void probeModels()}>
                    刷新
                  </button>
                </div>
                {backendMeta ? (
                  <span className={styles.fieldHint}>
                    实际后端：{backendMeta.provider} / {backendMeta.model}
                  </span>
                ) : null}
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>系统提示词</span>
                <textarea
                  className={styles.fieldTextarea}
                  rows={5}
                  value={settings.systemPrompt}
                  onChange={(event) => setSettings((prev) => ({...prev, systemPrompt: event.target.value}))}
                  placeholder="可选。给这个浏览器客户端额外叠加的指令。"
                />
              </label>
              <label className={styles.toggleRow}>
                <input
                  type="checkbox"
                  checked={settings.stream}
                  onChange={(event) => setSettings((prev) => ({...prev, stream: event.target.checked}))}
                />
                <span>启用流式返回</span>
              </label>
            </div>

            <div className={styles.panelBlock}>
              <p className={styles.blockLabel}>运行摘要</p>
              <div className={styles.metricGrid}>
                {isGatewayView ? (
                  <>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>来源</span>
                      <span className={styles.metricValue}>{formatSourceLabel(selectedRemoteMeta?.source)}</span>
                    </div>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>状态</span>
                      <span className={styles.metricValue}>
                        {selectedRemoteState?.status === 'loading'
                          ? '加载中'
                          : selectedRemoteState?.status === 'error'
                            ? '读取失败'
                            : (selectedRemoteMeta?.is_active ? '活跃' : '已归档')}
                      </span>
                    </div>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>消息数</span>
                      <span className={styles.metricValue}>{formatMessageCount(selectedRemoteMeta?.message_count)}</span>
                    </div>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>最后活跃</span>
                      <span className={styles.metricValue}>
                        {selectedRemoteMeta?.last_active
                          ? formatRelativeTime(normalizeMessageTimestamp(selectedRemoteMeta.last_active))
                          : '--'}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>状态</span>
                      <span className={styles.metricValue}>{formatRunStatus(requestState.status)}</span>
                    </div>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>耗时</span>
                      <span className={styles.metricValue}>{formatDuration(requestState)}</span>
                    </div>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>输入 Token</span>
                      <span className={styles.metricValue}>{lastUsage?.prompt_tokens?.toLocaleString() ?? '--'}</span>
                    </div>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>输出 Token</span>
                      <span className={styles.metricValue}>{lastUsage?.completion_tokens?.toLocaleString() ?? '--'}</span>
                    </div>
                  </>
                )}
              </div>

              {isGatewayView
                ? (selectedRemoteState?.error ? <p className={styles.errorNote}>{selectedRemoteState.error}</p> : null)
                : (requestState.error ? <p className={styles.errorNote}>{requestState.error}</p> : null)}
            </div>

            <div className={styles.panelBlock}>
              <p className={styles.blockLabel}>工具追踪</p>
              <div className={styles.traceList}>
                {isGatewayView ? (
                  <div className={styles.traceEmpty}>
                    实时工具追踪只对当前浏览器发起的 Web 会话生效。服务端平台会话的工具输出可在消息流和下方日志里排查。
                  </div>
                ) : !toolEvents.length ? (
                  <div className={styles.traceEmpty}>
                    Hermes 会把工具启动事件作为自定义 SSE 推送到这里展示，不会污染会话历史。
                  </div>
                ) : (
                  toolEvents.map((event) => (
                    <div
                      key={event.id}
                      className={clsx(
                        styles.traceItem,
                        event.type === 'completed' && !event.error && styles.traceDone,
                        event.error && styles.traceError,
                      )}
                    >
                      <div className={styles.traceHeading}>
                        <span className={styles.traceTool}>
                          {event.emoji ? `${event.emoji} ` : ''}
                          {event.tool}
                          {event.type === 'started' && <span className={styles.traceRunning}> ●</span>}
                          {event.type === 'completed' && !event.error && <span className={styles.traceCheck}> ✓</span>}
                          {event.error && <span className={styles.traceErrorMark}> ✗</span>}
                        </span>
                        <span className={styles.traceTime}>
                          {event.duration != null ? `${event.duration.toFixed(1)}s · ` : ''}
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      {event.label && <p className={styles.traceLabel}>{event.label}</p>}
                      {event.args && (
                        <>
                          <p className={styles.traceMetaLabel}>输入</p>
                          <pre className={styles.traceArgs}>{event.args}</pre>
                        </>
                      )}
                      {event.result && (
                        <>
                          <p className={styles.traceMetaLabel}>输出</p>
                          <pre className={styles.traceArgs}>{event.result}</pre>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className={styles.panelBlock}>
              <div className={styles.blockHeaderRow}>
                <p className={styles.blockLabel}>Hermes 日志</p>
                <button className={styles.ghostButton} type="button" onClick={() => void fetchLogs()}>
                  刷新日志
                </button>
              </div>
              <div className={styles.logControls}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>文件</span>
                  <select
                    className={styles.fieldInput}
                    value={logState.file}
                    onChange={(event) => setLogState((prev) => ({...prev, file: event.target.value}))}
                  >
                    {logState.availableFiles.map((file) => (
                      <option key={file} value={file}>
                        {file}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>级别</span>
                  <select
                    className={styles.fieldInput}
                    value={logState.level}
                    onChange={(event) => setLogState((prev) => ({...prev, level: event.target.value}))}
                  >
                    {LOG_LEVEL_OPTIONS.map((level) => (
                      <option key={level || 'all'} value={level}>
                        {level || '全部'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>组件</span>
                  <select
                    className={styles.fieldInput}
                    value={logState.component}
                    onChange={(event) => setLogState((prev) => ({...prev, component: event.target.value}))}
                  >
                    <option value="">全部</option>
                    {logState.availableComponents.map((component) => (
                      <option key={component} value={component}>
                        {component}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className={styles.logMeta}>
                自动刷新 6 秒
                {logState.refreshedAt ? ` · 最近更新 ${new Date(logState.refreshedAt).toLocaleTimeString()}` : ''}
              </p>
              {logState.error ? <p className={styles.errorNote}>{logState.error}</p> : null}
              <pre className={styles.logViewer}>
                {logState.entries.length ? logState.entries.join('') : '暂无匹配日志。'}
              </pre>
            </div>

            <div className={styles.panelBlock}>
              <p className={styles.blockLabel}>浏览器说明</p>
              <p className={styles.noteText}>
                如果这个页面和 Hermes API Server 不在同一个来源下，请先设置
                <code> API_SERVER_CORS_ORIGINS </code>
                为当前文档站来源，再直接从浏览器发请求。
              </p>
            </div>
          </aside>
        </section>
      </div>
    </Layout>
  );
}
