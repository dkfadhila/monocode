/**
 * Hermes Agent harness — core adapter.
 *
 * Spawns `hermes acp` and communicates via the ACP JSON-RPC protocol
 * (same protocol as Cursor). Hermes is provider-agnostic: it supports
 * any LLM via its own config (~/.hermes/config.yaml) and credential
 * pools (~/.hermes/auth.json).
 *
 * Key differences from Cursor:
 *   - No proprietary login flow; Hermes uses its own credential system.
 *   - Model selection is config-driven, not catalog-driven.
 *   - Tool calls come through the same ACP notification stream.
 */

import { nativeModelId } from "../models";
import type { RuntimeMode } from "../session";
import { promptBlocks } from "../attachments";
import { AcpClient, type AcpHandlers } from "./acp";
import {
  killChild,
  resolveHermesBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import type {
  ApprovalDecision,
  HarnessEvent,
  SendTurnInput,
  SteerTurnInput,
} from "./types";
import {
  questionsFromUnknown,
  type UserQuestionReply,
} from "../userQuestion";
import {
  buildHermesPromptPayload,
  extractModelConfigId,
  readConfigOptions,
  resolveHermesModelId,
  resolveSettingConfigId,
  type SessionConfigOption,
} from "./hermesProtocol";
import {
  agentToolTitle,
  composeToolTitle,
  extractSearchQuery,
  extractShellCommand,
  extractSkillName,
  extractToolPreview,
  isAgentToolName,
  mergeToolPreview,
} from "./preview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionSetupResult = {
  sessionId?: string;
  configOptions?: unknown;
};

type Live = {
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  modelConfigId: string;
  configOptions: SessionConfigOption[];
  muteUpdates: boolean;
  cancelled: boolean;
  runtimeMode: RuntimeMode;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, (decision: ApprovalDecision) => void>;
  questions: Map<number, (reply: UserQuestionReply) => void>;
  toolStatuses: Map<string, string>;
  agentTools: Map<string, string>;
  promptActive: boolean;
  turns: Promise<void>;
};

type Resume = {
  acpSessionId: string;
  cwd: string;
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  _meta: { parameterizedModelPicker: true },
};

// ---------------------------------------------------------------------------
// Public API — Turn lifecycle
// ---------------------------------------------------------------------------

export async function sendHermesTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyModelSelection(live, input);
        if (live.cancelled) return;
        await prompt(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export async function steerHermesTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live) throw new Error("No active Hermes session");

  const blocks = promptBlocks(input.text, input.attachments);
  if (blocks.length === 0) return;

  const params = {
    sessionId: live.acpSessionId,
    prompt: blocks,
  };
  try {
    await live.acp.notify("session/steer", params);
  } catch {
    // Hermes may not support steer; fall back to no-op
  }
}

export function respondHermesApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
) {
  liveByThread.get(sessionId)?.approvals.get(requestId)?.(decision);
}

export function respondHermesQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
) {
  liveByThread.get(sessionId)?.questions.get(requestId)?.(reply);
}

export async function cancelHermesTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  live.promptActive = false;
  for (const [, resolve] of live.approvals) resolve("deny");
  live.approvals.clear();
  for (const [, resolve] of live.questions) resolve({ kind: "skipped" });
  live.questions.clear();
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
  live.acp.rejectPending(new Error("cancelled"));
}

export async function stopHermesSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    live.promptActive = false;
    live.acp.close();
    await killChild(sessionId);
  }
}

export async function forgetHermesSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  liveByThread.delete(sessionId);
  resumeByThread.delete(sessionId);
  await killChild(sessionId);
}

