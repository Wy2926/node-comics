export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DiagnosticLogCategory =
  | 'app.config'
  | 'runtime.message'
  | 'pipeline.stage'
  | 'model.runtime'
  | 'pipeline.detect'
  | 'pipeline.bubble'
  | 'pipeline.ocr'
  | 'pipeline.inpaint'
  | 'pipeline.typeset'
  | 'llm.api'
  | 'image.io'
  | 'extension.api'
  | 'ui.perf'
  | 'error';

export type DiagnosticLogContext = 'popup' | 'content' | 'background' | 'pipeline-host' | 'worker';

export type DiagnosticLogSource = {
  context: DiagnosticLogContext;
  module?: string;
};

export type DiagnosticLogError = {
  name?: string;
  code?: string;
  message: string;
  stack?: string;
  cause?: unknown;
};

export type DiagnosticLogEvent = {
  id: string;
  sessionId: string;
  runId?: string;
  timestamp: string;
  level: DiagnosticLogLevel;
  category: DiagnosticLogCategory;
  source: DiagnosticLogSource;
  message: string;
  data?: Record<string, unknown>;
  error?: DiagnosticLogError;
};

export type DiagnosticLogEventInput = Omit<DiagnosticLogEvent, 'id' | 'sessionId' | 'timestamp'> & {
  id?: string;
  sessionId?: string;
  timestamp?: string;
};

export interface DiagnosticLogObserver {
  emit(input: DiagnosticLogEventInput): void;
  emitAsync?(input: DiagnosticLogEventInput): Promise<boolean>;
}
