import React, { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";

interface InputPromptProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputPrompt({
  onSubmit,
  disabled = false,
  placeholder = "Type a message or /help...",
}: InputPromptProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyStack, setHistoryStack] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedDraft = useRef("");

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.return) {
        const trimmed = value.trim();
        if (trimmed) {
          setHistoryStack((prev) => [trimmed, ...prev.slice(0, 49)]);
          setHistoryIndex(-1);
          savedDraft.current = "";
          onSubmit(trimmed);
          setValue("");
          setCursor(0);
        }
        return;
      }

      // Ctrl+A = Home, Ctrl+E = End
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }
      // Ctrl+U = clear line
      if (key.ctrl && input === "u") {
        setValue("");
        setCursor(0);
        return;
      }

      if (key.leftArrow) {
        setCursor((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.rightArrow) {
        setCursor((prev) => Math.min(value.length, prev + 1));
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setValue((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
          setCursor((prev) => prev - 1);
        }
        return;
      }

      if (key.upArrow) {
        if (historyStack.length === 0) return;
        setHistoryIndex((prev) => {
          if (prev === -1) {
            savedDraft.current = value;
          }
          const next = Math.min(prev + 1, historyStack.length - 1);
          const entry = historyStack[next];
          setValue(entry);
          setCursor(entry.length);
          return next;
        });
        return;
      }

      if (key.downArrow) {
        setHistoryIndex((prev) => {
          const next = prev - 1;
          if (next < 0) {
            const draft = savedDraft.current;
            setValue(draft);
            setCursor(draft.length);
            return -1;
          }
          const entry = historyStack[next];
          setValue(entry);
          setCursor(entry.length);
          return next;
        });
        return;
      }

      // Ignore other control/meta sequences
      if (key.ctrl || key.meta || key.escape || key.tab) return;

      if (input) {
        setValue((prev) => prev.slice(0, cursor) + input + prev.slice(cursor));
        setCursor((prev) => prev + input.length);
        setHistoryIndex(-1);
      }
    },
  );

  const renderInput = (): React.JSX.Element => {
    if (disabled) {
      return <Text dimColor>Processing...</Text>;
    }
    if (!value) {
      return (
        <Text>
          <Text inverse> </Text>
          <Text dimColor>{placeholder}</Text>
        </Text>
      );
    }
    const before = value.slice(0, cursor);
    const cursorChar = value[cursor] ?? " ";
    const after = value.slice(cursor + 1);
    return (
      <Text>
        {before}
        <Text inverse>{cursorChar}</Text>
        {after}
      </Text>
    );
  };

  return (
    <Box paddingX={1}>
      <Text color="blue" bold>
        {">"}{" "}
      </Text>
      {renderInput()}
    </Box>
  );
}