export function bindHermesSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
): void {
  const sessionId = providerSessionId.trim();
  if (!sessionId) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function ensureLive(input: SendTurnInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    existing.runtimeMode = input.runtimeMode;
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    await stopHermesSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveHermesBinary();
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
  const liveRef: { current: Live | null } = { current: null };
  const muteGate = { current: false };

  handlers.onNotification = (method, params) => {
    if (muteGate.current) return;
    const live = liveRef.current;
    if (!live || live.muteUpdates) return;
    handleNotification(live, method, params);
  };
  handlers.onRequest = (id, method, params) => {
    const live = liveRef.current;
    if (!live) return;
    void handleRequest(live, id, method, params);
  };

  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    (code) => {
      acp.close(new Error("Hermes CLI exited"));
      liveByThread.delete(input.sessionId);
      input.onEvent({ type: "session.ended", code });
    },
  );

  await spawnChild(input.sessionId, path, ["acp"], input.cwd);

  try {
    await acp.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: "monocode", version: "0.1.0" },
    });

    let setup: SessionSetupResult | undefined;
    let acpSessionId: string | undefined;
    let didLoad = false;

    if (canLoad && resume) {
      muteGate.current = true;
      try {
        setup = await acp.request<SessionSetupResult>("session/load", {
          sessionId: resume.acpSessionId,
          cwd: input.cwd,
          mcpServers: [],
        });
        acpSessionId = resume.acpSessionId;
        didLoad = true;
      } catch {
        setup = undefined;
        acpSessionId = undefined;
        didLoad = false;
      } finally {
        muteGate.current = false;
      }
    }

    if (!acpSessionId) {
      setup = await acp.request<SessionSetupResult>("session/new", {
        cwd: input.cwd,
        mcpServers: [],
      });
      acpSessionId = setup.sessionId?.trim();
    }
    if (!acpSessionId) throw new Error("Hermes did not return a session id");

    const live: Live = {
      acp,
      acpSessionId,
      cwd: input.cwd,
      modelConfigId: extractModelConfigId(setup),
      configOptions: readConfigOptions(setup?.configOptions),
      muteUpdates: didLoad,
      cancelled: false,
      runtimeMode: input.runtimeMode,
      onEvent: input.onEvent,
      approvals: new Map(),
      questions: new Map(),
      toolStatuses: new Map(),
      agentTools: new Map(),
      promptActive: false,
      turns: Promise.resolve(),
    };
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, {
      acpSessionId,
      cwd: input.cwd,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: acpSessionId,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    acp.close(error instanceof Error ? error : new Error(String(error)));
    await stopHermesSession(input.sessionId);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

async function applyModelSelection(
  live: Live,
  input: SendTurnInput,
): Promise<void> {
  const base = nativeModelId(input.model);
  const settings = input.modelSettings ?? {};

  // Try config option first, fall back to session/set_model
  try {
    await setConfigOption(live, live.modelConfigId, base);
  } catch {
    await live.acp
      .request("session/set_model", {
        sessionId: live.acpSessionId,
        modelId: base,
      })
      .catch(() => undefined);
  }

  for (const [settingId, value] of Object.entries(settings)) {
    const configId = resolveSettingConfigId(live.configOptions, settingId);
    if (!configId) continue;
    await setConfigOption(live, configId, value).catch(() => undefined);
  }
}

async function setConfigOption(
  live: Live,
  configId: string,
  value: string | boolean,
): Promise<void> {
  if (!configId) return;
  const current = live.configOptions.find((o) => o.id === configId);
  if (current && String(current.currentValue ?? "") === String(value)) return;

  await live.acp.request<SessionSetupResult>("session/set_config_option", {
    sessionId: live.acpSessionId,
    configId,
    value,
  });
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  live.promptActive = true;
  const blocks = buildHermesPromptPayload({
    text: input.text,
    attachments: input.attachments,
  });
  if (blocks.length === 0) return;

  try {
    await live.acp.request("session/prompt", {
      sessionId: live.acpSessionId,
      prompt: blocks,
    });
  } finally {
    live.promptActive = false;
  }
}

// ---------------------------------------------------------------------------
// Notification handler
// ---------------------------------------------------------------------------

function handleNotification(
  live: Live,
  method: string,
  params: unknown,
): void {
  const p = params as Record<string, unknown> | undefined;

  switch (method) {
    case "session/text_delta": {
      const delta = typeof p?.delta === "string" ? p.delta : "";
      if (delta) {
        live.onEvent({ type: "message.delta", text: delta });
      }
      break;
    }

    case "session/text_done": {
      live.onEvent({ type: "message.completed" });
      break;
    }

    case "session/reasoning_delta": {
      const delta = typeof p?.delta === "string" ? p.delta : "";
      if (delta) {
        live.onEvent({ type: "reasoning.delta", text: delta });
      }
      break;
    }

    case "session/reasoning_done": {
      live.onEvent({ type: "reasoning.completed" });
      break;
    }

    case "session/tool_started": {
      const callId = String(p?.callId ?? p?.tool_use_id ?? "");
      const title = String(p?.title ?? p?.name ?? "Tool");
      const kind = typeof p?.kind === "string" ? p.kind : undefined;
      const preview = extractToolPreview(p);
      live.onEvent({
        type: "tool.started",
        callId,
        title,
        kind,
        preview,
      });
      break;
    }

    case "session/tool_updated": {
      const callId = String(p?.callId ?? p?.tool_use_id ?? "");
      const title = typeof p?.title === "string" ? p.title : undefined;
      const kind = typeof p?.kind === "string" ? p.kind : undefined;
      const status = typeof p?.status === "string" ? p.status : undefined;
      const detail = typeof p?.detail === "string" ? p.detail : undefined;
      const preview = extractToolPreview(p);
      live.onEvent({
        type: "tool.updated",
        callId,
        title,
        kind,
        status,
        detail,
        preview,
      });
      break;
    }

    case "session/approval_requested": {
      const requestId = Number(p?.requestId ?? 0);
      const title = String(p?.title ?? "Approval needed");
      const kind = typeof p?.kind === "string" ? p.kind : undefined;
      const callId =
        typeof p?.callId === "string" ? p.callId : undefined;
      const preview = extractToolPreview(p);
      live.onEvent({
        type: "approval.requested",
        requestId,
        title,
        kind,
        callId,
        preview,
      });
      break;
    }

    case "session/approval_resolved": {
      const requestId = Number(p?.requestId ?? 0);
      const decision =
        p?.decision === "allow" ? "allow" : "cancelled";
      live.onEvent({
        type: "approval.resolved",
        requestId,
        decision,
      });
      break;
    }

    case "session/question_asked": {
      const requestId = Number(p?.requestId ?? 0);
      const title =
        typeof p?.title === "string" ? p.title : undefined;
      const questions = questionsFromUnknown(p?.questions);
      const callId =
        typeof p?.callId === "string" ? p.callId : undefined;
      live.onEvent({
        type: "question.asked",
        requestId,
        title,
        questions,
        callId,
      });
      break;
    }

    case "session/question_resolved": {
      const requestId = Number(p?.requestId ?? 0);
      const decision =
        p?.decision === "answered" ? "answered" : "skipped";
      live.onEvent({
        type: "question.resolved",
        requestId,
        decision,
      });
      break;
    }

    case "session/tasks_updated": {
      const key = typeof p?.key === "string" ? p.key : undefined;
      const explanation =
        typeof p?.explanation === "string" ? p.explanation : undefined;
      const merge = p?.merge === true;
      const items = Array.isArray(p?.items)
        ? (p.items as Array<{ text: string; status: string }>).map(
            (i) => ({
              text: i.text,
              status: i.status as
                | "pending"
                | "in_progress"
                | "completed"
                | "cancelled",
            }),
          )
        : [];
      live.onEvent({
        type: "tasks.updated",
        key,
        explanation,
        merge,
        items,
      });
      break;
    }

    case "session/status": {
      const text = typeof p?.text === "string" ? p.text : "";
      if (text) {
        live.onEvent({ type: "status", text });
      }
      break;
    }

    case "session/context": {
      const used =
        typeof p?.used === "number" ? p.used : undefined;
      const window_ =
        typeof p?.window === "number" ? p.window : undefined;
      live.onEvent({ type: "context", used, window: window_ });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Request handler (approval / question prompts from agent)
// ---------------------------------------------------------------------------

async function handleRequest(
  live: Live,
  id: number,
  method: string,
  params: unknown,
): Promise<void> {
  const p = params as Record<string, unknown> | undefined;

  if (method === "approval/request") {
    const uiId = live.approvals.size + 1;
    const title = String(p?.title ?? "Approval needed");
    const kind = typeof p?.kind === "string" ? p.kind : undefined;
    const callId =
      typeof p?.callId === "string" ? p.callId : undefined;
    const preview = extractToolPreview(p);
    live.onEvent({
      type: "approval.requested",
      requestId: uiId,
      title,
      kind,
      callId,
      preview,
    });
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      live.approvals.set(uiId, resolve);
    });
    await live.acp.respond(id, {
      decision,
    });
    live.approvals.delete(uiId);
    live.onEvent({
      type: "approval.resolved",
      requestId: uiId,
      decision,
    });
  } else if (method === "question/ask") {
    const uiId = live.questions.size + 1;
    const title =
      typeof p?.title === "string" ? p.title : undefined;
    const questions = questionsFromUnknown(p?.questions);
    live.onEvent({
      type: "question.asked",
      requestId: uiId,
      title,
      questions,
    });
    const reply = await new Promise<UserQuestionReply>((resolve) => {
      live.questions.set(uiId, resolve);
    });
    await live.acp.respond(id, {
      reply,
    });
    live.questions.delete(uiId);
    live.onEvent({
      type: "question.resolved",
      requestId: uiId,
      decision: reply.kind === "answer" ? "answered" : "skipped",
    });
  }
}

// ---------------------------------------------------------------------------
// Tool preview extraction
// ---------------------------------------------------------------------------

function extractToolPreview(
  params: Record<string, unknown> | undefined,
): import("./types").ToolPreview | undefined {
  if (!params) return undefined;
  const raw = params.preview as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  return {
    kind: typeof raw.kind === "string" ? (raw.kind as any) : undefined,
    path: typeof raw.path === "string" ? raw.path : undefined,
    fileName:
      typeof raw.fileName === "string" ? raw.fileName : undefined,
    query: typeof raw.query === "string" ? raw.query : undefined,
  };
}
