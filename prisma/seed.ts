import "dotenv/config";
import { PrismaClient, Role, StaffRole } from "../src/generated/prisma/client";
import type { ClassType, DayOfWeek, StudentStatus } from "../src/generated/prisma/client";

/// MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2: the old `Belt` enum is gone
/// (replaced by BeltRank, which is a string `code` column so it can vary
/// per organization/track). This seed's own fixed adult belt set is still
/// exactly these 5 values, so a local literal union replaces the import.
type BeltCode = "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK";
import { PrismaPg } from "@prisma/adapter-pg";
import { DateTime } from "luxon";
import { digestLookupSecret, hashSecret } from "../src/lib/crypto";
import { requireEnv } from "../src/lib/env";
import { assertSafeSeedTarget } from "../scripts/lib/seed-safety-guard";
import { ZONE, attendanceDateFromZoned } from "../src/lib/scheduling/zone";

/**
 * docs/MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 0 (rev 10) — deterministic seed.
 *
 * FIXED IDS, FIXED DATES, NO RANDOMNESS. Every id below is a literal string,
 * not the schema's @default(cuid()); every date derives from SEED_NOW, never
 * `new Date()`/`DateTime.now()`. Re-running this seed must leave the database
 * in the exact same state (bcrypt password hashes are the one exception —
 * they carry a fresh random salt each run by design, and are deliberately
 * NOT part of what scripts/alliance-baseline.ts snapshots, so that doesn't
 * break the "byte-identical snapshot" acceptance criterion).
 *
 * This mirrors Alliance's SHAPE, not its data: two branches, a realistic
 * belt pyramid, roughly a year of attendance for most students — plus the
 * specific edge cases Phase 0 requires (see STUDENTS' doc comment). Kids-
 * track coverage is deferred to Phase 3 (Student.track doesn't exist in the
 * schema yet).
 */

const DATABASE_URL = requireEnv("DATABASE_URL");
assertSafeSeedTarget(DATABASE_URL);

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const CODE_PEPPER = requireEnv("CODE_PEPPER");

/** Fixed anchor for every date this seed writes — a Monday. */
const SEED_NOW = DateTime.fromISO("2026-09-07T12:00:00", { zone: ZONE });

/** Every QA login shares this password (already communicated to Alexis). */
const QA_PASSWORD = "TestPass123!";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3b: primaryColor values are the
 * existing --belt-white/blue/purple/brown/black OKLCH design tokens
 * (globals.css) converted to hex — visual continuity with what the app
 * already renders via BELT_FILL_CLASS, not a new palette. barColor is black
 * for every adult rank except BLACK itself, whose bar is red (--bad) per
 * spec: "never hardcode black: a black belt's bar is red."
 */
const ADULT_BAR_BLACK = "#111116";
const ADULT_BAR_RED = "#B63B32";

const ADULT_RANKS: Array<{
  code: BeltCode;
  labelEs: string;
  labelEn: string;
  order: number;
  maxStripes: number;
  attendancesPerStripe: number | null;
  attendancesForExam: number | null;
  isTerminal: boolean;
  primaryColor: string;
  barColor: string;
}> = [
  { code: "WHITE", labelEs: "Blanco", labelEn: "White", order: 1, maxStripes: 4, attendancesPerStripe: 30, attendancesForExam: 30, isTerminal: false, primaryColor: "#F0EBE0", barColor: ADULT_BAR_BLACK },
  { code: "BLUE", labelEs: "Azul", labelEn: "Blue", order: 2, maxStripes: 4, attendancesPerStripe: 65, attendancesForExam: 65, isTerminal: false, primaryColor: "#215DA5", barColor: ADULT_BAR_BLACK },
  { code: "PURPLE", labelEs: "Morado", labelEn: "Purple", order: 3, maxStripes: 4, attendancesPerStripe: 75, attendancesForExam: 75, isTerminal: false, primaryColor: "#652F94", barColor: ADULT_BAR_BLACK },
  { code: "BROWN", labelEs: "Café", labelEn: "Brown", order: 4, maxStripes: 4, attendancesPerStripe: 85, attendancesForExam: 85, isTerminal: false, primaryColor: "#643D20", barColor: ADULT_BAR_BLACK },
  // Terminal: zero seeded stripes, matches the old BeltRequirement's BLACK row.
  { code: "BLACK", labelEs: "Negro", labelEn: "Black", order: 5, maxStripes: 0, attendancesPerStripe: null, attendancesForExam: null, isTerminal: true, primaryColor: "#111116", barColor: ADULT_BAR_RED },
];

/** Deterministic, fixed id — no query needed to resolve a code to its BeltRank row. */
function adultRankId(code: BeltCode): string {
  return `seed-belt-rank-adult-${code.toLowerCase()}`;
}

export type KidsBeltCode =
  | "white"
  | "grey_white"
  | "grey"
  | "grey_black"
  | "yellow_white"
  | "yellow"
  | "yellow_black"
  | "orange_white"
  | "orange"
  | "orange_black"
  | "green_white"
  | "green"
  | "green_black";

function kidsRankId(code: KidsBeltCode): string {
  return `seed-belt-rank-kids-${code}`;
}

/**
 * Revision 21: the third tape band is YELLOW on every 11-degree kids rank,
 * never the belt's own color — the spec table always read "4 white, 4 red,
 * 3 yellow"; an earlier pass wrongly generalized this to color-match the
 * belt. Do not derive tape color from belt color anywhere.
 */
