/**
 * A submitted form as a plain object for Zod — minus the framework's own
 * plumbing.
 *
 * `useActionState` binds a Server Action to its previous state, and Next's
 * runtime submits that binding as hidden fields alongside the visitor's:
 * `$ACTION_REF_n`, `$ACTION_n:m`, `$ACTION_KEY`. They are not user input and
 * no schema names them. A `z.strictObject` — which is right for a public form,
 * so a crafted `logo` or `primaryColor` field is genuinely REJECTED, not
 * silently dropped — sees them as unknown fields and fails the whole
 * submission with `error: "invalid"` and NO field errors. That made the public
 * registration form reject every genuine browser submission (revision 33 of
 * docs/MULTI_ACADEMY_AND_KIDS_BELTS.md), while every test stayed green because
 * tests build their `FormData` by hand and never carry the framework's fields.
 *
 * Only the reserved `$ACTION_` namespace is dropped. `$` cannot begin a field
 * name any schema here would accept, so this removes no data a schema could
 * read, and every genuinely unknown field still fails strict validation.
 */
export function formDataToObject(formData: FormData): Record<string, FormDataEntryValue> {
  return Object.fromEntries([...formData.entries()].filter(([key]) => !key.startsWith("$ACTION_")));
}
