import React, { useState, useCallback } from "react";
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
  const [historyStack, setHistoryStack] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.return) {
        const trimmed = value.trim();
        if (trimmed) {
          setHistoryStack((prev) => [trimmed, ...prev.slice(0, 49)]);
          setHistoryIndex(-1);
          onSubmit(trimmed);
          setValue("");
        }
        return;
      }

      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        return;
      }

      if (key.upArrow) {
        setHistoryIndex((prev) => {
          const next = Math.min(prev + 1, historyStack.length - 1);
          if (next >= 0 && next < historyStack.length) {
            setValue(historyStack[next]);
          }
          return next;
        });
        return;
      }

      if (key.downArrow) {
        setHistoryIndex((prev) => {
          const next = prev - 1;
          if (next < 0) {
            setValue("");
            return -1;
          }
          if (next < historyStack.length) {
            setValue(historyStack[next]);
          }
          return next;
        });
        return;
      }

      // Ignore other control keys
      if (key.ctrl || key.meta || key.escape || key.tab) return;

      if (input) {
        setValue((prev) => prev + input);
        setHistoryIndex(-1);
      }
    },
  );

  return (
    <Box paddingX={1}>
      <Text color="blue" bold>
        {">"}{" "}
      </Text>
      {disabled ? (
        <Text dimColor>Processing...</Text>
      ) : value ? (
        <Text>{value}</Text>
      ) : (
        <Text dimColor>{placeholder}</Text>
      )}
      {!disabled && <Text color="cyan">▊</Text>}
    </Box>
  );
}
