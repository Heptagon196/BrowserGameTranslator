import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { layout as layoutText, prepare as prepareText } from "@chenglou/pretext";
import * as RadixContextMenu from "@radix-ui/react-context-menu";
import * as RadixPopover from "@radix-ui/react-popover";
import * as RadixTabs from "@radix-ui/react-tabs";
import { CheckSquare, Eye, FileSearch, Languages, Plus, PlusCircle, RotateCcw, Search, Settings, Sparkles, Trash2 } from "lucide-react";
import type { AnalysisResult, AppStateSnapshot, CharacterEntry, GlossaryEntry, NoTranslateEntry, ProjectConfig, ProviderConfig, TextItem } from "../../../shared/types";
import type { SourceHighlight, SourceViewerState } from "../source-viewer/types";
import { CommandSelect } from "../ui/Selectors";
import { AppDialog, AppTooltip, CheckboxControl, StyledSelect, ToggleSwitch } from "../ui/Primitives";
import { defaultUiSettings } from "../../settingsModel";
import { useTableSelection } from "../../hooks/useTableSelection";
import { ruleLabel } from "../../appUtils";

const SourceFileViewerModal = React.lazy(() => import("../source-viewer/SourceFileViewerModal"));

export type TableSettings = {
  paginationEnabled: boolean;
  pageSize: number;
  searchPaginationEnabled: boolean;
};
export type ResourceTableId = "characters" | "glossary" | "noTranslate";

function lineCount(value: string): number {
  return value.split(/\r?\n/).length;
}

function loadStoredBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function normalizeTableSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

type DataRenderContext = {
  fullText: boolean;
  rowExpanded: boolean;
  onExpandRow: () => void;
  onCollapseRow: () => void;
  onDraftChange?: (value: string) => void;
};

type DataColumn<T> = {
  key: string;
  title: string;
  width?: string;
  render: (row: T, context: DataRenderContext) => React.ReactNode;
  text: (row: T) => string;
};

type DataFilter<T> = {
  label: string;
  value: string;
  predicate: (row: T) => boolean;
};

type DataFilterGroup<T> = {
  label: string;
  allLabel: string;
  className?: string;
  options: Array<DataFilter<T>>;
};

type DataContextRow = { id: string };

type DataContextSource<T> = {
  rows: DataContextRow[];
  originalText: (row: DataContextRow) => string;
  translationText: (row: DataContextRow) => string;
  getStartId: (row: T) => string | null | undefined;
};

type DataSourceInfo = {
  key: string;
  sourceFile: string;
  locator: string;
  original?: string;
  translation?: string;
};

type DataOccurrenceSource<T> = {
  rows: TextItem[];
  sourceLanguage?: ProjectConfig["sourceLanguage"] | string;
  getTerms: (row: T) => Array<string | DataOccurrenceTerm>;
};

type DataOccurrenceTerm = {
  text: string;
  isRegex?: boolean;
};

const dataGridRowHeight = 50;
const dataGridOverscan = 8;
const dataGridCellHorizontalPadding = 20;
const dataGridCellVerticalPadding = 19;
const dataGridTextControlHorizontalPadding = 22;
const dataGridTextControlVerticalPadding = 18;
let activeTableSelectAll: (() => void) | null = null;

type TableTextMetrics = {
  font: string;
  lineHeight: number;
};

function getTableTextMetrics(): TableTextMetrics {
  const styles = getComputedStyle(document.documentElement);
  const family = styles.getPropertyValue("--ui-table-font-family").trim() || defaultUiSettings.tableFontFamily;
  const size = Number.parseFloat(styles.getPropertyValue("--ui-table-font-size")) || defaultUiSettings.tableFontSize;
  return {
    font: `${size}px ${family}`,
    lineHeight: size * 1.5
  };
}

function estimateFullTextHeight(value: string, maxWidth: number, metrics: TableTextMetrics): number {
  const width = Math.max(48, maxWidth);
  const hardBreakHeight = lineCount(value || " ") * metrics.lineHeight;
  try {
    const prepared = prepareText(value || " ", metrics.font, { whiteSpace: "pre-wrap" });
    return Math.ceil(Math.max(layoutText(prepared, width, metrics.lineHeight).height, hardBreakHeight));
  } catch {
    return Math.max(metrics.lineHeight, hardBreakHeight);
  }
}

