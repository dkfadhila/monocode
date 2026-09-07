// Hermes Agent models — provider-agnostic, any model via config.
//
// Hermes supports 20+ providers (OpenRouter, Anthropic, OpenAI, DeepSeek,
// Google, xAI, HuggingFace, local models, etc.). The model list here
// represents common defaults; users can add custom models via their
// ~/.hermes/config.yaml.
//
// Native model id format: "provider/model-name" (e.g. "anthropic/claude-sonnet-4")

import type { AgentModel } from "../models";

export const HERMES_MODELS: AgentModel[] = [
  // Anthropic
  {
    id: "hermes:anthropic/claude-sonnet-4",
    harness: "hermes",
    name: "Claude Sonnet 4",
    nativeId: "anthropic/claude-sonnet-4",
  },
  {
    id: "hermes:anthropic/claude-opus-4",
    harness: "hermes",
    name: "Claude Opus 4",
    nativeId: "anthropic/claude-opus-4",
  },
  {
    id: "hermes:anthropic/claude-haiku-3.5",
    harness: "hermes",
    name: "Claude Haiku 3.5",
    nativeId: "anthropic/claude-haiku-3.5",
  },

  // OpenAI via OpenRouter or direct
  {
    id: "hermes:openai/gpt-5",
    harness: "hermes",
    name: "GPT-5",
    nativeId: "openai/gpt-5",
  },
  {
    id: "hermes:openai/gpt-4.1",
    harness: "hermes",
    name: "GPT-4.1",
    nativeId: "openai/gpt-4.1",
  },
  {
    id: "hermes:openai/o3",
    harness: "hermes",
    name: "o3",
    nativeId: "openai/o3",
  },

  // DeepSeek
  {
    id: "hermes:deepseek/deepseek-chat",
    harness: "hermes",
    name: "DeepSeek V3",
    nativeId: "deepseek/deepseek-chat",
  },
  {
    id: "hermes:deepseek/deepseek-reasoner",
    harness: "hermes",
    name: "DeepSeek R1",
    nativeId: "deepseek/deepseek-reasoner",
  },

  // Google
  {
    id: "hermes:google/gemini-2.5-pro",
    harness: "hermes",
    name: "Gemini 2.5 Pro",
    nativeId: "google/gemini-2.5-pro",
  },
  {
    id: "hermes:google/gemini-2.5-flash",
    harness: "hermes",
    name: "Gemini 2.5 Flash",
    nativeId: "google/gemini-2.5-flash",
  },

  // xAI
  {
    id: "hermes:xai/grok-3",
    harness: "hermes",
    name: "Grok 3",
    nativeId: "xai/grok-3",
  },

  // Nous Research
  {
    id: "hermes:nous/hermes-3",
    harness: "hermes",
    name: "Hermes 3",
    nativeId: "nous/hermes-3",
  },

  // Meta via OpenRouter
  {
    id: "hermes:meta-llama/llama-4-maverick",
    harness: "hermes",
    name: "Llama 4 Maverick",
    nativeId: "meta-llama/llama-4-maverick",
  },
];
