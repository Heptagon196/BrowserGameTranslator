import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { autoUpdate, flip, offset, shift, size, useFloating } from "@floating-ui/react";
import { ChevronDown, Search } from "lucide-react";

type FontOption = {
  label: string;
  value: string;
  group: "recommended" | "system" | "current" | "default";
};

export type CommandSelectOption = {
  id: string;
  label: string;
  description?: string;
};

type FloatingSelectPlacement = "top" | "bottom";

const recommendedFontFamilies = ["Microsoft YaHei", "SimSun", "Noto Sans SC", "Segoe UI", "Arial", "Consolas", "Courier New"];
const fontPreviewText = "中文 English 12345 あいうえお";
const floatingSelectMargin = 8;
const floatingSelectGap = 6;

function useSelectFloating(open: boolean, preferredListHeight: number, minWidth = 280) {
  const floating = useFloating({
    open,
    placement: "bottom-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(floatingSelectGap),
      flip({ padding: floatingSelectMargin }),
      shift({ padding: floatingSelectMargin }),
      size({
        padding: floatingSelectMargin,
        apply({ availableHeight, rects, elements }) {
          const searchHeight = 48;
          const popoverChromeHeight = searchHeight + 14;
          const listHeight = Math.max(64, Math.min(preferredListHeight, availableHeight - popoverChromeHeight));
          Object.assign(elements.floating.style, {
            width: `${Math.max(rects.reference.width, minWidth)}px`,
            "--select-list-max-height": `${listHeight}px`
          });
        }
      })
    ]
  });
  const placement: FloatingSelectPlacement = floating.placement.startsWith("top") ? "top" : "bottom";
  return { ...floating, placement };
}