function estimateFullTextHeightCheap(value: string, maxWidth: number, metrics: TableTextMetrics): number {
  const fontSize = metrics.lineHeight / 1.5;
  const averageGlyphWidth = Math.max(7, fontSize * 0.72);
  const charactersPerLine = Math.max(8, Math.floor(Math.max(48, maxWidth) / averageGlyphWidth));
  const hardLineCount = (value.match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
  const softLineCount = Math.ceil(Math.max(1, value.length) / charactersPerLine);
  return Math.max(hardLineCount, softLineCount) * metrics.lineHeight;
}

export function DataTable<T extends { id: string }>({
  title,
  rows,
  columns,
  tableSettings,
  contextSource,
  occurrenceSource,
  sourceInfo,
  filterGroups = [],
  filters = [],
  emptyText = "暂无数据",
  onRowsChange,
  createRow,
  onTranslateSelected,
  onProofreadSelected
}: {
  title: string;
  rows: T[];
  columns: Array<DataColumn<T>>;
  tableSettings: TableSettings;
  contextSource?: DataContextSource<T>;
  occurrenceSource?: DataOccurrenceSource<T>;
  sourceInfo?: (row: T) => DataSourceInfo | null | undefined;
  filterGroups?: Array<DataFilterGroup<T>>;
  filters?: Array<DataFilter<T>>;
  emptyText?: string;
  onRowsChange?: (rows: T[]) => void | Promise<void>;
  createRow?: () => T;
  onTranslateSelected?: (rows: T[]) => void | Promise<void>;
  onProofreadSelected?: (rows: T[]) => void | Promise<void>;
}) {
  const tableStorageKey = `bgt.dataTable.${encodeURIComponent(title)}`;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [groupFilterValues, setGroupFilterValues] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [expandedTextRowId, setExpandedTextRowId] = useState<string | null>(null);
  const [contextViewer, setContextViewer] = useState<{ startId: string } | null>(null);
  const [occurrenceViewer, setOccurrenceViewer] = useState<{ rows: TextItem[]; selectedIds: Set<string>; terms: DataOccurrenceTerm[]; sourceLanguage?: string } | null>(null);
  const [sourceViewer, setSourceViewer] = useState<SourceViewerState | null>(null);
  const [sourceViewerError, setSourceViewerError] = useState("");
  const [paginationEnabled, setPaginationEnabled] = useState(() => loadStoredBoolean(`${tableStorageKey}.paginationEnabled`, tableSettings.paginationEnabled));
  const [fullTextEnabled, setFullTextEnabled] = useState(() => loadStoredBoolean(`${tableStorageKey}.fullTextEnabled`, false));
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<Set<string>>(() => new Set(columns.filter((column) => !isColumnHiddenByDefault(column)).map((column) => column.key)));
  const gridWrapRef = React.useRef<HTMLDivElement | null>(null);
  const tableRootRef = React.useRef<HTMLDivElement | null>(null);
  const headerCellRefs = React.useRef<Record<string, HTMLSpanElement | null>>({});
  const rowHeightCacheRef = React.useRef(new Map<string, { signature: string; height: number }>());
  const draftCellValuesRef = React.useRef(new Map<string, string>());
  const [columnPixelWidths, setColumnPixelWidths] = useState<Record<string, number>>({});
  const [tableTextMetrics, setTableTextMetrics] = useState<TableTextMetrics>(() => getTableTextMetrics());
  const [draftRowHeights, setDraftRowHeights] = useState<Record<string, number>>({});
  const searchNeedle = normalizeTableSearchText(query);
  const activeFilter = useMemo(() => filters.find((entry) => entry.value === filter), [filters, filter]);
  const activeNamedFilters = useMemo(
    () =>
      filters.length
        ? Object.entries(filterValues)
            .map(([, value]) => filters.find((entry) => entry.value === value))
            .filter((entry): entry is DataFilter<T> => Boolean(entry))
        : [],
    [filters, filterValues]
  );
  const activeGroupFilters = useMemo(
    () =>
      filterGroups
        .map((group) => group.options.find((entry) => entry.value === groupFilterValues[group.label]))
        .filter((entry): entry is DataFilter<T> => Boolean(entry)),
    [filterGroups, groupFilterValues]
  );
  const visibleColumns = useMemo(() => columns.filter((column) => visibleColumnKeys.has(column.key)), [columns, visibleColumnKeys]);
  const filterCriteriaKey = useMemo(
    () =>
      JSON.stringify({
        table: tableStorageKey,
        query: searchNeedle,
        filter,
        filters: filterValues,
        groups: filterGroups.map((group) => [group.label, groupFilterValues[group.label] ?? "all"]),
        rowCount: rows.length
      }),
    [tableStorageKey, searchNeedle, filter, filterValues, filterGroups, groupFilterValues, rows.length]
  );
  const liveFilteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const matchesQuery = !searchNeedle || columns.some((column) => normalizeTableSearchText(column.text(row)).includes(searchNeedle));
        const matchesFilter = !activeFilter || activeFilter.predicate(row);
        const matchesNamedFilters = activeNamedFilters.every((entry) => entry.predicate(row));
        const matchesGroupFilters = activeGroupFilters.every((entry) => entry.predicate(row));
        return matchesQuery && matchesFilter && matchesNamedFilters && matchesGroupFilters;
      }),
    [rows, columns, searchNeedle, activeFilter, activeNamedFilters, activeGroupFilters]
  );
  const [frozenFilterResult, setFrozenFilterResult] = useState<{ key: string; ids: string[] }>(() => ({
    key: filterCriteriaKey,
    ids: liveFilteredRows.map((row) => row.id)
  }));
  useEffect(() => {
    setFrozenFilterResult({ key: filterCriteriaKey, ids: liveFilteredRows.map((row) => row.id) });
  }, [filterCriteriaKey]);
  const filteredRows = useMemo(() => {
    if (frozenFilterResult.key !== filterCriteriaKey) return liveFilteredRows;
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return frozenFilterResult.ids.map((id) => rowsById.get(id)).filter((row): row is T => Boolean(row));
  }, [frozenFilterResult, filterCriteriaKey, liveFilteredRows, rows]);
  const hasQuery = Boolean(searchNeedle);
  const shouldPaginate = paginationEnabled && (hasQuery ? tableSettings.searchPaginationEnabled : true);
  const canUseFullText = true;
  const pageSize = tableSettings.pageSize;
  const pageCount = shouldPaginate ? Math.max(1, Math.ceil(filteredRows.length / pageSize)) : 1;
  const safePage = Math.min(pageCount, Math.max(1, page));
  const visibleRows = shouldPaginate ? filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize) : filteredRows;
  const canAppendRow = Boolean(createRow && onRowsChange);
  const showAppendRow = canAppendRow && (!shouldPaginate || safePage === pageCount);
  const virtualEnabled = !shouldPaginate && visibleRows.length > 250;
  const fullTextActive = canUseFullText && fullTextEnabled;
  const draftCellKey = useCallback((row: T, column: DataColumn<T>) => `${row.id}\u001f${column.key}`, []);
  const getCellText = useCallback((row: T, column: DataColumn<T>) => draftCellValuesRef.current.get(draftCellKey(row, column)) ?? column.text(row), [draftCellKey]);
  const getFullTextRowHeight = useCallback(
    (row: T): number => {
      if (!fullTextActive) return dataGridRowHeight;
      const cells: Array<{ column: DataColumn<T>; text: string; width: number }> = [];
      const signatureParts = [`font:${tableTextMetrics.font}`, `line:${tableTextMetrics.lineHeight}`];
      for (const column of visibleColumns) {
        const columnWidth = Math.round(columnPixelWidths[column.key] ?? 0);
        const text = getCellText(row, column);
        signatureParts.push(column.key, String(columnWidth), text);
        if (columnWidth) cells.push({ column, text, width: columnWidth });
      }
      const signature = signatureParts.join("\u001f");
      const cached = rowHeightCacheRef.current.get(row.id);
      if (cached?.signature === signature) return cached.height;

      let height = dataGridRowHeight;
      for (const cell of cells) {
        const textHeight = estimateFullTextHeight(
          cell.text,
          cell.width - dataGridCellHorizontalPadding - dataGridTextControlHorizontalPadding,
          tableTextMetrics
        );
        height = Math.max(height, textHeight + dataGridCellVerticalPadding + dataGridTextControlVerticalPadding);
      }
      const rounded = Math.ceil(height);
      rowHeightCacheRef.current.set(row.id, { signature, height: rounded });
      return rounded;
    },
    [fullTextActive, visibleColumns, columnPixelWidths, tableTextMetrics, getCellText]
  );
  const estimateFullTextRowHeight = useCallback(
    (row: T): number => {
      if (!fullTextActive) return dataGridRowHeight;
      const cached = rowHeightCacheRef.current.get(row.id);
      if (cached) return cached.height;

      let height = dataGridRowHeight;
      for (const column of visibleColumns) {
        const columnWidth = columnPixelWidths[column.key] ?? 0;
        if (!columnWidth) continue;
        const textHeight = estimateFullTextHeightCheap(
          getCellText(row, column),
          columnWidth - dataGridCellHorizontalPadding - dataGridTextControlHorizontalPadding,
          tableTextMetrics
        );
        height = Math.max(height, textHeight + dataGridCellVerticalPadding + dataGridTextControlVerticalPadding);
      }
      return Math.ceil(height);
    },
    [fullTextActive, visibleColumns, columnPixelWidths, tableTextMetrics, getCellText]
  );
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length + (showAppendRow ? 1 : 0),
    getScrollElement: () => gridWrapRef.current,
    estimateSize: (index) => {
      if (index >= visibleRows.length) return dataGridRowHeight;
      const row = visibleRows[index];
      return row && fullTextActive ? estimateFullTextRowHeight(row) : dataGridRowHeight;
    },
    overscan: dataGridOverscan
  });
  const virtualItems = virtualEnabled ? rowVirtualizer.getVirtualItems() : [];
  const gridTemplateColumns = visibleColumns.map((column) => column.width ?? "minmax(160px, 1fr)").join(" ");
  const {
    selectedIds,
    selectedRows,
    setSelectedIds,
    setAnchorId,
    setDragStartId,
    selectAllRows,
    handleRowMouseDown,
    handleRowMouseEnter,
    handleContextMenu
  } = useTableSelection({
    rows,
    selectableRows: filteredRows,
    rangeRows: visibleRows,
    isEditableTarget
  });

  useEffect(() => {
    activeTableSelectAll = selectAllRows;
    return () => {
      if (activeTableSelectAll === selectAllRows) activeTableSelectAll = null;
    };
  }, [selectAllRows]);

  useEffect(() => {
    if (!fullTextActive) rowHeightCacheRef.current.clear();
    rowVirtualizer.measure();
  }, [fullTextActive, gridTemplateColumns, columnPixelWidths, tableTextMetrics, rowVirtualizer]);

  useEffect(() => {
    draftCellValuesRef.current.clear();
    rowHeightCacheRef.current.clear();
    setDraftRowHeights({});
    rowVirtualizer.measure();
  }, [rows]);

  useEffect(() => {
    rowVirtualizer.measure();
  }, [draftRowHeights, rowVirtualizer]);

  useEffect(() => {
    const measureExpandedEditors = () => {
      window.setTimeout(() => rowVirtualizer.measure(), 0);
    };
    window.addEventListener("bgt:tableTextEditorToggled", measureExpandedEditors);
    return () => window.removeEventListener("bgt:tableTextEditorToggled", measureExpandedEditors);
  }, [rowVirtualizer]);

  useEffect(() => {
    if (!expandedTextRowId) return;
    const closeExpandedRow = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".popup-text-cell.expanded, .popup-text-preview")) return;
      setExpandedTextRowId(null);
      window.dispatchEvent(new Event("bgt:tableTextEditorToggled"));
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setExpandedTextRowId(null);
      window.dispatchEvent(new Event("bgt:tableTextEditorToggled"));
    };
    window.addEventListener("mousedown", closeExpandedRow);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeExpandedRow);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [expandedTextRowId]);

  useLayoutEffect(() => {
    const updateWidths = () => {
      const next: Record<string, number> = {};
      for (const column of visibleColumns) {
        const cell = headerCellRefs.current[column.key];
        if (cell) next[column.key] = cell.getBoundingClientRect().width;
      }
      setColumnPixelWidths((current) => {
        const currentKeys = Object.keys(current);
        const nextKeys = Object.keys(next);
        const same =
          currentKeys.length === nextKeys.length &&
          nextKeys.every((key) => Math.abs((current[key] ?? 0) - next[key]) < 0.5);
        return same ? current : next;
      });
    };
    updateWidths();
    const observer = new ResizeObserver(updateWidths);
    if (gridWrapRef.current) observer.observe(gridWrapRef.current);
    for (const column of visibleColumns) {
      const cell = headerCellRefs.current[column.key];
      if (cell) observer.observe(cell);
    }
    window.addEventListener("resize", updateWidths);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateWidths);
    };
  }, [visibleColumns, gridTemplateColumns]);

  useLayoutEffect(() => {
    const updateMetrics = () => setTableTextMetrics(getTableTextMetrics());
    updateMetrics();
    const observer = new MutationObserver(updateMetrics);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setPage(1);
    setPageInput("1");
    if (gridWrapRef.current) gridWrapRef.current.scrollTop = 0;
    rowVirtualizer.scrollToIndex(0);
  }, [query, filter, groupFilterValues, rows.length, shouldPaginate, pageSize]);

  useEffect(() => {
    setPageInput(String(safePage));
  }, [safePage]);

  useEffect(() => {
    localStorage.setItem(`${tableStorageKey}.paginationEnabled`, String(paginationEnabled));
  }, [tableStorageKey, paginationEnabled]);

  useEffect(() => {
    localStorage.setItem(`${tableStorageKey}.fullTextEnabled`, String(fullTextEnabled));
  }, [tableStorageKey, fullTextEnabled]);

  useEffect(() => {
    if (!canUseFullText && fullTextEnabled) setFullTextEnabled(false);
  }, [canUseFullText, fullTextEnabled]);

  useEffect(() => {
    const close = () => {
      setColumnMenuOpen(false);
    };
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
      const target = event.target;
      if (target instanceof HTMLElement && isTextInputTarget(target)) return;
      if (activeTableSelectAll !== selectAllRows) return;
      event.preventDefault();
      selectAllRows();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectAllRows]);

  useEffect(() => {
    setGroupFilterValues((current) => {
      const next = { ...current };
      let changed = false;
      for (const group of filterGroups) {
        if (next[group.label] && !group.options.some((option) => option.value === next[group.label])) {
          delete next[group.label];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [filterGroups]);

  const changeRows = (nextRows: T[]) => void onRowsChange?.(nextRows);
  const originalColumn = columns.find((column) => column.key === "original");
  const translationColumn = columns.find((column) => column.key === "translation");
  const ownContextSource = useMemo<DataContextSource<T> | undefined>(
    () =>
      originalColumn && translationColumn
        ? {
            rows,
            originalText: (row) => originalColumn.text(row as T),
            translationText: (row) => translationColumn.text(row as T),
            getStartId: (row) => row.id
          }
        : undefined,
    [originalColumn, translationColumn, rows]
  );
  const activeContextSource = contextSource ?? ownContextSource;
  const canViewContext = Boolean(activeContextSource);

  const deleteSelected = () => {
    if (!selectedIds.size || !onRowsChange) return;
    changeRows(rows.filter((row) => !selectedIds.has(row.id)));
    setSelectedIds(new Set());
  };

  const insertAfterSelection = () => {
    if (!createRow || !onRowsChange) return;
    const selectedIndexes = rows.map((row, index) => (selectedIds.has(row.id) ? index : -1)).filter((index) => index >= 0);
    const insertAt = selectedIndexes.length ? Math.max(...selectedIndexes) + 1 : rows.length;
    const nextRow = createRow();
    changeRows([...rows.slice(0, insertAt), nextRow, ...rows.slice(insertAt)]);
    setSelectedIds(new Set([nextRow.id]));
  };

  const appendRow = () => {
    if (!createRow || !onRowsChange) return;
    const nextRow = createRow();
    changeRows([...rows, nextRow]);
    setSelectedIds(new Set([nextRow.id]));
  };

  const submitPage = () => {
    const nextPage = Math.min(pageCount, Math.max(1, Number(pageInput) || 1));
    setPage(nextPage);
    setPageInput(String(nextPage));
  };

  const toggleColumn = (columnKey: string) => {
    setVisibleColumnKeys((current) => {
      const next = new Set(current);
      if (next.has(columnKey)) next.delete(columnKey);
      else next.add(columnKey);
      return next;
    });
  };

  const refreshFilteredRows = () => {
    setFrozenFilterResult({ key: filterCriteriaKey, ids: liveFilteredRows.map((row) => row.id) });
    setSelectedIds(new Set());
    setAnchorId(null);
    setPage(1);
    setPageInput("1");
    if (gridWrapRef.current) gridWrapRef.current.scrollTop = 0;
    rowVirtualizer.scrollToIndex(0);
  };

  const handleCellDraftChange = (row: T, column: DataColumn<T>, value: string) => {
    if (!fullTextActive) return;
    const key = draftCellKey(row, column);
    if (value === column.text(row)) draftCellValuesRef.current.delete(key);
    else draftCellValuesRef.current.set(key, value);
    rowHeightCacheRef.current.delete(row.id);
    setDraftRowHeights((current) => ({ ...current, [row.id]: getFullTextRowHeight(row) }));
  };
  const renderCell = (row: T, column: DataColumn<T>) =>
    column.render(row, {
      fullText: fullTextActive,
      rowExpanded: expandedTextRowId === row.id,
      onExpandRow: () => {
        setExpandedTextRowId(row.id);
        window.dispatchEvent(new Event("bgt:tableTextEditorToggled"));
      },
      onCollapseRow: () => {
        setExpandedTextRowId((current) => (current === row.id ? null : current));
        window.dispatchEvent(new Event("bgt:tableTextEditorToggled"));
      },
      onDraftChange: (value) => handleCellDraftChange(row, column, value)
    });
  const renderAppendRow = (virtualStyle?: React.CSSProperties) => (
    <div
      className={`data-grid-row append-row${virtualStyle ? " virtual" : ""}`}
      style={{ gridTemplateColumns, ...virtualStyle }}
      key="__append_row__"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={appendRow}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          appendRow();
        }
      }}
    >
      <div className="append-row-cell">
        <PlusCircle size={18} />
      </div>
    </div>
  );

  const openContextViewer = () => {
    if (!activeContextSource || !selectedIds.size) return;
    const selectedIndexes = filteredRows.map((row, index) => (selectedIds.has(row.id) ? index : -1)).filter((index) => index >= 0);
    const selectedRow = filteredRows[selectedIndexes.length ? Math.min(...selectedIndexes) : 0];
    const startId = selectedRow ? activeContextSource.getStartId(selectedRow) : null;
    if (!startId || !activeContextSource.rows.some((row) => row.id === startId)) return;
    setContextViewer({ startId });
  };

  const openOccurrenceViewer = (menuRows: T[]) => {
    if (!occurrenceSource || !menuRows.length) return;
    const terms = uniqueTerms(menuRows.flatMap((row) => occurrenceSource.getTerms(row)));
    if (!terms.length) return;
    const matchedRows = occurrenceSource.rows.filter((item) =>
      terms.some((term) => textContainsLocalizedTerm(item.original, term, occurrenceSource.sourceLanguage))
    );
    if (!matchedRows.length) {
      setOccurrenceViewer({ rows: [], selectedIds: new Set(), terms, sourceLanguage: occurrenceSource.sourceLanguage });
      return;
    }
    setOccurrenceViewer({ rows: matchedRows, selectedIds: new Set(), terms, sourceLanguage: occurrenceSource.sourceLanguage });
  };

  const openSourceViewer = async (menuRows: T[]) => {
    if (!sourceInfo) return;
    const infos = menuRows.map((row) => sourceInfo(row)).filter((info): info is DataSourceInfo => Boolean(info?.sourceFile));
    const first = infos[0];
    if (!first) return;
    setSourceViewerError("");
    try {
      const file = await window.bgt.readOriginalSourceFile(first.sourceFile);
      const sameFileInfos = infos.filter((info) => normalizeSourcePath(info.sourceFile) === normalizeSourcePath(file.sourceFile));
      const highlights = sameFileInfos
        .map((info) => resolveSourceHighlight(file.content, info))
        .filter((highlight): highlight is SourceHighlight => Boolean(highlight));
      const firstHighlight = highlights.find((highlight) => highlight.key === first.key) ?? highlights[0];
      setSourceViewer({ file, highlights, startOffset: firstHighlight?.start ?? 0 });
    } catch (error) {
      setSourceViewerError(error instanceof Error ? error.message : String(error));
    }
  };

  const wrapRowContextMenu = (row: T, rowElement: React.ReactElement) => {
    const menuRows = selectedIds.has(row.id) ? selectedRows : [row];
    const canViewSource = Boolean(sourceInfo && menuRows.some((entry) => sourceInfo(entry)?.sourceFile));
    const canViewOccurrences = Boolean(occurrenceSource && menuRows.some((entry) => uniqueTerms(occurrenceSource.getTerms(entry)).length));
    return (
      <RadixContextMenu.Root key={`menu:${row.id}`}>
        <RadixContextMenu.Trigger asChild>{rowElement}</RadixContextMenu.Trigger>
        <RadixContextMenu.Portal>
          <RadixContextMenu.Content className="row-context-menu" collisionPadding={8}>
            {onTranslateSelected ? (
              <RadixContextMenu.Item
                className="row-context-menu-item"
                disabled={!menuRows.length}
                onSelect={() => {
                  void onTranslateSelected(menuRows);
                }}
              >
                <Languages size={15} />
                翻译
              </RadixContextMenu.Item>
            ) : null}
            {onProofreadSelected ? (
              <RadixContextMenu.Item
                className="row-context-menu-item"
                disabled={!menuRows.length}
                onSelect={() => {
                  void onProofreadSelected(menuRows);
                }}
              >
                <Sparkles size={15} />
                AI 校对
              </RadixContextMenu.Item>
            ) : null}
            <RadixContextMenu.Item className="row-context-menu-item" disabled={!canViewContext || !menuRows.length} onSelect={openContextViewer}>
              <Eye size={15} />
              查看前后文
            </RadixContextMenu.Item>
            <RadixContextMenu.Item className="row-context-menu-item" disabled={!canViewSource} onSelect={() => { void openSourceViewer(menuRows); }}>
              <FileSearch size={15} />
              查看源文件位置
            </RadixContextMenu.Item>
            {occurrenceSource ? (
              <RadixContextMenu.Item className="row-context-menu-item" disabled={!canViewOccurrences} onSelect={() => openOccurrenceViewer(menuRows)}>
                <Search size={15} />
              查看出现行
              </RadixContextMenu.Item>
            ) : null}
            <RadixContextMenu.Item className="row-context-menu-item" disabled={!onRowsChange || !menuRows.length} onSelect={deleteSelected}>
              <Trash2 size={15} />
              删除
            </RadixContextMenu.Item>
            <RadixContextMenu.Item className="row-context-menu-item" onSelect={() => setSelectedIds(new Set(rows.map((sourceRow) => sourceRow.id)))}>
              <CheckSquare size={15} />
              选中所有行
            </RadixContextMenu.Item>
            <RadixContextMenu.Item className="row-context-menu-item" disabled={!createRow || !onRowsChange} onSelect={insertAfterSelection}>
              <Plus size={15} />
              在选中区域最下方插入新行
            </RadixContextMenu.Item>
          </RadixContextMenu.Content>
        </RadixContextMenu.Portal>
      </RadixContextMenu.Root>
    );
  };

  return (
    <div
      className={fullTextActive ? "data-table full-text" : "data-table"}
      ref={tableRootRef}
      onMouseDown={() => {
        activeTableSelectAll = selectAllRows;
      }}
      onMouseEnter={() => {
        activeTableSelectAll = selectAllRows;
      }}
    >
      <div className="data-table-toolbar">
        <div className="data-table-title">
          <RadixPopover.Root open={columnMenuOpen} onOpenChange={setColumnMenuOpen}>
            <RadixPopover.Trigger asChild>
              <button className="icon-button column-menu-button" aria-label="显示列">
                <Settings size={15} />
              </button>
            </RadixPopover.Trigger>
            <RadixPopover.Portal>
              <RadixPopover.Content className="column-menu-popover" align="start" sideOffset={6}>
                <strong>显示列</strong>
                {columns.map((column) => (
                  <label key={column.key}>
                    <CheckboxControl compact checked={visibleColumnKeys.has(column.key)} onChange={() => toggleColumn(column.key)} />
                    <span>{column.title}</span>
                  </label>
                ))}
              </RadixPopover.Content>
            </RadixPopover.Portal>
          </RadixPopover.Root>
          <AppTooltip content="重新应用搜索和筛选">
            <button className="icon-button column-menu-button" aria-label="重新应用搜索和筛选" onClick={refreshFilteredRows}>
              <RotateCcw size={15} />
            </button>
          </AppTooltip>
          <strong>{title}</strong>
          <span>{filteredRows.length} / {rows.length} 行</span>
          {selectedIds.size ? <span>已选 {selectedIds.size}</span> : null}
        </div>
        <div className="data-table-controls">
          <div className="search-box table-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前表格" />
          </div>
          {filters.length > 0 && (title === "校对问题" ? (
            <>
              <StyledSelect
                className="table-filter-select"
                value={filterValues.severity || "all"}
                options={[
                  { value: "all", label: "全部级别" },
                  ...filters.filter((entry) => entry.value.startsWith("severity:")).map((entry) => ({ value: entry.value, label: entry.label }))
                ]}
                onChange={(value) => setFilterValues((current) => ({ ...current, severity: value === "all" ? "" : value }))}
              />
              <StyledSelect
                className="table-filter-select"
                value={filterValues.status || "all"}
                options={[
                  { value: "all", label: "全部状态" },
                  ...filters.filter((entry) => entry.value.startsWith("status:")).map((entry) => ({ value: entry.value, label: entry.label }))
                ]}
                onChange={(value) => setFilterValues((current) => ({ ...current, status: value === "all" ? "" : value }))}
              />
              <StyledSelect
                className="table-rule-filter-select"
                value={filterValues.rule || "all"}
                options={[
                  { value: "all", label: "全部规则" },
                  ...filters.filter((entry) => entry.value.startsWith("rule:")).map((entry) => ({ value: entry.value, label: entry.label }))
                ]}
                onChange={(value) => setFilterValues((current) => ({ ...current, rule: value === "all" ? "" : value }))}
              />
            </>
          ) : (
            <StyledSelect
              className="table-filter-select"
              value={filter}
              options={[{ value: "all", label: "全部类型" }, ...filters.map((entry) => ({ value: entry.value, label: entry.label }))]}
              onChange={setFilter}
            />
          ))}
          {filterGroups.map((group) => {
            const currentValue = groupFilterValues[group.label] || "all";
            return (
              <CommandSelect
              key={group.label}
                value={currentValue}
                options={[{ id: "all", label: group.allLabel }, ...group.options.map((entry) => ({ id: entry.value, label: entry.label }))]}
                placeholder={group.allLabel}
                emptyText="没有筛选项"
                className={group.className}
                compact
                onChange={(value) => setGroupFilterValues((current) => ({ ...current, [group.label]: value === "all" ? "" : value }))}
              />
            );
          })}
          <label className="data-table-pagination-toggle" title={hasQuery && !tableSettings.searchPaginationEnabled ? "搜索结果分页在全局设置中关闭，当前搜索不会分页。" : "只影响当前表格。"}>
            <CheckboxControl checked={paginationEnabled} onChange={setPaginationEnabled} />
            <span>分页</span>
          </label>
          <label className="data-table-pagination-toggle" title="开启后，所有可见行完整显示文本，并在表格中原地编辑。未分页的大表会使用虚拟滚动。">
            <CheckboxControl checked={fullTextEnabled} onChange={setFullTextEnabled} />
            <span>完整文本</span>
          </label>
        </div>
      </div>
      <div className="data-grid-wrap" ref={gridWrapRef} onMouseLeave={() => setDragStartId(null)} onMouseUp={() => setDragStartId(null)}>
        <div className="data-grid-head" style={{ gridTemplateColumns }}>
          {visibleColumns.map((column) => (
            <span
              key={column.key}
              ref={(element) => {
                headerCellRefs.current[column.key] = element;
              }}
            >
              {column.title}
            </span>
          ))}
        </div>
        {virtualEnabled ? (
          <div className="data-grid-virtual-space" style={{ height: rowVirtualizer.getTotalSize() }}>
            {virtualItems.map((virtualRow) => {
              if (virtualRow.index >= visibleRows.length) {
                return renderAppendRow({
                  height: dataGridRowHeight,
                  transform: `translateY(${virtualRow.start}px)`
                });
              }
              const row = visibleRows[virtualRow.index];
              if (!row) return null;
              return wrapRowContextMenu(
                row,
                <div
                  className={`data-grid-row virtual${selectedIds.has(row.id) ? " selected" : ""}${expandedTextRowId === row.id ? " text-expanded" : ""}`}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    gridTemplateColumns,
                    transform: `translateY(${virtualRow.start}px)`,
                    ...(fullTextActive ? { height: draftRowHeights[row.id] ?? getFullTextRowHeight(row) } : {})
                  }}
                  key={row.id}
                  onMouseDown={(event) => handleRowMouseDown(event, row)}
                  onMouseEnter={() => handleRowMouseEnter(row)}
                  onContextMenu={(event) => handleContextMenu(event, row)}
                >
                  {visibleColumns.map((column) => (
                    <div key={column.key}>
                      {renderCell(row, column)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {visibleRows.map((row) => wrapRowContextMenu(
              row,
              <div
                className={`data-grid-row${selectedIds.has(row.id) ? " selected" : ""}${expandedTextRowId === row.id ? " text-expanded" : ""}`}
                style={{ gridTemplateColumns, ...(fullTextActive ? { height: draftRowHeights[row.id] ?? getFullTextRowHeight(row) } : {}) }}
                key={row.id}
                onMouseDown={(event) => handleRowMouseDown(event, row)}
                onMouseEnter={() => handleRowMouseEnter(row)}
                onContextMenu={(event) => handleContextMenu(event, row)}
              >
                {visibleColumns.map((column) => (
                  <div key={column.key}>
                    {renderCell(row, column)}
                  </div>
                ))}
              </div>
            ))}
            {showAppendRow ? renderAppendRow() : null}
          </>
        )}
        {!visibleRows.length && !showAppendRow && <p className="empty data-table-empty">{emptyText}</p>}
      </div>
      {shouldPaginate && (
        <div className="pagination-bar">
          <button disabled={safePage <= 1} onClick={() => setPage(1)}>首页</button>
          <button disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <div className="page-jump">
            <span>第</span>
            <input value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={submitPage} onKeyDown={(event) => event.key === "Enter" && submitPage()} />
            <span>/ {pageCount} 页</span>
          </div>
          <button disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</button>
          <button disabled={safePage >= pageCount} onClick={() => setPage(pageCount)}>末页</button>
          <span>每页最多 {pageSize} 行</span>
        </div>
      )}
      {contextViewer && activeContextSource && (
        <ContextViewerModal
          title={`${title} - 前后文`}
          rows={activeContextSource.rows}
          selectedIds={new Set(
            Array.from(selectedIds)
              .map((id) => rows.find((row) => row.id === id))
              .map((row) => (row ? activeContextSource.getStartId(row) : null))
              .filter((id): id is string => Boolean(id))
          )}
          startId={contextViewer.startId}
          originalText={activeContextSource.originalText}
          translationText={activeContextSource.translationText}
          metrics={tableTextMetrics}
          onClose={() => setContextViewer(null)}
        />
      )}
      {occurrenceViewer && (
        <ContextViewerModal
          title="出现行"
          rows={occurrenceViewer.rows}
          selectedIds={occurrenceViewer.selectedIds}
          startId={occurrenceViewer.rows[0]?.id ?? ""}
          originalText={(row) => (row as TextItem).original}
          translationText={(row) => (row as TextItem).translation}
          metrics={tableTextMetrics}
          emptyText="没有找到出现行"
          highlightTerms={occurrenceViewer.terms}
          highlightLanguage={occurrenceViewer.sourceLanguage}
          summary={`${occurrenceViewer.rows.length} 个出现行`}
          onClose={() => setOccurrenceViewer(null)}
        />
      )}
      {sourceViewer && (
        <Suspense fallback={null}>
          <SourceFileViewerModal
            state={sourceViewer}
            onClose={() => setSourceViewer(null)}
          />
        </Suspense>
      )}
      {sourceViewerError && (
        <AppDialog open title="无法打开源文件" className="compact-modal" onOpenChange={() => setSourceViewerError("")}>
          <div className="error-list">{sourceViewerError}</div>
        </AppDialog>
      )}
    </div>
  );
}

function isEditableTarget(target: EventTarget): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, button, .inline-expanded-editor, .context-viewer-modal"));
}

function isTextInputTarget(target: EventTarget): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true'], .inline-expanded-editor"));
}

function isColumnHiddenByDefault<T>(column: DataColumn<T>): boolean {
  return column.key === "sourceFile" || column.title === "文件";
}

function resolveSourceHighlight(content: string, info: DataSourceInfo): SourceHighlight | null {
  const range = parseRangeLocator(info.locator);
  const base = { key: info.key, original: info.original, translation: info.translation };
  if (range) return { ...base, start: clampOffset(range.start, content), end: clampOffset(range.end, content) };
  if (info.original) {
    const start = content.indexOf(info.original);
    if (start >= 0) return { ...base, start, end: start + info.original.length };
  }
  return null;
}

function parseRangeLocator(locator: string): { start: number; end: number } | null {
  const match = /^range:(\d+):(\d+):/.exec(locator);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function clampOffset(value: number, content: string): number {
  return Math.max(0, Math.min(content.length, value));
}

function normalizeSourcePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function uniqueTerms(values: Array<string | DataOccurrenceTerm>): DataOccurrenceTerm[] {
  const seen = new Set<string>();
  const terms: DataOccurrenceTerm[] = [];
  for (const value of values) {
    const term = typeof value === "string" ? { text: value } : value;
    const text = term.text.trim();
    if (!text) continue;
    const key = `${term.isRegex ? "regex" : "text"}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({ text, isRegex: term.isRegex });
  }
  return terms;
}

function textContainsLocalizedTerm(text: string, term: DataOccurrenceTerm, sourceLanguage?: string): boolean {
  return findLocalizedTermRanges(text, term, sourceLanguage).length > 0;
}

function findLocalizedTermRanges(text: string, term: DataOccurrenceTerm, sourceLanguage?: string): Array<{ start: number; end: number }> {
  if (!term.text) return [];
  if (term.isRegex) {
    try {
      const regex = new RegExp(term.text, "giu");
      return Array.from(text.matchAll(regex))
        .map((match) => ({ start: match.index ?? -1, end: (match.index ?? -1) + match[0].length }))
        .filter((range) => range.start >= 0 && range.end > range.start);
    } catch {
      return [];
    }
  }
  const ranges: Array<{ start: number; end: number }> = [];
  if (!shouldUseAlphabeticBoundary(term.text, sourceLanguage)) {
    const haystack = text.toLocaleLowerCase();
    const needle = term.text.toLocaleLowerCase();
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      ranges.push({ start: index, end: index + term.text.length });
      index = haystack.indexOf(needle, index + Math.max(1, needle.length));
    }
    return ranges;
  }
  const haystack = text.toLocaleLowerCase();
  const needle = term.text.toLocaleLowerCase();
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = text[index - 1] ?? "";
    const after = text[index + term.text.length] ?? "";
    if (!isUnicodeLetter(before) && !isUnicodeLetter(after)) ranges.push({ start: index, end: index + term.text.length });
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }
  return ranges;
}

function renderHighlightedOccurrenceText(text: string, terms: DataOccurrenceTerm[], sourceLanguage?: string): React.ReactNode {
  const ranges = mergeRanges(
    terms.flatMap((term) => findLocalizedTermRanges(text, term, sourceLanguage))
  );
  if (!ranges.length) return text;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <mark className="context-viewer-hit" key={`${range.start}:${range.end}:${index}`}>
        {text.slice(range.start, range.end)}
      </mark>
    );
    cursor = range.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
    } else {
      last.end = Math.max(last.end, range.end);
    }
  }
  return merged;
}

function shouldUseAlphabeticBoundary(term: string, sourceLanguage?: string): boolean {
  if (!hasUnicodeLetter(term) || hasCjkCharacter(term)) return false;
  const language = (sourceLanguage ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  if (!language) return true;
  return !new Set(["zh", "ja", "ko", "th", "lo", "km", "my"]).has(language);
}

function hasUnicodeLetter(value: string): boolean {
  return /\p{L}/u.test(value);
}

function isUnicodeLetter(value: string): boolean {
  return Boolean(value) && /\p{L}/u.test(value);
}

function hasCjkCharacter(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function ContextViewerModal({
  title,
  rows,
  selectedIds,
  startId,
  originalText,
  translationText,
  metrics,
  emptyText = "没有可显示的行",
  highlightTerms = [],
  highlightLanguage,
  summary,
  onClose
}: {
  title: string;
  rows: DataContextRow[];
  selectedIds: Set<string>;
  startId: string;
  originalText: (row: DataContextRow) => string;
  translationText: (row: DataContextRow) => string;
  metrics: TableTextMetrics;
  emptyText?: string;
  highlightTerms?: DataOccurrenceTerm[];
  highlightLanguage?: string;
  summary?: string;
  onClose: () => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const rowHeightCacheRef = React.useRef(new Map<string, { signature: string; height: number }>());
  const [viewportWidth, setViewportWidth] = useState(960);
  const startIndex = Math.max(0, rows.findIndex((row) => row.id === startId));
  const textWidth = Math.max(180, (viewportWidth - 82) / 2 - dataGridCellHorizontalPadding);
  const getRowHeight = useCallback(
    (row: DataContextRow) => {
      const originalValue = originalText(row);
      const translationValue = translationText(row);
      const signature = `${metrics.font}\u001f${metrics.lineHeight}\u001f${Math.round(textWidth)}\u001f${originalValue}\u001f${translationValue}`;
      const cached = rowHeightCacheRef.current.get(row.id);
      if (cached?.signature === signature) return cached.height;
      const height = Math.max(
        dataGridRowHeight,
        estimateFullTextHeight(originalValue, textWidth, metrics) + dataGridCellVerticalPadding,
        estimateFullTextHeight(translationValue, textWidth, metrics) + dataGridCellVerticalPadding
      );
      rowHeightCacheRef.current.set(row.id, { signature, height });
      return height;
    },
    [originalText, translationText, textWidth, metrics]
  );
  const estimateRowHeight = useCallback(
    (row: DataContextRow) => {
      const cached = rowHeightCacheRef.current.get(row.id);
      if (cached) return cached.height;
      return Math.max(
        dataGridRowHeight,
        estimateFullTextHeightCheap(originalText(row), textWidth, metrics) + dataGridCellVerticalPadding,
        estimateFullTextHeightCheap(translationText(row), textWidth, metrics) + dataGridCellVerticalPadding
      );
    },
    [originalText, translationText, textWidth, metrics]
  );
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row ? estimateRowHeight(row) : dataGridRowHeight;
    },
    overscan: dataGridOverscan
  });
  const scrollHeight = rows.length
    ? Math.min(Math.max(rowVirtualizer.getTotalSize(), dataGridRowHeight), Math.max(220, window.innerHeight - 260))
    : 120;
  const scrollToStartIndex = useCallback(() => {
    if (!rows.length) return;
    rowVirtualizer.scrollToIndex(startIndex, { align: "start" });
  }, [rowVirtualizer, rows.length, startIndex]);

  useLayoutEffect(() => {
    const updateWidth = () => {
      if (scrollRef.current) setViewportWidth(scrollRef.current.getBoundingClientRect().width);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    rowHeightCacheRef.current.clear();
    rowVirtualizer.measure();
    const frame = window.requestAnimationFrame(scrollToStartIndex);
    return () => window.cancelAnimationFrame(frame);
  }, [textWidth, rowVirtualizer, scrollToStartIndex]);

  useLayoutEffect(() => {
    scrollToStartIndex();
    const frame = window.requestAnimationFrame(() => {
      scrollToStartIndex();
      window.requestAnimationFrame(scrollToStartIndex);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollHeight, scrollToStartIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <AppDialog open title={title} className="context-viewer-modal" onOpenChange={(open) => { if (!open) onClose(); }}>
        <div className="context-viewer-header">
          <div>
            <p>{summary ?? `${rows.length} 行，已跳转到选中区域开头`}</p>
          </div>
        </div>
        <div className="context-viewer-grid-head">
          <span>ID</span>
          <span>原文</span>
          <span>译文</span>
        </div>
        <div className="context-viewer-scroll" ref={scrollRef} style={{ height: scrollHeight }}>
          {rows.length ? (
            <div className="context-viewer-virtual-space" style={{ height: rowVirtualizer.getTotalSize() }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (!row) return null;
                const height = getRowHeight(row);
                return (
                  <div
                    key={row.id}
                    className={selectedIds.has(row.id) ? "context-viewer-row selected" : "context-viewer-row"}
                    style={{ height, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <span>{row.id || virtualRow.index + 1}</span>
                    <div>{highlightTerms.length ? renderHighlightedOccurrenceText(originalText(row), highlightTerms, highlightLanguage) : originalText(row)}</div>
                    <div>{translationText(row)}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="empty context-viewer-empty">{emptyText}</p>
          )}
        </div>
    </AppDialog>
  );
}

function PopupTextEditor({
  value,
  onChange,
  readOnly = false,
  placeholder = "",
  expanded = false,
  onExpand,
  onCollapse
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  expanded?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const draftRef = React.useRef(draft);
  const valueRef = React.useRef(value);
  const onChangeRef = React.useRef(onChange);
  const expandedRef = React.useRef(expanded);
  const discardCloseRef = React.useRef(false);
  const previewValue = value.replace(/\s+/g, " ").trim();
  draftRef.current = draft;
  valueRef.current = value;
  onChangeRef.current = onChange;

  const commitDraft = () => {
    if (!readOnly && draftRef.current !== valueRef.current) onChangeRef.current?.(draftRef.current);
  };

  const closeEditor = (commit: boolean) => {
    discardCloseRef.current = !commit;
    if (!commit) setDraft(valueRef.current);
    if (commit) commitDraft();
    onCollapse?.();
    window.dispatchEvent(new Event("bgt:tableTextEditorToggled"));
  };

  useEffect(() => {
    if (expanded && !expandedRef.current) {
      setDraft(value);
      discardCloseRef.current = false;
    }
    if (!expanded && expandedRef.current) {
      if (discardCloseRef.current) {
        setDraft(valueRef.current);
        discardCloseRef.current = false;
      } else if (!readOnly && draftRef.current !== valueRef.current) {
        onChangeRef.current?.(draftRef.current);
      }
    }
    expandedRef.current = expanded;
  }, [expanded, readOnly, value]);

  useEffect(() => {
    if (!expanded) setDraft(value);
  }, [value, expanded]);

  return (
    <div className={expanded ? "popup-text-cell expanded" : "popup-text-cell"} ref={rootRef} onMouseDown={(event) => event.stopPropagation()}>
      {!expanded ? (
        <input
          className="popup-text-preview"
          readOnly
          value={previewValue}
          placeholder={placeholder}
          title={value}
          onFocus={onExpand}
          onClick={onExpand}
        />
      ) : (
        <div className={readOnly ? "inline-expanded-editor readonly" : "inline-expanded-editor editable"}>
          <textarea
            readOnly={readOnly}
            value={readOnly ? value : draft}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeEditor(false);
              }
            }}
            onBlur={commitDraft}
          />
        </div>
      )}
    </div>
  );
}

function AutoResizeTextarea({
  value,
  onChange,
  onDraftChange,
  readOnly = false,
  placeholder = ""
}: {
  value: string;
  onChange?: (value: string) => void;
  onDraftChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const draftRef = React.useRef(draft);
  const valueRef = React.useRef(value);
  const focusedRef = React.useRef(focused);
  const onChangeRef = React.useRef(onChange);

  draftRef.current = draft;
  valueRef.current = value;
  focusedRef.current = focused;
  onChangeRef.current = onChange;

  const commitDraft = useCallback(() => {
    if (readOnly) return;
    const next = draftRef.current;
    if (next !== valueRef.current) onChangeRef.current?.(next);
  }, [readOnly]);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    return () => {
      if (focusedRef.current) commitDraft();
    };
  }, [commitDraft]);

  return (
    <textarea
      className="inline-table-textarea"
      readOnly={readOnly}
      value={readOnly ? value : draft}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        setDraft(event.target.value);
        if (!readOnly) onDraftChange?.(event.target.value);
      }}
      onBlur={() => {
        commitDraft();
        setFocused(false);
      }}
    />
  );
}

export function TextTable({
  items,
  enableFileFilter = false,
  tableSettings,
  onChange,
  onBulkChange,
  onTranslateItems
}: {
  items: TextItem[];
  enableFileFilter?: boolean;
  tableSettings: TableSettings;
  onChange: (item: TextItem) => void;
  onBulkChange: (items: TextItem[]) => void | Promise<void>;
  onTranslateItems?: (items: TextItem[]) => void | Promise<void>;
}) {
  const updateItem = (changed: TextItem) => {
    onChange(changed);
  };
  const fileFilterGroups = useMemo<Array<DataFilterGroup<TextItem>>>(
    () =>
      enableFileFilter
        ? [
            {
              label: "文件",
              allLabel: "全部文件",
              className: "file-filter-select",
              options: Array.from(new Set(items.map((item) => item.sourceFile || "(无文件)")))
                .sort((a, b) => a.localeCompare(b))
                .map((file) => ({
                  label: file,
                  value: file,
                  predicate: (row: TextItem) => (row.sourceFile || "(无文件)") === file
                }))
            }
          ]
        : [],
    [enableFileFilter, items]
  );
  const createTextItem = (): TextItem => ({
    id: `txt_${Date.now()}`,
    sourceFile: "",
    locator: "",
    original: "",
    translation: "",
    status: "extracted",
    context: {}
  });
  return (
    <DataTable
      title="文本表"
      rows={items}
      tableSettings={tableSettings}
      filterGroups={fileFilterGroups}
      sourceInfo={(row) => ({
        key: row.id,
        sourceFile: row.sourceFile,
        locator: row.locator,
        original: row.original,
        translation: row.translation
      })}
      onRowsChange={onBulkChange}
      createRow={createTextItem}
      onTranslateSelected={onTranslateItems}
      filters={[
        { label: "未翻译", value: "extracted", predicate: (row) => row.status === "extracted" },
        { label: "已翻译", value: "translated", predicate: (row) => row.status === "translated" },
        { label: "失败", value: "failed", predicate: (row) => row.status === "failed" },
        { label: "需复核", value: "needs_review", predicate: (row) => row.status === "needs_review" },
        { label: "已排除", value: "excluded", predicate: (row) => row.status === "excluded" }
      ]}
      columns={[
        { key: "id", title: "ID", width: "110px", text: (row) => row.id, render: (row) => row.id },
        { key: "sourceFile", title: "文件", width: "180px", text: (row) => row.sourceFile, render: (row) => row.sourceFile },
        {
          key: "original",
          title: "原文",
          width: "minmax(260px, 1fr)",
          text: (row) => row.original,
          render: (row, context) => context.fullText ? <AutoResizeTextarea readOnly value={row.original} /> : <PopupTextEditor value={row.original} readOnly expanded={context.rowExpanded} onExpand={context.onExpandRow} onCollapse={context.onCollapseRow} />
        },
        {
          key: "translation",
          title: "译文",
          width: "minmax(260px, 1fr)",
          text: (row) => row.translation,
          render: (row, context) =>
            context.fullText ? (
              <AutoResizeTextarea
                value={row.translation}
                placeholder="填写译文"
                onDraftChange={context.onDraftChange}
                onChange={(value) => updateItem({ ...row, translation: value, status: value ? "translated" : "extracted" })}
              />
            ) : (
              <PopupTextEditor
                value={row.translation}
                placeholder="填写译文"
                expanded={context.rowExpanded}
                onExpand={context.onExpandRow}
                onCollapse={context.onCollapseRow}
                onChange={(value) => updateItem({ ...row, translation: value, status: value ? "translated" : "extracted" })}
              />
            )
        },
        {
          key: "status",
          title: "状态",
          width: "130px",
          text: (row) => row.status,
          render: (row) => (
            <StyledSelect
              className="table-cell-select"
              value={row.status}
              options={[
                { value: "extracted", label: "未翻译" },
                { value: "translated", label: "已翻译" },
                { value: "failed", label: "失败" },
                { value: "needs_review", label: "需复核" },
                { value: "excluded", label: "已排除" }
              ]}
              onChange={(value) => updateItem({ ...row, status: value as TextItem["status"] })}
            />
          )
        }
      ]}
    />
  );
}

export function IssueTable({ issues, items, tableSettings, onProofreadIssues }: { issues: AppStateSnapshot["issues"]; items: TextItem[]; tableSettings: TableSettings; onProofreadIssues?: (issues: AppStateSnapshot["issues"]) => void | Promise<void> }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ruleFilters = useMemo(
    () =>
      Array.from(new Set(issues.map((issue) => issue.rule)))
        .sort((a, b) => ruleLabel(a).localeCompare(ruleLabel(b)))
        .map((rule) => ({ label: ruleLabel(rule), value: `rule:${rule}`, predicate: (row: AppStateSnapshot["issues"][number]) => row.rule === rule })),
    [issues]
  );
  const contextSource = useMemo<DataContextSource<AppStateSnapshot["issues"][number]>>(
    () => ({
      rows: items,
      originalText: (row) => (row as TextItem).original,
      translationText: (row) => (row as TextItem).translation,
      getStartId: (row) => row.textItemId
    }),
    [items]
  );
  return (
    <DataTable
      title="校对问题"
      rows={issues}
      tableSettings={tableSettings}
      contextSource={contextSource}
      sourceInfo={(row) => {
        const item = byId.get(row.textItemId);
        return item ? { key: item.id, sourceFile: item.sourceFile, locator: item.locator, original: item.original, translation: item.translation } : null;
      }}
      onProofreadSelected={onProofreadIssues}
      filters={[
        { label: "错误", value: "severity:error", predicate: (row) => row.severity === "error" },
        { label: "警告", value: "severity:warning", predicate: (row) => row.severity === "warning" },
        { label: "提示", value: "severity:info", predicate: (row) => row.severity === "info" },
        { label: "未处理", value: "status:open", predicate: (row) => row.status === "open" },
        { label: "已修复", value: "status:fixed", predicate: (row) => row.status === "fixed" },
        { label: "已忽略", value: "status:ignored", predicate: (row) => row.status === "ignored" },
        ...ruleFilters
      ]}
      columns={[
        { key: "textItemId", title: "文本 ID", width: "120px", text: (row) => row.textItemId, render: (row) => row.textItemId },
        { key: "rule", title: "规则", width: "150px", text: (row) => ruleLabel(row.rule), render: (row) => ruleLabel(row.rule) },
        { key: "severity", title: "级别", width: "90px", text: (row) => severityLabel(row.severity), render: (row) => severityLabel(row.severity) },
        { key: "status", title: "状态", width: "90px", text: (row) => issueStatusLabel(row.status), render: (row) => issueStatusLabel(row.status) },
        {
          key: "message",
          title: "消息",
          text: (row) => row.message,
          render: (row, context) => context.fullText ? <div className="inline-table-text">{row.message}</div> : <PopupTextEditor value={row.message} readOnly expanded={context.rowExpanded} onExpand={context.onExpandRow} onCollapse={context.onCollapseRow} />
        },
        {
          key: "original",
          title: "原文",
          text: (row) => byId.get(row.textItemId)?.original ?? "",
          render: (row, context) => {
            const value = byId.get(row.textItemId)?.original ?? "";
            return context.fullText ? <div className="inline-table-text">{value}</div> : <PopupTextEditor value={value} readOnly expanded={context.rowExpanded} onExpand={context.onExpandRow} onCollapse={context.onCollapseRow} />;
          }
        },
        {
          key: "translation",
          title: "译文",
          text: (row) => byId.get(row.textItemId)?.translation ?? "",
          render: (row, context) => {
            const value = byId.get(row.textItemId)?.translation ?? "";
            return context.fullText ? <div className="inline-table-text">{value}</div> : <PopupTextEditor value={value} readOnly expanded={context.rowExpanded} onExpand={context.onExpandRow} onCollapse={context.onCollapseRow} />;
          }
        }
      ]}
    />
  );
}

export function EditableResourceSections({
  analysis,
  rowCounts,
  textItems,
  sourceLanguage,
  provider,
  tableSettings,
  activeTable,
  onActiveTableChange,
  tableControls,
  onChange,
  onTranslated
}: {
  analysis: AnalysisResult;
  rowCounts?: Partial<Record<ResourceTableId, number>>;
  textItems: TextItem[];
  sourceLanguage?: string;
  provider?: ProviderConfig;
  tableSettings: TableSettings;
  activeTable?: ResourceTableId;
  onActiveTableChange?: (table: ResourceTableId) => void;
  tableControls?: React.ReactNode;
  onChange: (analysis: AnalysisResult) => void;
  onTranslated: (analysis: AnalysisResult) => void;
}) {
  const [localTable, setLocalTable] = useState<ResourceTableId>("characters");
  const table = activeTable ?? localTable;
  const effectiveRowCounts = {
    characters: rowCounts?.characters ?? analysis.characters.length,
    glossary: rowCounts?.glossary ?? analysis.glossary.length,
    noTranslate: rowCounts?.noTranslate ?? analysis.noTranslate.length
  };
  const changeTable = (value: ResourceTableId) => {
    setLocalTable(value);
    onActiveTableChange?.(value);
  };
  const translateRows = provider
    ? async (targetTable: "characters" | "glossary", rows: Array<CharacterEntry | GlossaryEntry>) => {
        const translated = await window.bgt.translateAnalysisRows(provider, { table: targetTable, ids: rows.map((row) => row.id) });
        onTranslated(translated);
      }
    : undefined;
  return (
    <div className="table-layout-with-tabs">
      <RadixTabs.Root value={table} onValueChange={(value) => changeTable(value as ResourceTableId)}>
        <RadixTabs.List className="table-tabs">
          <RadixTabs.Trigger value="characters" className={table === "characters" ? "active" : ""}>人物 <span>{effectiveRowCounts.characters}</span></RadixTabs.Trigger>
          <RadixTabs.Trigger value="glossary" className={table === "glossary" ? "active" : ""}>术语 <span>{effectiveRowCounts.glossary}</span></RadixTabs.Trigger>
          <RadixTabs.Trigger value="noTranslate" className={table === "noTranslate" ? "active" : ""}>禁翻 <span>{effectiveRowCounts.noTranslate}</span></RadixTabs.Trigger>
        </RadixTabs.List>
      </RadixTabs.Root>
      {tableControls}
      <div className="table-main">
        {table === "characters" && <CharacterResourceTable rows={analysis.characters} textItems={textItems} sourceLanguage={sourceLanguage} tableSettings={tableSettings} onChange={(characters) => onChange({ ...analysis, characters })} onTranslateRows={translateRows ? (rows) => translateRows("characters", rows) : undefined} />}
        {table === "glossary" && <GlossaryResourceTable rows={analysis.glossary} textItems={textItems} sourceLanguage={sourceLanguage} tableSettings={tableSettings} onChange={(glossary) => onChange({ ...analysis, glossary })} onTranslateRows={translateRows ? (rows) => translateRows("glossary", rows) : undefined} />}
        {table === "noTranslate" && <NoTranslateResourceTable rows={analysis.noTranslate} textItems={textItems} sourceLanguage={sourceLanguage} tableSettings={tableSettings} onChange={(noTranslate) => onChange({ ...analysis, noTranslate })} />}
      </div>
    </div>
  );
}

export function CharacterResourceTable({ rows, textItems, sourceLanguage, tableSettings, onChange, onTranslateRows, readOnly = false }: { rows: CharacterEntry[]; textItems: TextItem[]; sourceLanguage?: string; tableSettings: TableSettings; onChange: (rows: CharacterEntry[]) => void; onTranslateRows?: (rows: CharacterEntry[]) => void | Promise<void>; readOnly?: boolean }) {
  const update = (row: CharacterEntry, patch: Partial<CharacterEntry>) => {
    if (!readOnly) onChange(updateRow(rows, row.id, patch));
  };
  return (
    <DataTable
      title="人物"
      rows={rows}
      tableSettings={tableSettings}
      occurrenceSource={{
        rows: textItems,
        sourceLanguage,
        getTerms: (row) => [row.source, row.familyName ?? "", row.givenName ?? ""]
      }}
      onRowsChange={readOnly ? undefined : onChange}
      onTranslateSelected={readOnly ? undefined : onTranslateRows}
      createRow={readOnly ? undefined : () => ({ id: `char_${Date.now()}`, source: "", target: "", familyName: "", familyNameTranslation: "", givenName: "", givenNameTranslation: "", nicknameOf: "", note: "", enabled: true })}
      filters={[
        { label: "启用", value: "enabled", predicate: (row) => row.enabled },
        { label: "关闭", value: "disabled", predicate: (row) => !row.enabled },
        { label: "未译", value: "missing", predicate: (row) => !row.target.trim() }
      ]}
      columns={[
        { key: "enabled", title: "启用", width: "64px", text: (row) => String(row.enabled), render: (row) => <ToggleSwitch checked={row.enabled} onChange={(enabled) => update(row, { enabled })} title="启用" disabled={readOnly} /> },
        { key: "source", title: "原名", width: "150px", text: (row) => row.source, render: (row) => <ResourceTextInput value={row.source} onCommit={(source) => update(row, { source })} readOnly={readOnly} /> },
        { key: "target", title: "译名", width: "150px", text: (row) => row.target, render: (row) => <ResourceTextInput value={row.target} onCommit={(target) => update(row, { target })} readOnly={readOnly} /> },
        { key: "family", title: "姓/姓译", width: "170px", text: (row) => `${row.familyName ?? ""} ${row.familyNameTranslation ?? ""}`, render: (row) => <div className="stacked-inputs"><ResourceTextInput value={row.familyName ?? ""} onCommit={(familyName) => update(row, { familyName })} readOnly={readOnly} /><ResourceTextInput value={row.familyNameTranslation ?? ""} onCommit={(familyNameTranslation) => update(row, { familyNameTranslation })} readOnly={readOnly} /></div> },
        { key: "given", title: "名/名译", width: "170px", text: (row) => `${row.givenName ?? ""} ${row.givenNameTranslation ?? ""}`, render: (row) => <div className="stacked-inputs"><ResourceTextInput value={row.givenName ?? ""} onCommit={(givenName) => update(row, { givenName })} readOnly={readOnly} /><ResourceTextInput value={row.givenNameTranslation ?? ""} onCommit={(givenNameTranslation) => update(row, { givenNameTranslation })} readOnly={readOnly} /></div> },
        { key: "note", title: "备注", text: (row) => row.note, render: (row) => <ResourceTextInput value={row.note} onCommit={(note) => update(row, { note })} readOnly={readOnly} /> },
        { key: "nicknameOf", title: "本名角色", width: "150px", text: (row) => row.nicknameOf ?? "", render: (row) => <ResourceTextInput value={row.nicknameOf ?? ""} onCommit={(nicknameOf) => update(row, { nicknameOf })} readOnly={readOnly} /> }
      ]}
    />
  );
}

export function GlossaryResourceTable({ rows, textItems, sourceLanguage, tableSettings, onChange, onTranslateRows, readOnly = false }: { rows: GlossaryEntry[]; textItems: TextItem[]; sourceLanguage?: string; tableSettings: TableSettings; onChange: (rows: GlossaryEntry[]) => void; onTranslateRows?: (rows: GlossaryEntry[]) => void | Promise<void>; readOnly?: boolean }) {
  const update = (row: GlossaryEntry, patch: Partial<GlossaryEntry>) => {
    if (!readOnly) onChange(updateRow(rows, row.id, patch));
  };
  return (
    <DataTable
      title="术语"
      rows={rows}
      tableSettings={tableSettings}
      occurrenceSource={{
        rows: textItems,
        sourceLanguage,
        getTerms: (row) => [{ text: row.source, isRegex: row.isRegex }]
      }}
      onRowsChange={readOnly ? undefined : onChange}
      onTranslateSelected={readOnly ? undefined : onTranslateRows}
      createRow={readOnly ? undefined : () => ({ id: `term_${Date.now()}`, source: "", target: "", note: "", category: "术语", isRegex: false, enabled: true })}
      filters={[
        { label: "启用", value: "enabled", predicate: (row) => row.enabled },
        { label: "关闭", value: "disabled", predicate: (row) => !row.enabled },
        { label: "正则", value: "regex", predicate: (row) => row.isRegex },
        { label: "未译", value: "missing", predicate: (row) => !row.target.trim() }
      ]}
      columns={[
        { key: "enabled", title: "启用", width: "64px", text: (row) => String(row.enabled), render: (row) => <ToggleSwitch checked={row.enabled} onChange={(enabled) => update(row, { enabled })} title="启用" disabled={readOnly} /> },
        { key: "source", title: "原文", width: "180px", text: (row) => row.source, render: (row) => <ResourceTextInput value={row.source} onCommit={(source) => update(row, { source })} readOnly={readOnly} /> },
        { key: "target", title: "译文", width: "180px", text: (row) => row.target, render: (row) => <ResourceTextInput value={row.target} onCommit={(target) => update(row, { target })} readOnly={readOnly} /> },
        { key: "category", title: "分类", width: "120px", text: (row) => row.category, render: (row) => <ResourceTextInput value={row.category} onCommit={(category) => update(row, { category })} readOnly={readOnly} /> },
        { key: "isRegex", title: "正则", width: "64px", text: (row) => String(row.isRegex), render: (row) => <ToggleSwitch checked={row.isRegex} onChange={(isRegex) => update(row, { isRegex })} title="正则" disabled={readOnly} /> },
        { key: "note", title: "备注", text: (row) => row.note, render: (row) => <ResourceTextInput value={row.note} onCommit={(note) => update(row, { note })} readOnly={readOnly} /> }
      ]}
    />
  );
}

export function NoTranslateResourceTable({ rows, textItems, sourceLanguage, tableSettings, onChange, readOnly = false }: { rows: NoTranslateEntry[]; textItems: TextItem[]; sourceLanguage?: string; tableSettings: TableSettings; onChange: (rows: NoTranslateEntry[]) => void; readOnly?: boolean }) {
  const update = (row: NoTranslateEntry, patch: Partial<NoTranslateEntry>) => {
    if (!readOnly) onChange(updateRow(rows, row.id, patch));
  };
  return (
    <DataTable
      title="禁翻"
      rows={rows}
      tableSettings={tableSettings}
      occurrenceSource={{
        rows: textItems,
        sourceLanguage,
        getTerms: (row) => [{ text: row.marker, isRegex: row.isRegex }]
      }}
      onRowsChange={readOnly ? undefined : onChange}
      createRow={readOnly ? undefined : () => ({ id: `nt_${Date.now()}`, marker: "", note: "", isRegex: false, enabled: true })}
      filters={[
        { label: "启用", value: "enabled", predicate: (row) => row.enabled },
        { label: "关闭", value: "disabled", predicate: (row) => !row.enabled },
        { label: "正则", value: "regex", predicate: (row) => row.isRegex }
      ]}
      columns={[
        { key: "enabled", title: "启用", width: "64px", text: (row) => String(row.enabled), render: (row) => <ToggleSwitch checked={row.enabled} onChange={(enabled) => update(row, { enabled })} title="启用" disabled={readOnly} /> },
        { key: "marker", title: "标记", width: "240px", text: (row) => row.marker, render: (row) => <ResourceTextInput value={row.marker} onCommit={(marker) => update(row, { marker })} readOnly={readOnly} /> },
        { key: "isRegex", title: "正则", width: "64px", text: (row) => String(row.isRegex), render: (row) => <ToggleSwitch checked={row.isRegex} onChange={(isRegex) => update(row, { isRegex })} title="正则" disabled={readOnly} /> },
        { key: "note", title: "备注", text: (row) => row.note, render: (row) => <ResourceTextInput value={row.note} onCommit={(note) => update(row, { note })} readOnly={readOnly} /> }
      ]}
    />
  );
}

function updateRow<T extends { id: string }>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

function ResourceTextInput({ value, onCommit, readOnly = false }: { value: string; onCommit: (value: string) => void; readOnly?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (readOnly) return;
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      value={draft}
      readOnly={readOnly}
      onBlur={commit}
      onChange={(event) => {
        if (!readOnly) setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function severityLabel(value: AppStateSnapshot["issues"][number]["severity"]): string {
  return {
    error: "错误",
    warning: "警告",
    info: "提示"
  }[value];
}

function issueStatusLabel(value: AppStateSnapshot["issues"][number]["status"]): string {
  return {
    open: "未处理",
    fixed: "已修复",
    ignored: "已忽略"
  }[value];
}