const TAPE = {
  white: "#FFFFFF",
  red: "#DC2626",
  yellow: "#FACC15",
} as const;

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3a — the "selected Alliance kids
 * preset" table. Its own `order` column is 0-based (0..12); this repo's real,
 * enforced convention (`validateTrackConfig`: "orders must be contiguous
 * starting at 1", spec rev 18) is 1-based — so every table position is
 * seeded at table-order + 1 (white=1 .. green_black=13), preserving the
 * exact sequence while conforming to the constraint the table's own column
 * header doesn't. `isTerminal` isn't a table column at all — green_black
 * (the last row) is the one rank with no row at order+1, so it is seeded
 * terminal, exactly the same shape as adult BLACK: the existing terminal
 * amendment (2b) already handles "terminal + below maxStripes -> STRIPE,
 * terminal + at maxStripes -> NONE" correctly for a terminal rank with real
 * degrees (unlike BLACK's maxStripes: 0), so this needs no engine change.
 *
 * `attendancesPerStripe: 10` / `attendancesForExam: 10` on every row per
 * "Alliance kids rule" — a different scale from the adult thresholds
 * (30/65/75/85), which is exactly what the kids-catalog math test below
 * exists to prove the engine handles without being adult-shaped.
 *
 * Tape colors are the real, spec-corrected values (revision 21): white/
 * red/yellow on every 11-degree rank regardless of the belt's own hue —
 * never derive tape color from belt color.
 */
/**
 * Primary belt colors — one per hue in the table's own "belt" column,
 * reusing the off-white/near-black already established for adult ranks so
 * a plain white/black reads consistently across both tracks.
 */
const KIDS_PRIMARY = {
  white: "#F0EBE0",
  grey: "#9CA3AF",
  yellow: "#FACC15",
  orange: "#F97316",
  green: "#16A34A",
  black: "#111116",
} as const;
const KIDS_BAR = "#111116";

const TAPE_5 = [TAPE.white, TAPE.white, TAPE.white, TAPE.white, TAPE.red];
const TAPE_11 = [
  TAPE.white,
  TAPE.white,
  TAPE.white,
  TAPE.white,
  TAPE.red,
  TAPE.red,
  TAPE.red,
  TAPE.red,
  TAPE.yellow,
  TAPE.yellow,
  TAPE.yellow,
];

const KIDS_RANKS: Array<{
  code: KidsBeltCode;
  labelEs: string;
  labelEn: string;
  order: number;
  maxStripes: number;
  stripeColors: string[];
  isTerminal: boolean;
  primaryColor: string;
  centerStripeColor?: string;
}> = [
  { code: "white", labelEs: "Blanco", labelEn: "White", order: 1, maxStripes: 5, stripeColors: TAPE_5, isTerminal: false, primaryColor: KIDS_PRIMARY.white },
  { code: "grey_white", labelEs: "Gris y Blanco", labelEn: "Grey-White", order: 2, maxStripes: 5, stripeColors: TAPE_5, isTerminal: false, primaryColor: KIDS_PRIMARY.grey, centerStripeColor: KIDS_PRIMARY.white },
  { code: "grey", labelEs: "Gris", labelEn: "Grey", order: 3, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.grey },
  { code: "grey_black", labelEs: "Gris y Negro", labelEn: "Grey-Black", order: 4, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.grey, centerStripeColor: KIDS_PRIMARY.black },
  { code: "yellow_white", labelEs: "Amarillo y Blanco", labelEn: "Yellow-White", order: 5, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.yellow, centerStripeColor: KIDS_PRIMARY.white },
  { code: "yellow", labelEs: "Amarillo", labelEn: "Yellow", order: 6, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.yellow },
  { code: "yellow_black", labelEs: "Amarillo y Negro", labelEn: "Yellow-Black", order: 7, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.yellow, centerStripeColor: KIDS_PRIMARY.black },
  { code: "orange_white", labelEs: "Naranja y Blanco", labelEn: "Orange-White", order: 8, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.orange, centerStripeColor: KIDS_PRIMARY.white },
  { code: "orange", labelEs: "Naranja", labelEn: "Orange", order: 9, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.orange },
  { code: "orange_black", labelEs: "Naranja y Negro", labelEn: "Orange-Black", order: 10, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.orange, centerStripeColor: KIDS_PRIMARY.black },
  { code: "green_white", labelEs: "Verde y Blanco", labelEn: "Green-White", order: 11, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.green, centerStripeColor: KIDS_PRIMARY.white },
  { code: "green", labelEs: "Verde", labelEn: "Green", order: 12, maxStripes: 11, stripeColors: TAPE_11, isTerminal: false, primaryColor: KIDS_PRIMARY.green },
  // Terminal: the last kids rank — no row exists at order 14. Unlike adult
  // BLACK, this one still has 11 real degrees (transitioning to the adult
  // track at 16 is a separate, explicit flow, not another BeltRank row).
  { code: "green_black", labelEs: "Verde y Negro", labelEn: "Green-Black", order: 13, maxStripes: 11, stripeColors: TAPE_11, isTerminal: true, primaryColor: KIDS_PRIMARY.green, centerStripeColor: KIDS_PRIMARY.black },
];

const PAYMENT_PLAN_NAMES = ["Mensualidad", "Promoción", "Becado"] as const;

interface ClassDef {
  id: string;
  academyId: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  durationMinutes: number;
  name: string;
  type: ClassType;
  countsTowardPromotion: boolean;
}

const ESCAZU_ID = "seed-academy-escazu";
const ESCALANTE_ID = "seed-academy-escalante";
/// MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 1 — both seeded branches belong to
/// this one organization; every tenant-owned row below sets organizationId
/// to it, mirroring scripts/phase1-backfill-organization.ts's real-data
/// derivation so the deterministic seed and the backfilled dev database stay
/// shaped the same way.
const ALLIANCE_ORG_ID = "seed-org-alliance";

// Verbatim the original (pre-multi-org) Escazú schedule — several existing
// integration tests (perform-check-in, session-scoping, seed) hardcode its
// exact 18-session shape, so trimming it would be an unrelated regression,
// not a seed improvement.
const ESCAZU_CLASSES: ClassDef[] = [
  { id: "seed-class-escazu-01", academyId: ESCAZU_ID, dayOfWeek: "MONDAY", startTime: "06:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-02", academyId: ESCAZU_ID, dayOfWeek: "MONDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-03", academyId: ESCAZU_ID, dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "GI — Principiantes", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-04", academyId: ESCAZU_ID, dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Avanzados", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-05", academyId: ESCAZU_ID, dayOfWeek: "TUESDAY", startTime: "12:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-06", academyId: ESCAZU_ID, dayOfWeek: "TUESDAY", startTime: "18:00", durationMinutes: 60, name: "NO-GI — Todos los niveles", type: "NO_GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-07", academyId: ESCAZU_ID, dayOfWeek: "TUESDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-08", academyId: ESCAZU_ID, dayOfWeek: "WEDNESDAY", startTime: "06:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-09", academyId: ESCAZU_ID, dayOfWeek: "WEDNESDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-10", academyId: ESCAZU_ID, dayOfWeek: "WEDNESDAY", startTime: "18:30", durationMinutes: 60, name: "Competición", type: "COMPETITION", countsTowardPromotion: true },
  { id: "seed-class-escazu-11", academyId: ESCAZU_ID, dayOfWeek: "THURSDAY", startTime: "12:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-12", academyId: ESCAZU_ID, dayOfWeek: "THURSDAY", startTime: "18:00", durationMinutes: 60, name: "NO-GI — Todos los niveles", type: "NO_GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-13", academyId: ESCAZU_ID, dayOfWeek: "THURSDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-14", academyId: ESCAZU_ID, dayOfWeek: "FRIDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { id: "seed-class-escazu-15", academyId: ESCAZU_ID, dayOfWeek: "FRIDAY", startTime: "18:30", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  // Deliberately does not count toward promotion — Phase 0's required edge
  // case (attendance on a class marked countsTowardPromotion: false).
  { id: "seed-class-escazu-16", academyId: ESCAZU_ID, dayOfWeek: "SATURDAY", startTime: "09:00", durationMinutes: 60, name: "Striking", type: "STRIKING", countsTowardPromotion: false },
  { id: "seed-class-escazu-17", academyId: ESCAZU_ID, dayOfWeek: "SATURDAY", startTime: "10:00", durationMinutes: 60, name: "Kids", type: "KIDS", countsTowardPromotion: true },
  { id: "seed-class-escazu-18", academyId: ESCAZU_ID, dayOfWeek: "SATURDAY", startTime: "11:00", durationMinutes: 60, name: "Open Mat", type: "OPEN_MAT", countsTowardPromotion: true },
];

const ESCALANTE_CLASSES: ClassDef[] = [
  { id: "seed-class-escalante-01", academyId: ESCALANTE_ID, dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escalante-02", academyId: ESCALANTE_ID, dayOfWeek: "TUESDAY", startTime: "18:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { id: "seed-class-escalante-03", academyId: ESCALANTE_ID, dayOfWeek: "WEDNESDAY", startTime: "18:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escalante-04", academyId: ESCALANTE_ID, dayOfWeek: "THURSDAY", startTime: "18:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { id: "seed-class-escalante-05", academyId: ESCALANTE_ID, dayOfWeek: "FRIDAY", startTime: "18:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { id: "seed-class-escalante-06", academyId: ESCALANTE_ID, dayOfWeek: "SATURDAY", startTime: "10:00", durationMinutes: 60, name: "Open Mat", type: "OPEN_MAT", countsTowardPromotion: true },
];

const ALL_CLASSES = [...ESCAZU_CLASSES, ...ESCALANTE_CLASSES];
const STRIKING_CLASS = ESCAZU_CLASSES.find((c) => c.type === "STRIKING")!;
const KIDS_CLASS = ESCAZU_CLASSES.find((c) => c.type === "KIDS")!;
const escazuGi = (n: number) => ESCAZU_CLASSES.filter((c) => c.type === "GI")[n]!;
const escalanteGi = (n: number) => ESCALANTE_CLASSES.filter((c) => c.type === "GI")[n]!;

interface StudentDef {
  id: string;
  firstName: string;
  lastName: string;
  homeAcademyId: string;
  belt: BeltCode;
  currentStripes: number;
  joinedAt: DateTime;
  beltAwardedAt: DateTime;
  pin: string;
  status: StudentStatus;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md revision 14: "the Phase 0 seed... uses
 * plausible names and the academy's real schedule rather than obvious
 * placeholders" — a requirement the code never actually followed until
 * Phase 3a (this seed is also the demo the director sees). Ids/pins are
 * unchanged (`seed-student-NNN`, still what `deterministic-seed.test.ts`
 * asserts against) — only the two display fields change.
 */
const ADULT_NAMES: Record<number, [string, string]> = {
  1: ["Andrés", "Solano"], 2: ["Fabiola", "Jiménez"], 3: ["Ricardo", "Mora"], 4: ["Daniela", "Chaves"],
  5: ["Esteban", "Vindas"], 6: ["Paola", "Rodríguez"], 7: ["Manuel", "Ureña"], 8: ["Gabriela", "Sánchez"],
  9: ["Luis", "Zúñiga"], 10: ["Karina", "Barrantes"], 11: ["Jorge", "Alvarado"], 12: ["Melissa", "Cordero"],
  13: ["Federico", "Gómez"], 14: ["Natalia", "Soto"], 15: ["Alberto", "Campos"], 16: ["Vanessa", "Loría"],
  17: ["Cristian", "Montero"], 18: ["Adriana", "Fonseca"], 19: ["Mauricio", "Delgado"], 20: ["Silvia", "Navarro"],
  21: ["Roberto", "Aguilar"], 22: ["Marcela", "Villalobos"], 23: ["Kevin", "Chacón"], 24: ["Patricia", "Elizondo"],
};

function studentDef(
  n: number,
  belt: BeltCode,
  homeAcademyId: string,
  currentStripes: number,
  joinedWeeksAgo: number,
  beltAwardedWeeksAgo: number,
): StudentDef {
  const id = `seed-student-${String(n).padStart(3, "0")}`;
  const [firstName, lastName] = ADULT_NAMES[n]!;
  return {
    id,
    firstName,
    lastName,
    homeAcademyId,
    belt,
    currentStripes,
    joinedAt: SEED_NOW.minus({ weeks: joinedWeeksAgo }),
    beltAwardedAt: SEED_NOW.minus({ weeks: beltAwardedWeeksAgo }),
    pin: String(1000 + n),
    status: "ACTIVE",
  };
}

/**
 * 24 students, belt pyramid many-white/few-purple/one-or-two-brown, plus
 * every Phase 0 edge case:
 *  - #1  zero attendance ever;
 *  - #2  trains at both branches;
 *  - #3  at max stripes (4/4) with enough promotion-relevant attendance
 *        since the belt anchor to be exam-eligible but not yet awarded —
 *        "awaiting a belt";
 *  - #4  carries a negative-delta manual adjustment;
 *  - #5  has attendance on the countsTowardPromotion:false Striking class;
 *  - #6-24 generic pyramid coverage, one student at every adult belt.
 */
const STUDENTS: StudentDef[] = [
  studentDef(1, "WHITE", ESCAZU_ID, 0, 0, 0),
  studentDef(2, "WHITE", ESCAZU_ID, 1, 52, 52),
  studentDef(3, "WHITE", ESCAZU_ID, 4, 52, 52),
  studentDef(4, "WHITE", ESCAZU_ID, 1, 40, 40),
  studentDef(5, "WHITE", ESCAZU_ID, 0, 20, 20),
  studentDef(6, "WHITE", ESCAZU_ID, 2, 45, 45),
  studentDef(7, "WHITE", ESCAZU_ID, 1, 30, 30),
  studentDef(8, "WHITE", ESCAZU_ID, 0, 15, 15),
  studentDef(9, "WHITE", ESCAZU_ID, 3, 48, 48),
  studentDef(10, "WHITE", ESCAZU_ID, 1, 25, 25),
  studentDef(11, "WHITE", ESCAZU_ID, 2, 35, 35),
  studentDef(12, "WHITE", ESCAZU_ID, 0, 10, 10),
  studentDef(13, "BLUE", ESCAZU_ID, 1, 90, 20),
  studentDef(14, "BLUE", ESCAZU_ID, 2, 100, 30),
  studentDef(15, "BLUE", ESCAZU_ID, 0, 70, 10),
  studentDef(16, "BLUE", ESCAZU_ID, 3, 110, 40),
  studentDef(17, "BLUE", ESCALANTE_ID, 1, 85, 15),
  studentDef(18, "BLUE", ESCALANTE_ID, 2, 95, 25),
  studentDef(19, "PURPLE", ESCALANTE_ID, 1, 160, 20),
  studentDef(20, "PURPLE", ESCALANTE_ID, 2, 170, 30),
  studentDef(21, "PURPLE", ESCALANTE_ID, 0, 150, 10),
  studentDef(22, "BROWN", ESCALANTE_ID, 1, 220, 20),
  studentDef(23, "BROWN", ESCALANTE_ID, 2, 230, 30),
  studentDef(24, "BLACK", ESCALANTE_ID, 0, 300, 300),
];
// #1 is the zero-attendance / brand-new joiner — override to 3 days, not 0.
STUDENTS[0]!.joinedAt = SEED_NOW.minus({ days: 3 });
STUDENTS[0]!.beltAwardedAt = STUDENTS[0]!.joinedAt;

interface KidsStudentDef {
  id: string;
  firstName: string;
  lastName: string;
  belt: KidsBeltCode;
  currentStripes: number;
  beltAwardedWeeksAgo: number;
  guardianName: string;
  guardianPhone: string;
  dateOfBirthIso: string;
  pin: string;
}

function kidsStudentDef(
  n: number,
  firstName: string,
  lastName: string,
  belt: KidsBeltCode,
  currentStripes: number,
  beltAwardedWeeksAgo: number,
  guardianName: string,
  dateOfBirthIso: string,
): KidsStudentDef {
  return {
    // NOT `seed-student-kids-...` — deterministic-seed.test.ts's adult-only
    // assertions filter by `id: { startsWith: "seed-student-" }`, and that
    // prefix would otherwise swallow these too.
    id: `seed-kids-student-${String(n).padStart(3, "0")}`,
    firstName,
    lastName,
    belt,
    currentStripes,
    beltAwardedWeeksAgo,
    guardianName,
    guardianPhone: `+506 8${String(7000 + n).padStart(4, "0")}-${String(n).padStart(4, "0")}`,
    dateOfBirthIso,
    pin: String(2000 + n),
  };
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3a amendment 1: "3a needs kids
 * students, not just kids ranks" — a realistic distribution (many at
 * grey/grey-white, fewer at yellow, a couple at orange, one at green), plus
 * the two required edge cases: #6 mid-way through grey's 11 degrees (65 of
 * the 70 needed for degree 7 — 5 remaining), and #7 at max stripes (11)
 * awaiting the grey-black belt (exactly 120 attendances since anchor — the
 * same "at max stripes, exam-eligible, not yet awarded" shape as adult
 * student #3). All at Escazú, attending the existing Saturday 10am Kids
 * class (`seed-class-escazu-17`).
 */
const KIDS_STUDENTS: KidsStudentDef[] = [
  kidsStudentDef(1, "Mateo", "Rojas", "white", 0, 0, "Andrea Rojas", "2020-03-14"),
  kidsStudentDef(2, "Sofía", "Vargas", "grey_white", 2, 15, "Karla Vargas", "2020-11-02"),
  kidsStudentDef(3, "Emiliano", "Castro", "grey_white", 3, 25, "Luis Castro", "2019-06-20"),
  kidsStudentDef(4, "Valentina", "Araya", "grey", 4, 35, "Marisol Araya", "2020-01-08"),
  kidsStudentDef(5, "Nicolás", "Fallas", "grey", 7, 68, "Deivis Fallas", "2019-09-25"),
  // Mid-way through grey's 11 degrees — 65 attendances, degree 7 needs 70.
  kidsStudentDef(6, "Isabella", "Brenes", "grey", 6, 65, "Priscilla Brenes", "2020-04-30"),
  // At max stripes (11), exam-eligible (11*10 + 10 = 120), awaiting the belt.
  kidsStudentDef(7, "Santiago", "Chinchilla", "grey", 11, 120, "Warner Chinchilla", "2019-12-11"),
  kidsStudentDef(8, "Camila", "Quesada", "grey_black", 3, 20, "Yolanda Quesada", "2019-02-17"),
  kidsStudentDef(9, "Diego", "Salas", "yellow_white", 2, 12, "Randall Salas", "2017-08-05"),
  kidsStudentDef(10, "Renata", "Herrera", "yellow", 4, 30, "Ivannia Herrera", "2018-05-22"),
  kidsStudentDef(11, "Joaquín", "Cordero", "orange", 3, 22, "Esteban Cordero", "2015-10-13"),
  kidsStudentDef(12, "Martina", "Alfaro", "orange_black", 2, 14, "Cindy Alfaro", "2016-07-01"),
  kidsStudentDef(13, "Leonardo", "Gómez", "green", 3, 18, "Adrián Gómez", "2013-01-27"),
];

const ADMIN_USER_ID = "seed-user-admin";
const DIRECTOR_USER_ID = "seed-user-director";
const INSTRUCTOR_USER_ID = "seed-user-instructor";
const STUDENT_LOGIN_USER_ID = "seed-user-student";
const QA_DIRECTOR_USER_ID = "seed-user-qa-director";
const QA_STUDENT_RECORD_ID = "seed-student-qa-prueba";

async function seedOrganization() {
  const data = {
    slug: "alliance-cr",
    name: "Alliance Jiu-Jitsu Costa Rica",
    status: "ACTIVE" as const,
    timezone: ZONE,
    defaultLocale: "es",
  };
  await prisma.organization.upsert({
    where: { id: ALLIANCE_ORG_ID },
    update: data,
    create: { id: ALLIANCE_ORG_ID, ...data },
  });

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — Alliance's own yellow/near-
  // black brand identity becomes DATA here, not hardcoded (the acceptance
  // criterion this satisfies: "No literal Alliance, brand hex or logo path
  // remains in src/**"). `logoUrl` stays null (initials fallback) — this
  // seed has no real Supabase credentials to upload `public/branding/
  // logo.png` with; an ADMIN can upload the real logo through the
  // Configuración → Academia settings page once deployed.
  const brandingData = {
    displayName: "Alliance Jiu-Jitsu Costa Rica",
    primaryColor: "#FACC15",
    sidebarBackground: "#111827",
  };
  await prisma.organizationBranding.upsert({
    where: { organizationId: ALLIANCE_ORG_ID },
    update: brandingData,
    create: { organizationId: ALLIANCE_ORG_ID, ...brandingData },
  });
}

async function seedAcademies() {
  const escazuData = {
    organizationId: ALLIANCE_ORG_ID,
    name: "Alliance Escazú",
    slug: "escazu",
    timezone: ZONE,
    kioskTokenHash: digestLookupSecret("seed-kiosk-token-escazu", CODE_PEPPER),
  };
  await prisma.academy.upsert({
    where: { id: ESCAZU_ID },
    update: escazuData,
    create: { id: ESCAZU_ID, ...escazuData },
  });
  const escalanteData = {
    organizationId: ALLIANCE_ORG_ID,
    name: "Alliance Escalante",
    slug: "escalante",
    timezone: ZONE,
    kioskTokenHash: digestLookupSecret("seed-kiosk-token-escalante", CODE_PEPPER),
  };
  await prisma.academy.upsert({
    where: { id: ESCALANTE_ID },
    update: escalanteData,
    create: { id: ESCALANTE_ID, ...escalanteData },
  });
}

async function seedBeltRanks() {
  for (const rank of ADULT_RANKS) {
    const id = adultRankId(rank.code);
    const data = {
      organizationId: ALLIANCE_ORG_ID,
      track: "ADULT" as const,
      code: rank.code,
      labelEs: rank.labelEs,
      labelEn: rank.labelEn,
      order: rank.order,
      maxStripes: rank.maxStripes,
      attendancesPerStripe: rank.attendancesPerStripe,
      attendancesForExam: rank.attendancesForExam,
      isTerminal: rank.isTerminal,
      primaryColor: rank.primaryColor,
      barColor: rank.barColor,
      // Revision 21: adult tapes are white — seeded black before, which
      // rendered black-on-black and hid every adult student's degrees. Kept
      // IN `data` (not only in `create`) so a reseed actually rewrites this
      // on a row that already exists — an update-only field here silently
      // never took effect on the dev database twice before this fix.
      stripeColors: Array.from({ length: rank.maxStripes }, () => "#FFFFFF"),
      visibleStripeSlots: 4,
    };
    await prisma.beltRank.upsert({
      where: { id },
      update: data,
      create: { id, ...data },
    });
  }

  // Preserves current behavior exactly: ATTENDANCE mode, ADMIN/DIRECTOR
  // confirm required — no automatic job exists yet.
  {
    const data = { mode: "ATTENDANCE" as const, requiresCoachApproval: true };
    await prisma.promotionConfig.upsert({
      where: { organizationId_track: { organizationId: ALLIANCE_ORG_ID, track: "ADULT" } },
      update: data,
      create: { id: "seed-promotion-config-adult", organizationId: ALLIANCE_ORG_ID, track: "ADULT", ...data },
    });
  }

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3a — the KIDS catalog, same
  // upsert shape as ADULT above.
  for (const rank of KIDS_RANKS) {
    const id = kidsRankId(rank.code);
    const data = {
      organizationId: ALLIANCE_ORG_ID,
      track: "KIDS" as const,
      code: rank.code,
      labelEs: rank.labelEs,
      labelEn: rank.labelEn,
      order: rank.order,
      maxStripes: rank.maxStripes,
      attendancesPerStripe: 10,
      attendancesForExam: 10,
      isTerminal: rank.isTerminal,
      primaryColor: rank.primaryColor,
      centerStripeColor: rank.centerStripeColor ?? null,
      barColor: KIDS_BAR,
      // Same fix as the ADULT loop above: stripeColors/visibleStripeSlots
      // must live in `data` (shared by update AND create), not only in
      // create — an update-only field is a silent no-op on any row that
      // already exists, which is exactly why this stayed stale twice.
      stripeColors: rank.stripeColors,
      visibleStripeSlots: 4,
    };
    await prisma.beltRank.upsert({
      where: { id },
      update: data,
      create: { id, ...data },
    });
  }

  // Mirrors adult: ATTENDANCE mode, ADMIN/DIRECTOR confirm required. Nothing
  // in the spec asks for kids automation to differ from adult's default.
  {
    const data = { mode: "ATTENDANCE" as const, requiresCoachApproval: true };
    await prisma.promotionConfig.upsert({
      where: { organizationId_track: { organizationId: ALLIANCE_ORG_ID, track: "KIDS" } },
      update: data,
      create: { id: "seed-promotion-config-kids", organizationId: ALLIANCE_ORG_ID, track: "KIDS", ...data },
    });
  }
}

async function seedClassSessions() {
  for (const { id, ...rest } of ALL_CLASSES) {
    const data = { ...rest, organizationId: ALLIANCE_ORG_ID };
    await prisma.classSession.upsert({
      where: { id },
      update: data,
      create: { id, ...data },
    });
  }
}

async function seedPaymentPlans() {
  for (const academyId of [ESCAZU_ID, ESCALANTE_ID]) {
    for (const name of PAYMENT_PLAN_NAMES) {
      await prisma.paymentPlan.upsert({
        where: { academyId_name: { academyId, name } },
        update: { organizationId: ALLIANCE_ORG_ID },
        create: {
          id: `seed-payment-plan-${academyId === ESCAZU_ID ? "escazu" : "escalante"}-${name}`,
          academyId,
          organizationId: ALLIANCE_ORG_ID,
          name,
        },
      });
    }
  }
}

/**
 * The 5 QA logins Alexis uses to test the app, recreated with fixed ids and
 * the same known password on every reset — see the "RESET" decision: these
 * are fixture data now, not preserved rows, so they must survive forever
 * through the seed rather than through manual preservation.
 */
async function seedQaUsers() {
  const passwordHash = await hashSecret(QA_PASSWORD);

  // A single data-driven list, not 5 copy-pasted upserts — one email/role
  // pairing can't drift from its own membership row this way, and the
  // shared `data` object below means neither can `update` drift from
  // `create` (the exact bug class this file was just audited for: email
  // and locale used to be create-only, so a reseed could never correct
  // them on a user that already existed).
  const QA_LOGINS = [
    { id: ADMIN_USER_ID, email: "admin@alliancecr.com", role: Role.ADMIN },
    { id: DIRECTOR_USER_ID, email: "director@test.com", role: Role.DIRECTOR },
    { id: INSTRUCTOR_USER_ID, email: "instructor@test.com", role: Role.INSTRUCTOR },
    { id: STUDENT_LOGIN_USER_ID, email: "student@test.com", role: Role.STUDENT },
    { id: QA_DIRECTOR_USER_ID, email: "qa-director@alliancecr.com", role: Role.DIRECTOR },
  ] as const;

  for (const login of QA_LOGINS) {
    const data = { email: login.email, passwordHash, role: login.role, locale: "es", active: true };
    await prisma.user.upsert({
      where: { id: login.id },
      update: data,
      create: { id: login.id, ...data },
    });
  }

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 1 — organization membership is the
  // authorization source going forward (Appendix C decision 4); every QA
  // login gets a membership matching its User.role, mirroring how the real
  // backfill derives StaffAssignment.organizationId from existing data.
  for (const { id: userId, role } of QA_LOGINS) {
    await prisma.organizationMembership.upsert({
      where: { userId_organizationId: { userId, organizationId: ALLIANCE_ORG_ID } },
      update: { role },
      create: { userId, organizationId: ALLIANCE_ORG_ID, role },
    });
  }

  const STAFF_ASSIGNMENTS = [
    { id: "seed-staff-director-escazu", userId: DIRECTOR_USER_ID, academyId: ESCAZU_ID, role: StaffRole.DIRECTOR },
    { id: "seed-staff-instructor-escazu", userId: INSTRUCTOR_USER_ID, academyId: ESCAZU_ID, role: StaffRole.INSTRUCTOR },
    { id: "seed-staff-qa-director-escalante", userId: QA_DIRECTOR_USER_ID, academyId: ESCALANTE_ID, role: StaffRole.DIRECTOR },
  ] as const;
  for (const assignment of STAFF_ASSIGNMENTS) {
    const data = { organizationId: ALLIANCE_ORG_ID, role: assignment.role };
    await prisma.staffAssignment.upsert({
      where: { userId_academyId: { userId: assignment.userId, academyId: assignment.academyId } },
      update: data,
      create: { id: assignment.id, userId: assignment.userId, academyId: assignment.academyId, ...data },
    });
  }

  // The student portal login (student@test.com) and its linked Student
  // record ("Estudiante Prueba") — same identity Alexis already tested with.
  {
    const data = {
      userId: STUDENT_LOGIN_USER_ID,
      homeAcademyId: ESCAZU_ID,
      organizationId: ALLIANCE_ORG_ID,
      firstName: "Estudiante",
      lastName: "Prueba",
      phone: "+506 8888-0000",
      email: "student@test.com",
      currentRankId: adultRankId("WHITE"),
      currentStripes: 1,
      beltAwardedAt: SEED_NOW.minus({ weeks: 20 }).toJSDate(),
      codeHash: digestLookupSecret("9000", CODE_PEPPER),
      status: "ACTIVE" as const,
      joinedAt: SEED_NOW.minus({ weeks: 20 }).toJSDate(),
    };
    await prisma.student.upsert({
      where: { id: QA_STUDENT_RECORD_ID },
      update: data,
      create: { id: QA_STUDENT_RECORD_ID, ...data },
    });
  }
}

async function seedStudentRoster() {
  for (const s of STUDENTS) {
    const data = {
      homeAcademyId: s.homeAcademyId,
      organizationId: ALLIANCE_ORG_ID,
      firstName: s.firstName,
      lastName: s.lastName,
      phone: `+506 8000-${s.id.slice(-3)}`,
      email: `${s.id}@fixture.internal`,
      dateOfBirth: DateTime.fromISO("1995-01-01", { zone: ZONE }).toJSDate(),
      currentRankId: adultRankId(s.belt),
      currentStripes: s.currentStripes,
      beltAwardedAt: s.beltAwardedAt.toJSDate(),
      codeHash: digestLookupSecret(s.pin, CODE_PEPPER),
      status: s.status,
      joinedAt: s.joinedAt.toJSDate(),
    };
    await prisma.student.upsert({
      where: { id: s.id },
      update: data,
      create: { id: s.id, ...data },
    });
  }
}

async function seedKidsRoster() {
  for (const s of KIDS_STUDENTS) {
    const beltAwardedAt = SEED_NOW.minus({ weeks: s.beltAwardedWeeksAgo });
    const data = {
      homeAcademyId: ESCAZU_ID,
      organizationId: ALLIANCE_ORG_ID,
      track: "KIDS" as const,
      firstName: s.firstName,
      lastName: s.lastName,
      phone: s.guardianPhone,
      email: `${s.id}@fixture.internal`,
      dateOfBirth: DateTime.fromISO(s.dateOfBirthIso, { zone: ZONE }).toJSDate(),
      guardianName: s.guardianName,
      guardianPhone: s.guardianPhone,
      currentRankId: kidsRankId(s.belt),
      currentStripes: s.currentStripes,
      beltAwardedAt: beltAwardedAt.toJSDate(),
      codeHash: digestLookupSecret(s.pin, CODE_PEPPER),
      status: "ACTIVE" as const,
      joinedAt: beltAwardedAt.toJSDate(),
    };
    await prisma.student.upsert({
      where: { id: s.id },
      update: data,
      create: { id: s.id, ...data },
    });
  }
}

/** CR-zoned instant for a class occurrence on a given calendar date. */
function occurrenceInstant(date: DateTime, classDef: ClassDef): DateTime {
  const [hour, minute] = classDef.startTime.split(":").map(Number);
  return date.set({ hour, minute, second: 0, millisecond: 0 });
}

/** Every date `weekday` (luxon 1=Mon..7=Sun) falls on within [start, end]. */
function weeklyDates(start: DateTime, end: DateTime, weekday: number): DateTime[] {
  let d = start.startOf("day");
  while (d.weekday !== weekday) d = d.plus({ days: 1 });
  const out: DateTime[] = [];
  while (d <= end) {
    out.push(d);
    d = d.plus({ weeks: 1 });
  }
  return out;
}

let attendanceSeq = 0;
async function upsertCheckIn(studentId: string, classDef: ClassDef, occurrence: DateTime) {
  attendanceSeq += 1;
  const id = `seed-attendance-${String(attendanceSeq).padStart(4, "0")}`;
  const occurredAt = occurrence.toUTC().toJSDate();
  const date = attendanceDateFromZoned(occurrence);
  const data = {
    studentId,
    academyId: classDef.academyId,
    organizationId: ALLIANCE_ORG_ID,
    classSessionId: classDef.id,
    occurredAt,
    date,
    type: "CHECKIN" as const,
    delta: 1,
    source: "KIOSK" as const,
  };
  await prisma.attendanceRecord.upsert({
    where: { id },
    update: data,
    create: { id, ...data },
  });
}

async function upsertAdjustment(studentId: string, academyId: string, occurrence: DateTime, delta: number, reason: string) {
  attendanceSeq += 1;
  const id = `seed-attendance-${String(attendanceSeq).padStart(4, "0")}`;
  const occurredAt = occurrence.toUTC().toJSDate();
  const date = attendanceDateFromZoned(occurrence);
  const data = {
    studentId,
    academyId,
    organizationId: ALLIANCE_ORG_ID,
    classSessionId: null,
    occurredAt,
    date,
    type: "ADJUSTMENT" as const,
    delta,
    reason,
    source: "STAFF" as const,
    createdById: ADMIN_USER_ID,
  };
  await prisma.attendanceRecord.upsert({
    where: { id },
    update: data,
    create: { id, ...data },
  });
}

/**
 * Deterministic attendance. Each regular student attends a fixed weekday at
 * their home academy from their join date to SEED_NOW ("roughly a year" for
 * most, since most join dates are ~10-110 weeks back). The five edge-case
 * students (see STUDENTS' doc comment) get their specific extra treatment
 * here, not folded into the generic loop.
 */
async function seedAttendance() {
  // #1 zero attendance — no rows at all.

  // #2 trains at both branches.
  const s2 = STUDENTS[1]!;
  for (const occ of weeklyDates(s2.joinedAt, SEED_NOW, 1)) await upsertCheckIn(s2.id, escazuGi(0), occurrenceInstant(occ, escazuGi(0)));
  for (const occ of weeklyDates(s2.joinedAt, SEED_NOW, 4)) await upsertCheckIn(s2.id, escalanteGi(2), occurrenceInstant(occ, escalanteGi(2)));

  // #3 at max stripes (4/4), awaiting belt: needs >=150 promotion-relevant
  // attendances since beltAwardedAt (4 stripes x30 + 30 exam = 150). Three
  // GI slots/week for 52 weeks = 156.
  const s3 = STUDENTS[2]!;
  for (const occ of weeklyDates(s3.beltAwardedAt, SEED_NOW, 1)) await upsertCheckIn(s3.id, escazuGi(0), occurrenceInstant(occ, escazuGi(0)));
  for (const occ of weeklyDates(s3.beltAwardedAt, SEED_NOW, 3)) await upsertCheckIn(s3.id, escazuGi(1), occurrenceInstant(occ, escazuGi(1)));
  for (const occ of weeklyDates(s3.beltAwardedAt, SEED_NOW, 4)) await upsertCheckIn(s3.id, escazuGi(2), occurrenceInstant(occ, escazuGi(2)));

  // #4 carries a negative-delta manual adjustment (a correction), on top of
  // otherwise-normal attendance.
  const s4 = STUDENTS[3]!;
  for (const occ of weeklyDates(s4.joinedAt, SEED_NOW, 1)) await upsertCheckIn(s4.id, escazuGi(0), occurrenceInstant(occ, escazuGi(0)));
  await upsertAdjustment(
    s4.id,
    ESCAZU_ID,
    SEED_NOW.minus({ weeks: 4 }),
    -1,
    "Corrección: check-in duplicado eliminado manualmente",
  );

  // #5 has attendance on the countsTowardPromotion:false Striking class,
  // plus a couple of ordinary GI check-ins so the two are distinguishable.
  const s5 = STUDENTS[4]!;
  for (const occ of weeklyDates(s5.joinedAt, SEED_NOW, 1)) await upsertCheckIn(s5.id, escazuGi(0), occurrenceInstant(occ, escazuGi(0)));
  for (const occ of weeklyDates(s5.joinedAt, SEED_NOW, 6)) await upsertCheckIn(s5.id, STRIKING_CLASS, occurrenceInstant(occ, STRIKING_CLASS));

  // #6-24 generic: one weekly slot at their home academy's first GI class,
  // from their join date to SEED_NOW.
  for (let i = 5; i < STUDENTS.length; i++) {
    const s = STUDENTS[i]!;
    const cls = s.homeAcademyId === ESCAZU_ID ? escazuGi(0) : escalanteGi(0);
    for (const occ of weeklyDates(s.joinedAt, SEED_NOW, 1)) await upsertCheckIn(s.id, cls, occurrenceInstant(occ, cls));
  }

  // The QA student (student@test.com) — light, ordinary attendance.
  for (const occ of weeklyDates(SEED_NOW.minus({ weeks: 20 }), SEED_NOW, 2)) {
    await upsertCheckIn(QA_STUDENT_RECORD_ID, escazuGi(1), occurrenceInstant(occ, escazuGi(1)));
  }
}

/**
 * One weekly Saturday slot at the existing Kids class, from each kid's own
 * belt-anchor date to SEED_NOW — exactly `beltAwardedWeeksAgo` Saturdays,
 * since both dates sit on a fixed weekly cadence from a Monday `SEED_NOW`.
 * This is what makes the two required edge cases (#6 mid-way at exactly 65,
 * #7 exam-eligible at exactly 120) land on their exact intended numbers.
 */
async function seedKidsAttendance() {
  for (const s of KIDS_STUDENTS) {
    const beltAwardedAt = SEED_NOW.minus({ weeks: s.beltAwardedWeeksAgo });
    for (const occ of weeklyDates(beltAwardedAt, SEED_NOW, 6)) {
      await upsertCheckIn(s.id, KIDS_CLASS, occurrenceInstant(occ, KIDS_CLASS));
    }
  }
}

async function seedPromotions() {
  // One representative historical promotion per non-white student, dated
  // at their beltAwardedAt — the award that brought them to their current
  // belt. fromBelt is a simplification (their immediately-prior belt), not
  // a full multi-step history.
  const priorBelt: Record<BeltCode, BeltCode | null> = {
    WHITE: null,
    BLUE: "WHITE",
    PURPLE: "BLUE",
    BROWN: "PURPLE",
    BLACK: "BROWN",
  };
  let seq = 0;
  for (const s of STUDENTS) {
    const from = priorBelt[s.belt];
    if (!from) continue;
    seq += 1;
    const id = `seed-promotion-${String(seq).padStart(3, "0")}`;
    const data = {
      studentId: s.id,
      academyId: s.homeAcademyId,
      organizationId: ALLIANCE_ORG_ID,
      fromRankId: adultRankId(from),
      fromStripes: 4,
      toRankId: adultRankId(s.belt),
      toStripes: 0,
      awardedById: ADMIN_USER_ID,
      awardedAt: s.beltAwardedAt.toJSDate(),
      notes: "Ascenso registrado en la incorporación (dato histórico del seed).",
    };
    await prisma.promotion.upsert({
      where: { id },
      update: data,
      create: { id, ...data },
    });
  }
}

async function seedPayments() {
  const plan = (academyId: string, name: (typeof PAYMENT_PLAN_NAMES)[number]) =>
    prisma.paymentPlan.findUniqueOrThrow({ where: { academyId_name: { academyId, name } } });

  const mensualidadEscazu = await plan(ESCAZU_ID, "Mensualidad");
  const mensualidadEscalante = await plan(ESCALANTE_ID, "Mensualidad");
  const becado = await plan(ESCAZU_ID, "Becado");

  const currentMonth = { year: SEED_NOW.year, month: SEED_NOW.month };

  const PAYMENT_PERIODS = [
    // #6: paid this month.
    { id: "seed-payment-001", studentId: STUDENTS[5]!.id, academyId: ESCAZU_ID, planId: mensualidadEscazu.id, status: "PAID" as const, amount: "45000" as const, recordedById: ADMIN_USER_ID },
    // #13: pending (overdue candidate).
    { id: "seed-payment-002", studentId: STUDENTS[12]!.id, academyId: ESCAZU_ID, planId: mensualidadEscazu.id, status: "PENDING" as const, amount: null, recordedById: ADMIN_USER_ID },
    // #1 (zero attendance / brand new): exempt/scholarship.
    { id: "seed-payment-003", studentId: STUDENTS[0]!.id, academyId: ESCAZU_ID, planId: becado.id, status: "EXEMPT" as const, amount: null, recordedById: ADMIN_USER_ID },
    // #19 (Escalante purple): paid this month.
    { id: "seed-payment-004", studentId: STUDENTS[18]!.id, academyId: ESCALANTE_ID, planId: mensualidadEscalante.id, status: "PAID" as const, amount: "45000" as const, recordedById: QA_DIRECTOR_USER_ID },
  ];

  for (const p of PAYMENT_PERIODS) {
    const data = {
      studentId: p.studentId,
      academyId: p.academyId,
      organizationId: ALLIANCE_ORG_ID,
      ...currentMonth,
      planId: p.planId,
      status: p.status,
      amount: p.amount,
      recordedById: p.recordedById,
      recordedAt: SEED_NOW.toJSDate(),
    };
    await prisma.paymentPeriod.upsert({
      where: { studentId_year_month: { studentId: p.studentId, ...currentMonth } },
      update: data,
      create: { id: p.id, ...data },
    });
  }
}

async function main() {
  await seedOrganization();
  await seedAcademies();
  await seedBeltRanks();
  await seedClassSessions();
  await seedPaymentPlans();
  await seedQaUsers();
  await seedStudentRoster();
  await seedKidsRoster();
  await seedAttendance();
  await seedKidsAttendance();
  await seedPromotions();
  await seedPayments();

  console.log("Deterministic seed complete.");
  console.log("QA logins (password for all: " + QA_PASSWORD + "):");
  console.log("  admin@alliancecr.com (ADMIN)");
  console.log("  director@test.com (DIRECTOR, Escazú)");
  console.log("  instructor@test.com (INSTRUCTOR, Escazú)");
  console.log("  student@test.com (STUDENT, Escazú)");
  console.log("  qa-director@alliancecr.com (DIRECTOR, Escalante)");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