export function CommandSelect({
  value,
  options,
  placeholder,
  emptyText,
  className,
  compact = false,
  disabled = false,
  onChange
}: {
  value: string;
  options: CommandSelectOption[];
  placeholder: string;
  emptyText: string;
  className?: string;
  compact?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { refs, floatingStyles, placement } = useSelectFloating(open, 280, compact ? 280 : 320);
  const selectedOption = options.find((option) => option.id === value);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);
  const pick = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  };
  const rootClassName = ["command-select", compact ? "compact" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={rootClassName} ref={rootRef}>
      <button type="button" className="command-select-trigger" data-state={open ? "open" : "closed"} disabled={disabled} ref={refs.setReference} onClick={() => setOpen((current) => !current)}>
        <span>{selectedOption?.label ?? placeholder}</span>
        <ChevronDown className="select-trigger-chevron" size={17} strokeWidth={2.4} />
      </button>
      {open && !disabled && (
        <div className={`command-select-popover ${placement === "top" ? "placement-top" : "placement-bottom"}`} ref={refs.setFloating} style={floatingStyles}>
          <Command className={`command-select-command ${placement === "top" ? "placement-top" : "placement-bottom"}`} label={placeholder} loop>
            <div className="command-select-search">
              <Search size={15} />
              <Command.Input ref={inputRef} placeholder="搜索..." />
            </div>
            <Command.List className="command-select-list">
              <Command.Empty>
                <div className="command-select-empty">{emptyText}</div>
              </Command.Empty>
              {options.map((option) => (
                <Command.Item
                  key={option.id}
                  value={`${option.label} ${option.description ?? ""} ${option.id}`}
                  onSelect={() => pick(option.id)}
                  className="command-select-item"
                >
                  <span className={option.id === value ? "command-select-check active" : "command-select-check"}>{option.id === value ? "✓" : ""}</span>
                  <span>
                    <strong>{option.label}</strong>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </div>
      )}
    </div>
  );
}

export function FontSelect({
  value,
  defaultValue,
  fonts,
  fontLoadError,
  onChange
}: {
  value: string;
  defaultValue: string;
  fonts: string[];
  fontLoadError: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const normalizedValue = value.trim() || defaultValue;
  const currentLabel = fontDisplayName(normalizedValue, defaultValue);
  const options = useMemo(() => buildFontOptions(fonts, normalizedValue, defaultValue), [fonts, normalizedValue, defaultValue]);
  const { refs, floatingStyles, placement } = useSelectFloating(open, 320, 320);
  const recommendedOptions = options.filter((option) => option.group === "recommended" || option.group === "default" || option.group === "current");
  const systemOptions = options.filter((option) => option.group === "system");
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);
  const pickFont = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  };
  return (
    <div className="font-select" ref={rootRef}>
      <button type="button" className="font-select-trigger" data-state={open ? "open" : "closed"} ref={refs.setReference} onClick={() => setOpen((current) => !current)}>
        <span className="font-select-main">
          <span className="font-select-title">{currentLabel}</span>
          <ChevronDown className="select-trigger-chevron" size={17} strokeWidth={2.4} />
        </span>
        <span className="font-select-preview" style={{ fontFamily: normalizedValue }}>{fontPreviewText}</span>
      </button>
      {open && (
        <div className={`font-select-popover ${placement === "top" ? "placement-top" : "placement-bottom"}`} ref={refs.setFloating} style={floatingStyles}>
          <Command className={`font-select-command ${placement === "top" ? "placement-top" : "placement-bottom"}`} label="选择字体" loop>
            <div className="font-select-search">
              <Search size={15} />
              <Command.Input ref={inputRef} placeholder="搜索本机字体..." />
            </div>
            <Command.List className="font-select-list">
              <Command.Empty>
                <div className="font-select-empty">{fonts.length ? "没有找到字体" : fontLoadError || "正在读取本机字体..."}</div>
              </Command.Empty>
              <Command.Group heading="常用">
                {recommendedOptions.map((option) => (
                  <FontCommandItem key={`${option.group}:${option.value}`} option={option} active={option.value === normalizedValue} onPick={pickFont} />
                ))}
              </Command.Group>
              {systemOptions.length > 0 && (
                <Command.Group heading="本机字体">
                  {systemOptions.map((option) => (
                    <FontCommandItem key={option.value} option={option} active={option.value === normalizedValue} onPick={pickFont} />
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </div>
      )}
    </div>
  );
}

function FontCommandItem({ option, active, onPick }: { option: FontOption; active: boolean; onPick: (value: string) => void }) {
  return (
    <Command.Item value={`${option.label} ${option.value}`} onSelect={() => onPick(option.value)} className="font-select-item">
      <span className={active ? "font-select-check active" : "font-select-check"}>{active ? "✓" : ""}</span>
      <span>
        <strong>{option.label}</strong>
        <small style={{ fontFamily: option.value }}>{fontPreviewText}</small>
      </span>
    </Command.Item>
  );
}

function buildFontOptions(fonts: string[], currentValue: string, defaultValue: string): FontOption[] {
  const seen = new Set<string>();
  const add = (option: FontOption, list: FontOption[]) => {
    if (seen.has(option.value)) return;
    seen.add(option.value);
    list.push(option);
  };
  const output: FontOption[] = [];
  add({ label: "系统默认", value: defaultValue, group: "default" }, output);
  const fontSet = new Set(fonts);
  for (const family of recommendedFontFamilies) {
    if (fonts.length && !fontSet.has(family)) continue;
    add({ label: family, value: cssFontFamilyForFont(family), group: "recommended" }, output);
  }
  if (currentValue !== defaultValue && !seen.has(currentValue)) {
    add({ label: `${fontDisplayName(currentValue, defaultValue)}（当前）`, value: currentValue, group: "current" }, output);
  }
  for (const family of fonts) {
    add({ label: family, value: cssFontFamilyForFont(family), group: "system" }, output);
  }
  return output;
}

function cssFontFamilyForFont(family: string): string {
  return `${JSON.stringify(family)}, sans-serif`;
}

function fontDisplayName(value: string, defaultValue: string): string {
  if (!value.trim() || value === defaultValue) return "系统默认";
  return value.split(",")[0]?.trim().replace(/^["']|["']$/g, "") || value;
}

export function FontSizeControl({
  label,
  description,
  fontFamily,
  value,
  defaultValue,
  min,
  max,
  onChange
}: {
  label: string;
  description: string;
  fontFamily: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const normalizedValue = normalizeFontSize(value, defaultValue, min, max);
  const setNext = (nextValue: unknown) => onChange(normalizeFontSize(nextValue, defaultValue, min, max));
  return (
    <div className="font-size-control">
      <div className="font-size-control-header">
        <div>
          <strong>{label}</strong>
          <span>{description}</span>
        </div>
        <div className="font-size-stepper">
          <button type="button" className="secondary-button" disabled={normalizedValue <= min} onClick={() => setNext(normalizedValue - 1)}>
            -
          </button>
          <input type="number" min={min} max={max} value={normalizedValue} onChange={(event) => setNext(event.target.value)} />
          <span>px</span>
          <button type="button" className="secondary-button" disabled={normalizedValue >= max} onClick={() => setNext(normalizedValue + 1)}>
            +
          </button>
        </div>
      </div>
      <div className="font-size-slider-row">
        <span>{min}</span>
        <input type="range" min={min} max={max} step="1" value={normalizedValue} onChange={(event) => setNext(event.target.value)} />
        <span>{max}</span>
      </div>
      <div className="font-size-preview" style={{ fontFamily, fontSize: normalizedValue }}>
        中文 English 12345
      </div>
    </div>
  );
}

function normalizeFontSize(value: unknown, defaultValue: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return defaultValue;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}
