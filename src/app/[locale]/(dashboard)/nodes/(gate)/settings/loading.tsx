import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const SKELETON_ROW_COUNT = 6;
const SKELETON_ROWS = Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => i);

function Bar({ className }: { className?: string }) {
  return (
    <span
      className={`bg-muted inline-block h-4 animate-pulse rounded ${className ?? ""}`}
    />
  );
}

export default function NodesSettingsLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <div className="flex flex-wrap items-center gap-3">
        <Bar className="w-72" />
        <Bar className="w-44" />
        <Bar className="w-48" />
        <Bar className="w-16" />
        <Bar className="w-16" />
        <Bar className="w-16" />
        <span className="ml-auto inline-flex">
          <Bar className="w-28" />
        </span>
      </div>
      <Bar className="w-56" />
      <div className="overflow-hidden rounded-lg bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[44px] pl-4">
                <Bar className="w-4" />
              </TableHead>
              <TableHead>
                <Bar className="w-20" />
              </TableHead>
              <TableHead>
                <Bar className="w-20" />
              </TableHead>
              <TableHead>
                <Bar className="w-24" />
              </TableHead>
              <TableHead>
                <Bar className="w-20" />
              </TableHead>
              <TableHead className="text-center">
                <Bar className="w-16" />
              </TableHead>
              <TableHead className="text-center">
                <Bar className="w-16" />
              </TableHead>
              <TableHead className="text-center">
                <Bar className="w-16" />
              </TableHead>
              <TableHead className="text-center">
                <Bar className="w-16" />
              </TableHead>
              <TableHead className="text-center">
                <Bar className="w-16" />
              </TableHead>
              <TableHead className="text-center">
                <Bar className="w-16" />
              </TableHead>
              <TableHead className="text-center">
                <Bar className="w-16" />
              </TableHead>
              <TableHead className="w-[44px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {SKELETON_ROWS.map((i) => (
              <TableRow key={i} data-testid="nodes-loading-row">
                <TableCell className="pl-4">
                  <Bar className="w-4" />
                </TableCell>
                <TableCell>
                  <Bar className="w-32" />
                </TableCell>
                <TableCell>
                  <Bar className="w-24" />
                </TableCell>
                <TableCell>
                  <Bar className="w-40" />
                </TableCell>
                <TableCell>
                  <Bar className="w-32" />
                </TableCell>
                <TableCell className="text-center">
                  <Bar className="w-4" />
                </TableCell>
                <TableCell className="text-center">
                  <Bar className="w-4" />
                </TableCell>
                <TableCell className="text-center">
                  <Bar className="w-4" />
                </TableCell>
                <TableCell className="text-center">
                  <Bar className="w-12" />
                </TableCell>
                <TableCell className="text-center">
                  <Bar className="w-4" />
                </TableCell>
                <TableCell className="text-center">
                  <Bar className="w-4" />
                </TableCell>
                <TableCell className="text-center">
                  <Bar className="w-16" />
                </TableCell>
                <TableCell />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
