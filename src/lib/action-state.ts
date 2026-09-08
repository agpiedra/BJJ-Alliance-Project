export type ActionState = {
  ok?: true;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export const INITIAL_ACTION_STATE: ActionState = {};
