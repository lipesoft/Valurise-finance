"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";

type HelpHintProps = {
  label: string;
  children: ReactNode;
};

/** Compact, keyboard-accessible help that keeps explanatory copy out of the main flow. */
export function HelpHint({ label, children }: HelpHintProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 32);
    const left = Math.max(16, Math.min(bounds.left, window.innerWidth - width - 16));
    const maxHeight = Math.min(520, window.innerHeight - 32);
    const placeAbove = bounds.bottom + Math.min(260, maxHeight * 0.55) > window.innerHeight;
    setPosition({
      position: "fixed",
      left,
      width,
      maxHeight: `min(70dvh, ${maxHeight}px)`,
      ...(placeAbove
        ? { bottom: Math.max(16, window.innerHeight - bounds.top + 8) }
        : { top: bounds.bottom + 8 }),
    });
  }, []);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    updatePosition();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Ajuda: ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`Como funciona: ${label}`}
        onClick={toggle}
        className="muted grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-transparent transition-colors hover:bg-[var(--panel2)] hover:text-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        <CircleHelp aria-hidden="true" size={15} />
      </button>
      {open && position && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          id={id}
          role="region"
          aria-label={label}
          tabIndex={-1}
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => event.stopPropagation()}
          style={position}
          className="panel z-[100] overflow-y-auto overscroll-contain rounded-2xl p-4 text-left shadow-2xl focus:outline-none"
        >
          <b className="block text-sm">{label}</b>
          <div className="muted mt-1 space-y-2 text-xs leading-5">{children}</div>
        </div>,
        document.body,
      )}
    </>
  );
}
