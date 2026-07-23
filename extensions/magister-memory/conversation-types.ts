export type ConversationMemoryMode = "off" | "shadow" | "active";

export type ConversationCheckpointConfig = {
  mode: ConversationMemoryMode;
  model: string;
  idleMinutes: number;
  recentDays: number;
  maxInputChars: number;
  maxCheckpointChars: number;
  maxHeaderChars: number;
  maxRecallChars: number;
  promotionConfidence: number;
};

export type TranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  fingerprint: string;
};

export type DurableCandidate = {
  target: "memory" | "user";
  key: string;
  value: string;
  action: "add" | "replace";
  evidence: string;
  confidence: number;
};

export type CheckpointSummary = {
  summary: string;
  topics: string[];
  durableCandidates: DurableCandidate[];
  source: "model" | "fallback";
};

export type CheckpointRecord = {
  version: 1;
  checkpointId: string;
  sessionHash: string;
  sequence: number;
  startFingerprint: string;
  endFingerprint: string;
  createdAt: number;
  summary: string;
  topics: string[];
};

export type CheckpointInFlight = {
  checkpointId: string;
  entries: TranscriptEntry[];
  startedAt: number;
  sequence: number;
  startFingerprint: string;
  endFingerprint: string;
  prepared?: CheckpointSummary;
};

export type ConversationSessionState = {
  version: 1;
  sessionHash: string;
  agentId: string;
  lastMessageFingerprint?: string;
  pending: TranscriptEntry[];
  pendingUserTurns: number;
  lastActivityAt: number;
  sequence: number;
  retryCount: number;
  retryAt?: number;
  previousSummary?: string;
  inFlight?: CheckpointInFlight;
  recallFrozen: boolean;
  frozenRecall?: string;
};

export type MemoryReceipt = {
  version: 1;
  id: string;
  workspaceHash: string;
  target: "memory" | "user";
  action: "add" | "replace" | "remove" | "promotion";
  beforeEntries: string[];
  afterEntries: string[];
  topics: string[];
  createdAt: number;
  groupId?: string;
  groupOrder?: number;
  deliveredAt?: number;
  undoneAt?: number;
};
