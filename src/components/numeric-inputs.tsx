"use client";

import { useEffect, useRef, type InputHTMLAttributes } from "react";
import { applyMoneyInputEdit, formatGroupedInteger, formatLocalizedDecimalInput, formatMoneyInputValue, inferMoneyInputEdit, type MoneyInputEdit } from "@/lib/numeric-input";

type MoneyInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode" | "value" | "onChange" | "onPaste" | "onBeforeInput"> & {
  value: string;
  onValueChange: (value: string) => void;
  allowNegative?: boolean;
};

export function MoneyInput({ value, onValueChange, allowNegative = false, ...props }: MoneyInputProps) {
  const pendingEdit = useRef<MoneyInputEdit | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayValue = formatMoneyInputValue(value, allowNegative) ?? "";

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const captureBeforeInput = (event: InputEvent) => {
      pendingEdit.current = {
        inputType: event.inputType,
        data: event.data,
        selectionStart: input.selectionStart ?? input.value.length,
        selectionEnd: input.selectionEnd ?? input.value.length,
      };
    };
    input.addEventListener("beforeinput", captureBeforeInput);
    return () => input.removeEventListener("beforeinput", captureBeforeInput);
  }, []);

  const restoreCaret = (input: HTMLInputElement, text: string, caret: number, formattedValue: string) => {
    const digitsBefore = (text.slice(0, caret).match(/\d/g) || []).length;
    let nextCaret = 0;
    let digitsSeen = 0;
    while (nextCaret < formattedValue.length && digitsSeen < digitsBefore) {
      if (/\d/.test(formattedValue[nextCaret])) digitsSeen += 1;
      nextCaret += 1;
    }
    if (text.slice(0, caret).includes(",") && formattedValue.includes(",")) {
      nextCaret = Math.max(nextCaret, formattedValue.indexOf(",") + 1);
    }
    if (text.slice(0, caret).endsWith(".") && [".", ","].includes(formattedValue[nextCaret] || "")) nextCaret += 1;
    window.requestAnimationFrame(() => {
      if (document.activeElement === input) input.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const updateFromEdit = (input: HTMLInputElement, edit: MoneyInputEdit, textForCaret: string) => {
    const nextValue = applyMoneyInputEdit(displayValue, edit, allowNegative);
    pendingEdit.current = null;
    if (nextValue === null) {
      input.value = displayValue;
      return;
    }
    onValueChange(nextValue);
    restoreCaret(input, textForCaret, input.selectionStart ?? textForCaret.length, nextValue);
  };

  return <input
    {...props}
    ref={inputRef}
    type="text"
    inputMode="decimal"
    value={displayValue}
    onChange={(event) => {
      const input = event.currentTarget;
      const text = input.value;
      const edit = pendingEdit.current ?? inferMoneyInputEdit(displayValue, text);
      updateFromEdit(input, edit, text);
    }}
    onPaste={(event) => {
      const input = event.currentTarget;
      const text = event.clipboardData.getData("text");
      if (!text) return;
      event.preventDefault();
      const nextValue = applyMoneyInputEdit(displayValue, {
        inputType: "insertFromPaste",
        data: text,
        selectionStart: input.selectionStart ?? displayValue.length,
        selectionEnd: input.selectionEnd ?? displayValue.length,
      }, allowNegative);
      pendingEdit.current = null;
      if (nextValue === null) return;
      onValueChange(nextValue);
      window.requestAnimationFrame(() => {
        if (document.activeElement === input) input.setSelectionRange(nextValue.length, nextValue.length);
      });
    }}
  />;
}

type DecimalInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode" | "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
};

export function DecimalInput({ value, onValueChange, ...props }: DecimalInputProps) {
  const displayValue = formatLocalizedDecimalInput(value);
  return <input
    {...props}
    type="text"
    inputMode="decimal"
    value={displayValue}
    onChange={(event) => onValueChange(formatLocalizedDecimalInput(event.target.value))}
  />;
}

type GroupedIntegerInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode" | "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
};

export function GroupedIntegerInput({ value, onValueChange, ...props }: GroupedIntegerInputProps) {
  const displayValue = formatGroupedInteger(value);
  return <input
    {...props}
    type="text"
    inputMode="numeric"
    value={displayValue}
    onChange={(event) => {
      const input = event.currentTarget;
      const text = input.value;
      const digitsBefore = (text.slice(0, input.selectionStart ?? text.length).match(/\d/g) || []).length;
      const formatted = formatGroupedInteger(text);
      onValueChange(formatted);
      let nextCaret = 0;
      let digitsSeen = 0;
      while (nextCaret < formatted.length && digitsSeen < digitsBefore) {
        if (/\d/.test(formatted[nextCaret])) digitsSeen += 1;
        nextCaret += 1;
      }
      window.requestAnimationFrame(() => {
        if (document.activeElement === input) input.setSelectionRange(nextCaret, nextCaret);
      });
    }}
  />;
}
