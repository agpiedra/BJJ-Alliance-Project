export type ActionState = {
  ok?: true;
  /** A success that still deserves a sentence (e.g. an entry that was recorded but added nothing to progress) - a message key, never prose. */
  info?: string;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  /** Values for the `error` message's placeholders (e.g. an ISO instant the client formats). */
  messageValues?: Record<string, string>;
  /** On a refusal that must not lose the user's typing (stage 9 rule 6): the submitted field values, echoed back so the form
   * can show them again. Returned in the action response only, never put in a URL. */
  submitted?: Record<string, string>;
};

export const INITIAL_ACTION_STATE: ActionState = {};
