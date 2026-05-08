import { useCallback, useMemo, useState } from "react";
import type React from "react";

export function useTableSelection<T extends { id: string }>({
  rows,
  selectableRows,
  rangeRows,
  isEditableTarget
}: {
  rows: T[];
  selectableRows: T[];
  rangeRows: T[];
  isEditableTarget: (target: EventTarget) => boolean;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [dragStartId, setDragStartId] = useState<string | null>(null);
  const visibleIndexById = useMemo(() => new Map(rangeRows.map((row, index) => [row.id, index])), [rangeRows]);
  const selectedRows = useMemo(() => rows.filter((row) => selectedIds.has(row.id)), [rows, selectedIds]);

  const selectAllRows = useCallback(() => {
    setSelectedIds(new Set(selectableRows.map((row) => row.id)));
    setAnchorId(selectableRows[0]?.id ?? null);
  }, [selectableRows]);

  const selectRange = useCallback(
    (fromId: string, toId: string, additive: boolean) => {
      const from = visibleIndexById.get(fromId);
      const to = visibleIndexById.get(toId);
      if (from === undefined || to === undefined) return;
      const [start, end] = from < to ? [from, to] : [to, from];
      const rangeIds = rangeRows.slice(start, end + 1).map((row) => row.id);
      setSelectedIds((current) => new Set([...(additive ? Array.from(current) : []), ...rangeIds]));
    },
    [rangeRows, visibleIndexById]
  );

  const handleRowMouseDown = useCallback(
    (event: React.MouseEvent, row: T) => {
      if (event.button !== 0) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      if (event.shiftKey && anchorId) {
        selectRange(anchorId, row.id, false);
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        setSelectedIds((current) => {
          const next = new Set(current);
          if (next.has(row.id)) next.delete(row.id);
          else next.add(row.id);
          return next;
        });
        setAnchorId(row.id);
        return;
      }
      setSelectedIds(new Set([row.id]));
      setAnchorId(row.id);
      setDragStartId(row.id);
    },
    [anchorId, isEditableTarget, selectRange]
  );

  const handleRowMouseEnter = useCallback(
    (row: T) => {
      if (!dragStartId) return;
      selectRange(dragStartId, row.id, false);
    },
    [dragStartId, selectRange]
  );

  const handleContextMenu = useCallback(
    (_event: React.MouseEvent, row: T) => {
      if (!selectedIds.has(row.id)) {
        setSelectedIds(new Set([row.id]));
        setAnchorId(row.id);
      }
    },
    [selectedIds]
  );

  return {
    selectedIds,
    selectedRows,
    setSelectedIds,
    setAnchorId,
    setDragStartId,
    selectAllRows,
    handleRowMouseDown,
    handleRowMouseEnter,
    handleContextMenu
  };
}
