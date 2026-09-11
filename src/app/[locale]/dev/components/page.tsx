import { Button } from "@/components/ui/button";
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
import { ProgressToNextGrade } from "@/components/belt-graphic/progress-to-next-grade";

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
                  <BeltBar belt="BLUE" stripes={4} />
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
                  <BeltBar belt="BLACK" stripes={2} />
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
