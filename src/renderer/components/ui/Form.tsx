import React from "react";
import { FolderOpen } from "lucide-react";

export function FieldRow({ label, description, children }: { label: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="field-row">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

export function PathInput({ value, onPick, onChange }: { value: string; onPick: () => void; onChange?: (value: string) => void }) {
  return (
    <div className="path-input">
      <input value={value} readOnly={!onChange} onChange={(event) => onChange?.(event.target.value)} />
      <button className="secondary-button" onClick={onPick}>
        <FolderOpen size={16} />
        选择
      </button>
    </div>
  );
}
