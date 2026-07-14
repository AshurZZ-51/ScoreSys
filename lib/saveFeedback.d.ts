export type SaveFeedbackTone = 'saving' | 'success' | 'error';

export interface SaveFeedback {
  tone: SaveFeedbackTone;
  text: string;
}

export function createSaveFeedback(
  state: SaveFeedbackTone,
  action: string,
  errorMessage?: string
): SaveFeedback;
