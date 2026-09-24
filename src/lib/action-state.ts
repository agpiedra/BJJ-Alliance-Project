export type ActionState = {
  ok?: true;
  /** A success that still deserves a sentence (e.g. an entry that was recorded but added nothing to progress) - a message key, never prose. */
  info?: string;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export const INITIAL_ACTION_STATE: ActionState = {};
