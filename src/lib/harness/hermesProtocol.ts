/**
 * Hermes Agent ACP protocol helpers.
 *
 * Hermes exposes an ACP (Agent Communication Protocol) server via
 * `hermes acp`. It speaks the same JSON-RPC-over-stdin/stdout protocol
 * as Cursor, so we reuse the shared AcpClient and adapt the
 * notification/request semantics to Hermes-specific events.
 */

import type { Attachment } from "../../session";

// ---------------------------------------------------------------------------
// Spawn arguments
// ---------------------------------------------------------------------------

export type HermesSpawnOptions = {
  model?: string;
  provider?: string;
  cwd?: string;
  profile?: string;
  yolo?: boolean;
  maxTurns?: number;
  worktree?: boolean;
  skills?: string[];
  toolsets?: string[];
};

/**
 * Build CLI args for `hermes acp`.
 *
 * Hermes ACP is the entry point — no extra flags needed beyond what the
 * protocol negotiation handles at runtime.
 */
export function buildHermesSpawnArgs(_input: HermesSpawnOptions): string[] {
  // `hermes acp` starts the ACP server on stdin/stdout.
  // Model, provider, and other options are negotiated via ACP requests
  // after initialization (session/new or session/load).
  return ["acp"];
}

// ---------------------------------------------------------------------------
// User message construction
// ---------------------------------------------------------------------------

/**
 * Build an ACP prompt payload from user text and optional attachments.
 */
export function buildHermesPromptPayload(input: {
  text: string;
  attachments?: Attachment[];
}): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const text = input.text.trim();
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const attachment of input.attachments ?? []) {
    if (attachment.kind === "image" && attachment.data) {
      const mime = normalizeImageMime(attachment.mimeType);
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mime,
          data: attachment.data,
        },
      });
    }
  }
  return blocks;
}

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function normalizeImageMime(mime: string): string {
  if (mime === "image/jpg") return "image/jpeg";
  return mime;
}

export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(normalizeImageMime(mime));
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * Resolve a Hermes model string from the MonoCode model id.
 *
 * MonoCode model ids for Hermes follow the pattern `hermes:<model>`.
 * The native id is the full provider/model string (e.g.
 * `anthropic/claude-sonnet-4`).
 */
export function resolveHermesModelId(modelId: string): string | undefined {
  // Strip the `hermes:` prefix if present
  if (modelId.startsWith("hermes:")) {
    return modelId.slice("hermes:".length);
  }
  return modelId;
}

// ---------------------------------------------------------------------------
// Session config options
// ---------------------------------------------------------------------------

export type SessionConfigOption = {
  id: string;
  category?: string;
  currentValue?: string | boolean;
  label?: string;
  options?: Array<{ id: string; label: string }>;
};

/**
 * Extract model config id from a session setup result.
 */
export function extractModelConfigId(
  setup: Record<string, unknown> | undefined,
): string {
  if (!setup) return "";
  const configOptions = setup.configOptions as
    | SessionConfigOption[]
    | undefined;
  if (!configOptions) return "";
  const modelOption = configOptions.find(
    (o) =>
      o.id === "model" ||
      o.id === "modelId" ||
      o.category === "model",
  );
  return modelOption?.id ?? "";
}

/**
 * Read config options from session setup result.
 */
export function readConfigOptions(
  raw: unknown,
): SessionConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is SessionConfigOption =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as Record<string, unknown>).id === "string",
  );
}

/**
 * Resolve a config option id for a known setting key.
 */
export function resolveSettingConfigId(
  options: SessionConfigOption[],
  settingId: string,
): string | undefined {
  // Try exact match first
  const exact = options.find((o) => o.id === settingId);
  if (exact) return exact.id;
  // Try label-based match
  const byLabel = options.find(
    (o) => o.label?.toLowerCase().includes(settingId.toLowerCase()),
  );
  return byLabel?.id;
}
