/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — the default ADULT/KIDS rank
 * catalog every new organization's registration transaction seeds
 * ("Create the pending organization and its configuration atomically...
 * and both seeded rank catalogs in one transaction"). Extracted verbatim
 * from prisma/seed.ts (Alliance's own seed used to define these inline)
 * specifically so there is exactly one copy of this data — a real gym's
 * belt colors/labels/thresholds are not something worth maintaining twice
 * and letting drift between the dev seed and real registrations.
 *
 * `prisma/seed.ts` imports these same constants for Alliance's own
 * deterministic (fixed-id, upsert-based) seeding; a real registration
 * creates plain rows with auto-generated cuids instead — different create
 * semantics, same underlying data.
 */

export type BeltCode = "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK";

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

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3b: primaryColor values are the
 * existing --belt-white/blue/purple/brown/black OKLCH design tokens
 * (globals.css) converted to hex. barColor is black for every adult rank
 * except BLACK itself, whose bar is red (--bad) per spec: "never hardcode
 * black: a black belt's bar is red."
 */
const ADULT_BAR_BLACK = "#111116";
const ADULT_BAR_RED = "#B63B32";

export const ADULT_RANKS: Array<{
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
  /** Set only where a rank is NOT attendance-based (black belt): overrides the track's mode for this rank. */
  progressionMode?: "TIME";
  /** Months to reach degree i+1 from degree i (index = current degree count). Degrees beyond the list are configured later, not declared impossible. */
  stripeIntervalMonths?: number[];
}> = [
  { code: "WHITE", labelEs: "Blanco", labelEn: "White", order: 1, maxStripes: 4, attendancesPerStripe: 30, attendancesForExam: 30, isTerminal: false, primaryColor: "#F0EBE0", barColor: ADULT_BAR_BLACK },
  { code: "BLUE", labelEs: "Azul", labelEn: "Blue", order: 2, maxStripes: 4, attendancesPerStripe: 65, attendancesForExam: 65, isTerminal: false, primaryColor: "#215DA5", barColor: ADULT_BAR_BLACK },
  { code: "PURPLE", labelEs: "Morado", labelEn: "Purple", order: 3, maxStripes: 4, attendancesPerStripe: 75, attendancesForExam: 75, isTerminal: false, primaryColor: "#652F94", barColor: ADULT_BAR_BLACK },
  { code: "BROWN", labelEs: "Café", labelEn: "Brown", order: 4, maxStripes: 4, attendancesPerStripe: 85, attendancesForExam: 85, isTerminal: false, primaryColor: "#643D20", barColor: ADULT_BAR_BLACK },
  // Terminal, and TIME-based rather than attendance-based (docs/PROMOTION_PROGRESS_PROPOSAL.md,
  // the academy's decision): black -> 1st degree 36 months, 1 -> 2 36, 2 -> 3 36, 3 -> 4 60,
  // 4 -> 5 60, 5 -> 6 60. Eligibility is configured through the 6th degree only; later degrees
  // stay unconfigured (not declared impossible) until the academy supplies their intervals.
  {
    code: "BLACK",
    labelEs: "Negro",
    labelEn: "Black",
    order: 5,
    maxStripes: 6,
    attendancesPerStripe: null,
    attendancesForExam: null,
    isTerminal: true,
    primaryColor: "#111116",
    barColor: ADULT_BAR_RED,
    progressionMode: "TIME",
    stripeIntervalMonths: [36, 36, 36, 60, 60, 60],
  },
];

/**
 * Revision 21: the third tape band is YELLOW on every 11-degree kids rank,
 * never the belt's own color. Do not derive tape color from belt color.
 */
const TAPE = {
  white: "#FFFFFF",
  red: "#DC2626",
  yellow: "#FACC15",
} as const;

const KIDS_PRIMARY = {
  white: "#F0EBE0",
  grey: "#9CA3AF",
  yellow: "#FACC15",
  orange: "#F97316",
  green: "#16A34A",
  black: "#111116",
} as const;
export const KIDS_BAR = "#111116";

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

export const KIDS_RANKS: Array<{
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
