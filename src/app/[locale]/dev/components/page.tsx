import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandingScope } from "@/components/branding/branding-scope";
import { resolvePrimaryTheme, resolveSidebarTheme } from "@/lib/theme";
import { Pill } from "@/components/ui/pill";
import { StatTile, StatRow } from "@/components/ui/stat-tile";
import {
  DataTable,
  DataTableHead,
  DataTableHeaderRow,
  DataTableHeaderCell,
  DataTableBody,
  DataTableRow,
  DataTableCell,
} from "@/components/ui/data-table";
import { BarList } from "@/components/ui/bar-list";
import { Heatmap } from "@/components/ui/heatmap";
import { FilterBar, FilterBarSearch, FilterBarSelect } from "@/components/ui/filter-bar";
import { EmptyState } from "@/components/ui/empty-state";
import { BeltBar } from "@/components/belt-graphic/belt-bar";
import type { BeltVisualData } from "@/components/belt-graphic/belt-graphic";
import { ProgressToNextGrade } from "@/components/belt-graphic/progress-to-next-grade";

// Static illustrative examples for this design-system showcase — not real
// rank rows, so the color data is hardcoded here rather than fetched.
const EXAMPLE_BLUE: BeltVisualData = {
  primaryColor: "#215DA5",
  centerStripeColor: null,
  barColor: "#111116",
  stripeColors: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
  maxStripes: 4,
  visibleStripeSlots: 4,
};
const EXAMPLE_BLACK: BeltVisualData = {
  primaryColor: "#111116",
  centerStripeColor: null,
  barColor: "#B63B32",
  stripeColors: [],
  maxStripes: 0,
  visibleStripeSlots: 4,
};

// A fictional tenant (never a real organization) so the tenant-branded look of the shared controls can be reviewed beside the
// default one. Built with the same theme functions get-branding.ts uses.
const HARBOR_PRIMARY = resolvePrimaryTheme("#C2410C");
const HARBOR = {
  organizationId: "dev-harbor",
  displayName: "Harbor Jiu-Jitsu (fictional)",
  initials: "HJ",
  logoUrl: null,
  primary: HARBOR_PRIMARY,
  sidebar: resolveSidebarTheme({ background: "#123B4A", activeBackgroundDefault: HARBOR_PRIMARY.background }),
};

