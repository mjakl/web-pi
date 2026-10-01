import type { Workspace } from "@core/workspace";
import type { CoordinatorMode } from "@core/workspace/coordinator";

export type CoordinatorSession = Awaited<
  ReturnType<Workspace["coordinatorSessions"]>
>[number] & { handle: string; label: string };
export type CoordinatorContext = Awaited<
  ReturnType<Workspace["coordinatorContext"]>
>;
export type CoordinatorExchange = {
  role: "user" | "assistant";
  text: string;
  event?:
    | "focus"
    | "request"
    | "reply"
    | "submission"
    | "result"
    | "update"
    | "speech";
  sessionIds?: string[];
  proposal?: CoordinatorProposal;
};
export type CoordinatorMemory = {
  sessions: CoordinatorSession[];
  target: CoordinatorSession | null;
  context: CoordinatorContext | null;
  conversation: CoordinatorExchange[];
  question: string | null;
  pending: CoordinatorPending | null;
};
export type CoordinatorPending = {
  id: string;
  text: string;
  question: string | null;
  ownership: CoordinatorProposal | null;
  mode?: CoordinatorMode;
};
export type CoordinatorInput = CoordinatorMemory & {
  purpose: "request" | "updates";
  text: string;
  explicitTargetId: string | null;
};
export type CoordinatorReply = {
  kind:
    | "reply"
    | "clarify"
    | "prompt"
    | "handoff"
    | "stopWork"
    | "stopSpeaking"
    | "resumeSpeaking"
    | "endVoice";
  resolves?: string | null;
  text: string;
  speech: string;
  instruction: string;
  targetId: string | null;
  question: string | null;
};
export type VoiceEvent =
  | { type: "input" | "output"; id: string; text: string }
  | { type: "delegate"; id: string }
  | { type: "closed"; confirmed: boolean }
  | { type: "error"; message: string };
export type CoordinatorVoice = {
  answer: string;
  context(text: string, speak: boolean, delegationId?: string): void;
  mute(muted: boolean): void;
  close(): Promise<boolean>;
};
export type CoordinatorProvider = {
  ready: () => boolean;
  respond: (
    input: CoordinatorInput,
    signal: AbortSignal,
  ) => Promise<CoordinatorReply>;
  connect: (
    offer: string,
    onEvent: (event: VoiceEvent) => void,
    signal: AbortSignal,
    memory: CoordinatorMemory,
  ) => Promise<CoordinatorVoice>;
};
/** The rewritten instruction retained in the admission audit or handoff. */
export type CoordinatorProposal = {
  id: string;
  target: string;
  label: string;
  text: string;
  mode: CoordinatorMode;
  revision: string;
};
export type CoordinatorState = {
  enabled: boolean;
  busy: boolean;
  sessions: CoordinatorSession[];
  target: string;
  context: CoordinatorContext | null;
  question: string | null;
  conversation: CoordinatorExchange[];
  inputCaption: string;
  outputCaption: string;
  voice: "off" | "connecting" | "connected";
  voiceGeneration: number;
  muted: boolean;
  playback: { sequence: number; stopped: boolean };
  pending: CoordinatorPending | null;
  error: string;
};
