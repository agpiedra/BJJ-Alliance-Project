"use server";

import { resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { prisma } from "@/lib/prisma";
import { lockStudent } from "@/lib/students/lock";
import { todayInAsDbDate } from "@/lib/students/status-history";
import type { ActionState } from "@/lib/action-state";

export type BaselineState = ActionState & { count?: number };

/**
 * Eligibility-prerequisites brief, section 4: owners only, no UI in this PR (the brief mentions an owner-reviewed screen but does
 * not build it). Safe to run at any time, as many times as needed. For every student who currently has ZERO
 * `StudentStatusChange` rows: locks that student's row, RE-CHECKS under the lock that the count is still zero (this is what
 * makes a repeated run — or a race against a concurrent real event for a never-touched student — a true no-op rather than a
 * duplicate row), then writes exactly one row: the student's CURRENT status, `source: BASELINE`, dated today in THAT student's
 * own branch's timezone. Never invents anything before that capture, including for a student who already has any row (a
 * `BASELINE` from an earlier run, or a real `EVENT`) — that student is left alone entirely.
 */
export async function runStatusHistoryBaseline(organizationId: string, _prevState: BaselineState, _formData: FormData): Promise<BaselineState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const candidates = await getScopedDb(context).student.findMany({
    where: { statusHistory: { none: {} } },
    select: { id: true, organizationId: true, status: true, homeAcademy: { select: { timezone: true } } },
  });

  let count = 0;
  for (const student of candidates) {
    const applied = await prisma.$transaction(async (tx) => {
      const locked = await lockStudent(tx, student.organizationId, student.id);
      if (!locked) return false;
      // Re-verified under the lock: a real event (or another run) may have raced ahead of this one since `candidates` was read.
      const existing = await tx.studentStatusChange.count({ where: { organizationId: student.organizationId, studentId: student.id } });
      if (existing > 0) return false;

      await tx.studentStatusChange.create({
        data: {
          organizationId: student.organizationId,
          studentId: student.id,
          status: student.status,
          effectiveOn: todayInAsDbDate(student.homeAcademy.timezone, new Date()),
          sequence: 1,
          source: "BASELINE",
          actorId: context.actorUserId,
        },
      });
      return true;
    });
    if (applied) count++;
  }

  return { ok: true, count };
}
