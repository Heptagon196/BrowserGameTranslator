import React from "react";
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixProgress from "@radix-ui/react-progress";
import * as RadixSelect from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { ChevronDown, ChevronUp, X } from "lucide-react";

export type StyledSelectOption = {
  value: string;
  label: string;
  description?: string;
  title?: string;
  disabled?: boolean;
};

export function StyledSelect({
  value,
  options,
  className,
  disabled = false,
  onChange
}: {
  value: string;
  options: StyledSelectOption[];
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const selectedOption = options.find((option) => option.value === value);
  return (
    <RadixSelect.Root value={value} disabled={disabled} onValueChange={onChange}>
      <RadixSelect.Trigger className={className ? `styled-select-trigger ${className}` : "styled-select-trigger"}>
        <span className="styled-select-trigger-label">{selectedOption?.label ?? value}</span>
        <RadixSelect.Icon className="styled-select-icon">
          <ChevronDown size={17} strokeWidth={2.4} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="styled-select-content" position="popper" sideOffset={6} collisionPadding={8}>
          <RadixSelect.ScrollUpButton className="styled-select-scroll-button">
            <ChevronUp size={15} strokeWidth={2.4} />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="styled-select-viewport">
            {options.map((option) => (
              <RadixSelect.Item
                className={option.description ? "styled-select-item has-description" : "styled-select-item"}
                disabled={option.disabled}
                key={option.value}
                textValue={option.label}
                title={option.title ?? option.description}
                value={option.value}
              >
                <RadixSelect.ItemText>
                  <span className="styled-select-item-label">{option.label}</span>
                  {option.description ? <span className="styled-select-item-description">{option.description}</span> : null}
                </RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="styled-select-scroll-button">
            <ChevronDown size={15} strokeWidth={2.4} />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

export function AppDialog({
  open,
  title,
  description,
  compact = false,
  className,
  disableOutsideClose = false,
  children,
  onOpenChange
}: {
  open: boolean;
  title: string;
  description?: string;
  compact?: boolean;
  className?: string;
  disableOutsideClose?: boolean;
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="modal-backdrop" />
        <RadixDialog.Content
          className={`modal${compact ? " compact-modal" : ""}${className ? ` ${className}` : ""}`}
          onInteractOutside={disableOutsideClose ? (event) => event.preventDefault() : undefined}
          onPointerDownOutside={disableOutsideClose ? (event) => event.preventDefault() : undefined}
        >
          {onOpenChange ? (
            <RadixDialog.Close className="modal-close-button" aria-label="关闭">
              <X size={18} />
            </RadixDialog.Close>
          ) : null}
          <RadixDialog.Title asChild>
            <h2>{title}</h2>
          </RadixDialog.Title>
          {description ? <RadixDialog.Description className="modal-description">{description}</RadixDialog.Description> : null}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function AppTooltip({ content, children }: { content?: React.ReactNode; children: React.ReactElement }) {
  if (!content) return children;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip-content" sideOffset={7}>
          {content}
          <RadixTooltip.Arrow className="tooltip-arrow" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export function ProgressBar({ value, className = "" }: { value: number; className?: string }) {
  const safeValue = Math.max(0, Math.min(100, value));
  return (
    <RadixProgress.Root className={className ? `progress-root ${className}` : "progress-root"} value={safeValue}>
      <RadixProgress.Indicator className="progress-indicator" style={{ width: `${safeValue}%` }} />
    </RadixProgress.Root>
  );
}

export function CheckboxControl({
  checked,
  compact = false,
  title,
  onChange
}: {
  checked: boolean;
  compact?: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <RadixCheckbox.Root
      className={compact ? "checkbox-control compact" : "checkbox-control"}
      checked={checked}
      title={title}
      onCheckedChange={(value) => onChange(value === true)}
    >
      <RadixCheckbox.Indicator className="checkbox-control-indicator">✓</RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}

export function ToggleSwitch({ checked, onChange, title, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; title?: string; disabled?: boolean }) {
  return (
    <Switch.Root
      className="toggle-switch"
      checked={checked}
      onCheckedChange={onChange}
      title={title}
      disabled={disabled}
    >
      <Switch.Thumb className="toggle-switch-thumb" />
    </Switch.Root>
  );
}
