import type { Workspace } from "@core/workspace";
import type { CoordinatorMode } from "@core/workspace/coordinator";

export type CoordinatorSession = Awaited<
  ReturnType<Workspace["coordinatorSessions"]>
>[number] & { handle: string; label: string };
export type CoordinatorContext = Awaited<
  ReturnType<Workspace["coordinatorContext"]>
>;
export type CoordinatorExchange = { role: "user" | "assistant"; text: string };
export type CoordinatorInput = {
  purpose: "request" | "updates";
  text: string;
  sessions: CoordinatorSession[];
  target: CoordinatorSession | null;
  context: CoordinatorContext | null;
  conversation: CoordinatorExchange[];
};
export type CoordinatorReply = {
  kind: "reply" | "prompt";
  text: string;
  speech: string;
  instruction: string;
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
  ) => Promise<CoordinatorVoice>;
};
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
  proposal: CoordinatorProposal | null;
  conversation: CoordinatorExchange[];
  inputCaption: string;
  outputCaption: string;
  voice: "off" | "connecting" | "connected";
  voiceGeneration: number;
  muted: boolean;
  error: string;
};
