// renderNotificationMessage also transitively imports `@/lib/prisma` (via
// types.ts's NotificationType import chain is type-only, so no runtime DB
// connection happens here — see class-popularity.test.ts for the same
// reasoning), but dotenv must still be loaded first since other modules in
// this file's import graph read `DATABASE_URL` at module load time.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { renderNotificationMessage } from "@/lib/notifications/templates";

describe("renderNotificationMessage", () => {
  it("STRIPE_THRESHOLD: es locale renders a non-empty, Spanish-appropriate title/body and echoes the type", () => {
    const result = renderNotificationMessage(
      "STRIPE_THRESHOLD",
      { studentName: "Ana Pérez", belt: "BLUE", stripes: 2 },
      "es",
    );
    expect(result.type).toBe("STRIPE_THRESHOLD");
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.body).toContain("Ana Pérez");
    // "grado" (stripe/grade) is the Spanish word choice for this template —
    // spot-checks that the ES message keys, not the EN ones, were used.
    expect(result.body).toContain("grado");
    expect(result.body).toContain("Azul"); // translated belt name (es), not the raw "BLUE" enum value
  });

  it("STRIPE_THRESHOLD: en locale renders a non-empty, English-appropriate title/body and echoes the type", () => {
    const result = renderNotificationMessage(
      "STRIPE_THRESHOLD",
      { studentName: "Ana Pérez", belt: "BLUE", stripes: 2 },
      "en",
    );
    expect(result.type).toBe("STRIPE_THRESHOLD");
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.body).toContain("Ana Pérez");
    expect(result.body).toContain("stripe");
    expect(result.body).toContain("Blue");
  });

  it("EXAM_THRESHOLD: es locale uses 'elegible' and translates the belt", () => {
    const result = renderNotificationMessage(
      "EXAM_THRESHOLD",
      { studentName: "Carlos Ruiz", belt: "PURPLE" },
      "es",
    );
    expect(result.type).toBe("EXAM_THRESHOLD");
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.body).toContain("Carlos Ruiz");
    expect(result.body).toContain("elegible");
    expect(result.body).toContain("Morado");
  });

  it("EXAM_THRESHOLD: en locale uses 'eligible' and translates the belt", () => {
    const result = renderNotificationMessage(
      "EXAM_THRESHOLD",
      { studentName: "Carlos Ruiz", belt: "PURPLE" },
      "en",
    );
    expect(result.type).toBe("EXAM_THRESHOLD");
    expect(result.body).toContain("Carlos Ruiz");
    expect(result.body).toContain("eligible");
    expect(result.body).toContain("Purple");
  });

  it("NEW_SIGNUP: es locale mentions the student and uses 'registró'", () => {
    const result = renderNotificationMessage("NEW_SIGNUP", { studentName: "Marta Solano" }, "es");
    expect(result.type).toBe("NEW_SIGNUP");
    expect(result.body).toContain("Marta Solano");
    expect(result.body).toContain("registró");
  });

  it("NEW_SIGNUP: en locale mentions the student and uses 'signed up'", () => {
    const result = renderNotificationMessage("NEW_SIGNUP", { studentName: "Marta Solano" }, "en");
    expect(result.type).toBe("NEW_SIGNUP");
    expect(result.body).toContain("Marta Solano");
    expect(result.body).toContain("signed up");
  });

  it("WEEKLY_DIGEST: es locale mentions the academy name, counts, and 'atrasados'", () => {
    const result = renderNotificationMessage(
      "WEEKLY_DIGEST",
      { academyName: "Alliance Escazú", newSignups: 4, overduePayments: 2 },
      "es",
    );
    expect(result.type).toBe("WEEKLY_DIGEST");
    expect(result.title).toContain("Alliance Escazú");
    expect(result.body).toContain("Alliance Escazú");
    expect(result.body).toContain("4");
    expect(result.body).toContain("2");
    expect(result.body).toContain("atrasados");
  });

  it("WEEKLY_DIGEST: en locale mentions the academy name, counts, and 'overdue'", () => {
    const result = renderNotificationMessage(
      "WEEKLY_DIGEST",
      { academyName: "Alliance Escazú", newSignups: 4, overduePayments: 2 },
      "en",
    );
    expect(result.type).toBe("WEEKLY_DIGEST");
    expect(result.title).toContain("Alliance Escazú");
    expect(result.body).toContain("4");
    expect(result.body).toContain("2");
    expect(result.body).toContain("overdue");
  });
});
