import React, {useEffect, useMemo, useRef, useState} from 'react';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import styles from './styles.module.css';

type MessageRole = 'user' | 'assistant' | 'error';
type RunStatus = 'idle' | 'connecting' | 'streaming' | 'complete' | 'error' | 'cancelled';

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  pending?: boolean;
}

interface ConsoleSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
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
  };
}

function normalizeEndpoint(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
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
    case 'error':
      return '错误';
    default:
      return role;
  }
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
  const [settings, setSettings] = useState<ConsoleSettings>(DEFAULT_SETTINGS);
  const [composer, setComposer] = useState('');
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [requestState, setRequestState] = useState<RequestState>({status: 'idle'});
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    state: 'idle',
    message: '等待连接检测',
  });
  const [models, setModels] = useState<string[]>([DEFAULT_MODEL]);
  const [backendMeta, setBackendMeta] = useState<{provider: string; model: string} | null>(null);

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
        const session = createSession();
        setSessions([session]);
        setCurrentSessionId(session.id);
        return;
      }

      const parsed = JSON.parse(raw) as {
        settings?: ConsoleSettings;
        sessions?: ConsoleSession[];
        currentSessionId?: string;
      };

      const restoredSessions = (parsed.sessions?.length ? parsed.sessions : [createSession()]).map((session) => ({
        ...session,
        title: session.title === 'New thread' ? '新会话' : session.title,
      }));
      const restoredSettings = parsed.settings ? {...DEFAULT_SETTINGS, ...parsed.settings} : DEFAULT_SETTINGS;

      setSessions(restoredSessions);
      setSettings(restoredSettings);
      setCurrentSessionId(parsed.currentSessionId && restoredSessions.some((item) => item.id === parsed.currentSessionId)
        ? parsed.currentSessionId
        : restoredSessions[0].id);
    } catch {
      const session = createSession();
      setSessions([session]);
      setCurrentSessionId(session.id);
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
      }),
    );
  }, [currentSessionId, hydrated, sessions, settings]);

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? sessions[0],
    [currentSessionId, sessions],
  );

  useEffect(() => {
    if (!currentSession && sessions.length) {
      setCurrentSessionId(sessions[0].id);
    }
  }, [currentSession, sessions]);

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
  }, [currentSession?.messages, requestState.status, toolEvents]);

  // Always scroll to bottom when user sends a new message
  useEffect(() => {
    if (requestState.status === 'connecting') {
      userScrolledUpRef.current = false;
      scrollMessagesToBottom(true);
    }
  }, [requestState.status]);

  const transcriptCount = currentSession?.messages.filter((message) => message.role !== 'error').length ?? 0;
  const endpoint = normalizeEndpoint(settings.endpoint);

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

  function appendToolEvent(event: {type?: string; tool: string; label?: string; emoji?: string; duration?: number; error?: boolean; args?: string}): void {
    if (event.type === 'completed') {
      setToolEvents((prev) => {
        const idx = prev.findIndex((e) => e.tool === event.tool && e.type === 'started');
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            type: 'completed',
            duration: event.duration,
            error: event.error,
          };
          return updated;
        }
        return [
          {id: makeId('tool'), type: 'completed', tool: event.tool, label: event.label ?? event.tool, emoji: event.emoji, timestamp: Date.now(), duration: event.duration, error: event.error},
          ...prev,
        ];
      });
      return;
    }
    setToolEvents((prev) => [
      {
        id: makeId('tool'),
        type: 'started',
        tool: event.tool,
        label: event.label ?? event.tool,
        emoji: event.emoji,
        timestamp: Date.now(),
        args: event.args,
      },
      ...prev,
    ]);
  }

  async function probeModels(): Promise<void> {
    if (!endpoint || !settings.apiKey.trim()) {
      setConnectionState({
        state: 'error',
        message: '请先填写接口地址和 API Key。',
      });
      return;
    }

    setConnectionState({
      state: 'probing',
      message: '正在检查 /v1/models ...',
    });

    try {
      const response = await fetch(`${endpoint}/models`, {
        headers: {
          Authorization: `Bearer ${settings.apiKey.trim()}`,
        },
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
  }, [hydrated]);

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
          const payload = JSON.parse(data) as {type?: string; tool: string; label?: string; emoji?: string; duration?: number; error?: boolean; args?: string};
          appendToolEvent(payload);
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
    if (!currentSession || !text.trim() || requestState.status === 'connecting' || requestState.status === 'streaming') {
      return;
    }

    if (!endpoint || !settings.apiKey.trim()) {
      setConnectionState({
        state: 'error',
        message: '发送前请先填写接口地址和 API Key。',
      });
      return;
    }

    const sessionId = currentSession.id;
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
      [...currentSession.messages, userMessage],
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
    }));

    setComposer('');
    setImageAttachment(null);
    setToolEvents([]);
    setRequestState({
      status: 'connecting',
      startedAt: now,
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      };
      if (currentSession.serverSessionId) {
        requestHeaders['X-Hermes-Session-Id'] = currentSession.serverSessionId;
      }

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
      clearCurrentSession();

    } else if (cmd === '/new') {
      createNewSession();

    } else if (cmd === '/retry') {
      if (!currentSession) return;
      const lastUserMsg = [...currentSession.messages].reverse().find((m) => m.role === 'user');
      if (!lastUserMsg) {
        insertInfoMessage('⚠️ 没有可重发的用户消息。');
      } else {
        // Remove the last user+assistant pair and resend
        const msgs = currentSession.messages;
        const lastUserIdx = msgs.lastIndexOf(lastUserMsg);
        patchCurrentSession((s) => ({
          ...s,
          updatedAt: Date.now(),
          messages: s.messages.slice(0, lastUserIdx),
        }));
        setComposer('');
        setShowSlashMenu(false);
        setTimeout(() => void sendMessage(lastUserMsg.content), 50);
        return;
      }

    } else if (cmd === '/undo') {
      if (!currentSession || currentSession.messages.length === 0) {
        insertInfoMessage('⚠️ 没有可撤销的对话。');
      } else {
        // Remove last user+assistant pair
        const msgs = [...currentSession.messages];
        let removed = 0;
        while (msgs.length > 0 && removed < 2) {
          const last = msgs[msgs.length - 1];
          if (last.role === 'user' || last.role === 'assistant') removed++;
          msgs.pop();
        }
        patchCurrentSession((s) => ({
          ...s,
          updatedAt: Date.now(),
          messages: msgs,
        }));
        insertInfoMessage('↩️ 已撤销最近一轮对话。');
        return;
      }

    } else if (cmd === '/title') {
      if (!arg) {
        insertInfoMessage(`当前标题: **${currentSession?.title ?? '新会话'}**\n\n用法: \`/title 新标题\``);
      } else {
        patchCurrentSession((s) => ({...s, title: arg, updatedAt: Date.now()}));
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

  function deleteSession(sessionId: string): void {
    if (requestState.status === 'streaming' || requestState.status === 'connecting') {
      if (sessionId === currentSessionId) {
        stopCurrentRun();
      }
    }
    setSessions((prev) => {
      const next = prev.filter((session) => session.id !== sessionId);
      if (!next.length) {
        const fresh = createSession();
        setCurrentSessionId(fresh.id);
        return [fresh];
      }
      if (sessionId === currentSessionId) {
        const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
        setCurrentSessionId(sorted[0].id);
      }
      return next;
    });
    setToolEvents([]);
    setRequestState({status: 'idle'});
  }

  function createNewSession(): void {
    const session = createSession();
    setSessions((prev) => [session, ...prev]);
    setCurrentSessionId(session.id);
    setComposer('');
    setToolEvents([]);
    setRequestState({status: 'idle'});
  }

  function clearCurrentSession(): void {
    if (!currentSession) {
      return;
    }
    if (currentSession.messages.length > 0 && !window.confirm('确认清空当前会话的所有消息？')) {
      return;
    }
    patchCurrentSession((session) => ({
      ...session,
      title: '新会话',
      updatedAt: Date.now(),
      messages: [],
      serverSessionId: undefined,
      totalUsage: undefined,
    }));
    setComposer('');
    setToolEvents([]);
    setRequestState({status: 'idle'});
  }

  function stopCurrentRun(): void {
    abortRef.current?.abort();
  }

  const sessionItems = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const filteredSessions = useMemo(() => {
    if (!sessionSearch.trim()) return sessionItems;
    const q = sessionSearch.trim().toLowerCase();
    return sessionItems.filter((s) =>
      s.title.toLowerCase().includes(q) ||
      s.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  }, [sessionItems, sessionSearch]);
  const lastUsage = requestState.usage;
  const totalUsage = currentSession?.totalUsage;

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
              一个面向操作者的中性色 Hermes 前端。会话保存在当前浏览器里，回复支持实时流式返回，
              工具执行进度也能在右侧直接观察，不需要离开文档站。
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
                {transcriptCount}
              </span>
              <span className={styles.heroStatLabel}>会话 / 消息</span>
            </div>
            <div className={styles.heroStat}>
              <span className={styles.heroStatValue}>
                {totalUsage?.total_tokens != null
                  ? totalUsage.total_tokens.toLocaleString()
                  : '--'}
              </span>
              <span className={styles.heroStatLabel}>累计 Token</span>
            </div>
          </div>
        </section>

        <section className={styles.shell}>
          <aside className={clsx(styles.panel, styles.sidebar)}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.panelEyebrow}>会话</p>
                <h2 className={styles.panelTitle}>本地线程列表</h2>
              </div>
              <button className={styles.primaryButton} type="button" onClick={createNewSession}>
                新建会话
              </button>
            </div>

            <div className={styles.sessionSearchWrap}>
              <input
                type="text"
                className={styles.sessionSearchInput}
                placeholder="搜索会话..."
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
              {filteredSessions.length === 0 && sessionSearch ? (
                <div className={styles.traceEmpty} style={{textAlign: 'center', fontSize: '0.85rem'}}>
                  未找到匹配的会话
                </div>
              ) : null}
              {filteredSessions.map((session) => (
                <div
                  key={session.id}
                  className={clsx(styles.sessionItem, session.id === currentSession?.id && styles.sessionItemActive)}
                >
                  <button
                    type="button"
                    className={styles.sessionContent}
                    onClick={() => {
                      setCurrentSessionId(session.id);
                      setToolEvents([]);
                      setRequestState({status: 'idle'});
                    }}
                  >
                    <span className={styles.sessionTitle}>{session.title}</span>
                    <span className={styles.sessionMeta}>
                      {session.messages.length} 条消息 · {formatRelativeTime(session.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.sessionDeleteBtn}
                    title="删除会话"
                    onClick={() => deleteSession(session.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

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
            </div>
          </aside>

          <main className={clsx(styles.panel, styles.chatPanel)}>
            <div className={styles.chatHeader}>
              <div>
                <p className={styles.panelEyebrow}>对话</p>
                <h2 className={styles.panelTitle}>{currentSession?.title ?? '新会话'}</h2>
              </div>
              <div className={styles.chatHeaderActions}>
                <button className={styles.ghostButton} type="button" onClick={clearCurrentSession}>
                  清空会话
                </button>
                {requestState.status === 'connecting' || requestState.status === 'streaming' ? (
                  <button className={styles.dangerButton} type="button" onClick={stopCurrentRun}>
                    停止运行
                  </button>
                ) : null}
              </div>
            </div>

            <div className={styles.messages} ref={messagesRef} onScroll={handleMessagesScroll}>
              {!currentSession?.messages.length ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyEyebrow}>等待第一轮输入</span>
                  <h3>直接在浏览器里和 Hermes 对话。</h3>
                  <p>
                    这个页面会把 OpenAI 兼容请求直接发到 Hermes API Server。
                    线程历史保存在当前浏览器里，而 Hermes 仍然使用完整工具集运行。
                  </p>
                  <pre className={styles.commandBlock}>
                    <code>{`API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev
API_SERVER_CORS_ORIGINS=http://localhost:3000
hermes gateway`}</code>
                  </pre>
                </div>
              ) : (
                currentSession?.messages.map((message) => (
                  <article
                    key={message.id}
                    className={clsx(
                      styles.messageCard,
                      message.role === 'user' && styles.messageUser,
                      message.role === 'assistant' && styles.messageAssistant,
                      message.role === 'error' && styles.messageError,
                    )}
                  >
                    <div className={styles.messageHeader}>
                      <span className={styles.messageRole}>{formatRole(message.role)}</span>
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
              <label className={styles.composerLabel} htmlFor="hermes-console-composer">
                输入消息
              </label>

              {/* Image preview */}
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

              {/* Slash command menu */}
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
                  // Slash command detection
                  if (val.startsWith('/')) {
                    setShowSlashMenu(true);
                    setSlashFilter(val);
                    setSlashSelectedIdx(0);
                  } else {
                    setShowSlashMenu(false);
                  }
                  // Auto-grow
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
            </div>
          </main>

          <aside className={clsx(styles.panel, styles.inspector)}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.panelEyebrow}>运行时</p>
                <h2 className={styles.panelTitle}>连接与执行追踪</h2>
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
              </div>

              {requestState.error ? <p className={styles.errorNote}>{requestState.error}</p> : null}
            </div>

            <div className={styles.panelBlock}>
              <p className={styles.blockLabel}>工具追踪</p>
              <div className={styles.traceList}>
                {!toolEvents.length ? (
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
                        <pre className={styles.traceArgs}>{event.args}</pre>
                      )}
                    </div>
                  ))
                )}
              </div>
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