/** MATROOM Phase 1 shared-control states: default, disabled, loading, invalid. Focus: press Tab (the ring is the real one). */
function ControlStates({ title }: { title: string }) {
  const variants = ["primary", "default", "outline", "secondary", "ghost", "destructive"] as const;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-background p-4">
      <h3 className="font-heading text-base font-semibold">{title}</h3>
      {variants.map((variant) => (
        <div key={variant} className="flex flex-wrap items-center gap-2">
          <span className="w-24 font-mono text-xs text-muted-foreground">{variant}</span>
          <Button variant={variant}>Guardar</Button>
          <Button variant={variant} disabled>
            Guardar
          </Button>
          <Button variant={variant} loading>
            Guardando...
          </Button>
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Correo electrónico
          <Input type="email" placeholder="nombre@ejemplo.com" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Contraseña (con error)
          <Input type="password" defaultValue="incorrecta" aria-invalid="true" aria-describedby="dev-err" />
          <span id="dev-err" className="text-sm font-normal text-bad">
            Correo o contraseña incorrectos.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Deshabilitado
          <Input defaultValue="ana@ejemplo.com" disabled />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          País
          <select className="h-9 rounded-sm border bg-card px-3 text-sm pointer-coarse:h-11" defaultValue="cr">
            <option value="cr">Costa Rica</option>
          </select>
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <ProgressToNextGrade current={20} target={60} />
        <ProgressToNextGrade current={58} target={60} />
      </div>
    </div>
  );
}

/**
 * Dev-only preview of the Phase 3 component library (REDESIGN_BRIEF.md) —
 * same purpose as the pre-existing dev/belts page, not linked from any real
 * nav, no auth gate. Lets Phase 3 be visually verified before Phase 4 wires
 * these into real screens.
 */
export default function DevComponentsPage() {
  return (
    <main className="flex flex-col gap-8 p-6">
      <h1 className="text-2xl font-bold">Component library preview</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">Controls and states (MATROOM Phase 1)</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <ControlStates title="MATROOM default (no tenant)" />
          <BrandingScope branding={HARBOR}>
            <ControlStates title="Tenant: Harbor Jiu-Jitsu (fictional)" />
          </BrandingScope>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">Buttons</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary">Inscribir alumno</Button>
          <Button variant="default">Guardar</Button>
          <Button variant="outline">Actualizar</Button>
          <Button variant="ghost">Cancelar</Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">Pills</h2>
        <div className="flex flex-wrap gap-2">
          <Pill variant="ok">Al día</Pill>
          <Pill variant="warn">Pendiente</Pill>
          <Pill variant="bad">Atrasado</Pill>
          <Pill variant="accent">Examen</Pill>
          <Pill variant="plain">SINPE Móvil</Pill>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">StatRow</h2>
        <StatRow>
          <StatTile label="Alumnos activos" value={9} note="+2 este mes" />
          <StatTile
            label="Listos para grado"
            value={3}
            flag="accent"
            note="Fabiola, Natalia, José"
          />
          <StatTile
            label="Mensualidad atrasada"
            value={2}
            flag="bad"
            delta={{ direction: "down", label: "-1 vs. mes pasado" }}
          />
          <StatTile
            label="Asistencias esta semana"
            value={44}
            delta={{ direction: "up", label: "+7 vs. semana pasada" }}
          />
        </StatRow>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">BarList</h2>
        <BarList
          items={[
            { key: "gi-todos", label: "GI · Todos", value: 24 },
            { key: "gi-avanzados", label: "GI · Avanzados", value: 21 },
            { key: "no-gi", label: "NO-GI", value: 11, colorClassName: "bg-class-nogi" },
          ]}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">Heatmap</h2>
        <Heatmap
          rowLabels={["Mañana", "Mediodía", "Tarde", "Noche"]}
          colLabels={["Lun", "Mar", "Mié"]}
          cells={[
            [{ value: 4 }, { value: null }, { value: 4 }],
            [{ value: 7 }, { value: 3 }, { value: 5 }],
            [{ value: 17 }, { value: 11 }, { value: 14 }],
            [{ value: 21 }, { value: 19 }, { value: null }],
          ]}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">FilterBar + DataTable</h2>
        <div className="rounded-lg border border-border">
          <FilterBar>
            <FilterBarSearch placeholder="Buscar por nombre, correo o código de kiosco..." />
            <FilterBarSelect defaultValue="">
              <option value="">Todos los cinturones</option>
              <option value="BLUE">Azul</option>
            </FilterBarSelect>
          </FilterBar>
        </div>
        <DataTable>
          <DataTableHead>
            <DataTableHeaderRow>
              <DataTableHeaderCell>Alumno</DataTableHeaderCell>
              <DataTableHeaderCell>Cinturón</DataTableHeaderCell>
              <DataTableHeaderCell>Progreso</DataTableHeaderCell>
              <DataTableHeaderCell>Pago</DataTableHeaderCell>
            </DataTableHeaderRow>
          </DataTableHead>
          <DataTableBody>
            <DataTableRow>
              <DataTableCell>Fabiola Chaves</DataTableCell>
              <DataTableCell>
                <div className="flex items-center gap-2">
                  <BeltBar belt={EXAMPLE_BLUE} stripes={4} />
                  <span>Azul · 4 franjas</span>
                </div>
              </DataTableCell>
              <DataTableCell>
                <ProgressToNextGrade current={63} target={65} />
              </DataTableCell>
              <DataTableCell>
                <Pill variant="ok">Al día</Pill>
              </DataTableCell>
            </DataTableRow>
            <DataTableRow>
              <DataTableCell>José Mora</DataTableCell>
              <DataTableCell>
                <div className="flex items-center gap-2">
                  <BeltBar belt={EXAMPLE_BLACK} stripes={2} />
                  <span>Negra · 2 franjas</span>
                </div>
              </DataTableCell>
              <DataTableCell>
                <ProgressToNextGrade current={81} target={85} />
              </DataTableCell>
              <DataTableCell>
                <Pill variant="warn">Pendiente</Pill>
              </DataTableCell>
            </DataTableRow>
          </DataTableBody>
        </DataTable>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">EmptyState</h2>
        <div className="rounded-lg border border-border">
          <EmptyState
            message="Ningún estudiante es elegible actualmente para una promoción."
            action={<Button variant="outline">Ver alumnos</Button>}
          />
        </div>
      </section>
    </main>
  );
}
