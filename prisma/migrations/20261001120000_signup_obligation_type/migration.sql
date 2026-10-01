-- Enrollment/resume integration plan §7.5/§8: SIGNUP added as a third DuesObligationType value, in its OWN migration,
-- separate from the one that adds the CHECK branch and partial unique index referencing it (the next migration) — a
-- newly-added enum value cannot safely be used in the same transaction that added it, so the two are split into
-- separate migrations (each its own transaction) rather than relying on a same-transaction exception that may not
-- hold on every Postgres version this schema targets.
ALTER TYPE "DuesObligationType" ADD VALUE 'SIGNUP';
