import React, { useReducer, useState, useRef } from "react";
import { Box, Text, useInput } from "ink";

interface InputPromptProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

interface EditorState {
  value: string;
  cursor: number;
}

type EditorAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "clear" }
  | { type: "set"; value: string };

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { value, cursor } = state;
  switch (action.type) {
    case "insert": {
      const text = action.text;
      return {
        value: value.slice(0, cursor) + text + value.slice(cursor),
        cursor: cursor + text.length,
      };
    }
    case "backspace":
      if (cursor <= 0) return state;
      return {
        value: value.slice(0, cursor - 1) + value.slice(cursor),
        cursor: cursor - 1,
      };
    case "left":
      return cursor > 0 ? { ...state, cursor: cursor - 1 } : state;
    case "right":
      return cursor < value.length ? { ...state, cursor: cursor + 1 } : state;
    case "home":
      return { ...state, cursor: 0 };
    case "end":
      return { ...state, cursor: value.length };
    case "clear":
      return { value: "", cursor: 0 };
    case "set":
      return { value: action.value, cursor: action.value.length };
  }
}

export function InputPrompt({
  onSubmit,
  disabled = false,
  placeholder = "Type a message or /help...",
}: InputPromptProps): React.JSX.Element {
  const [editor, dispatch] = useReducer(editorReducer, { value: "", cursor: 0 });
  const [historyStack, setHistoryStack] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedDraft = useRef("");

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.return) {
        const trimmed = editor.value.trim();
        if (trimmed) {
          setHistoryStack((prev) => [trimmed, ...prev.slice(0, 49)]);
          setHistoryIndex(-1);
          savedDraft.current = "";
          onSubmit(trimmed);
          dispatch({ type: "clear" });
        }
        return;
      }

      // Ctrl+A = Home, Ctrl+E = End
      if (key.ctrl && input === "a") { dispatch({ type: "home" }); return; }
      if (key.ctrl && input === "e") { dispatch({ type: "end" }); return; }
      if (key.ctrl && input === "u") { dispatch({ type: "clear" }); return; }

      if (key.leftArrow) { dispatch({ type: "left" }); return; }
      if (key.rightArrow) { dispatch({ type: "right" }); return; }

      // ink v6 maps physical Backspace (0x7f) to key.delete, not key.backspace.
      // key.backspace only fires for Ctrl+H (0x08). Handle both as backspace.
      if (key.backspace || key.delete) {
        dispatch({ type: "backspace" });
        return;
      }

      if (key.upArrow) {
        if (historyStack.length === 0) return;
        setHistoryIndex((prev) => {
          if (prev === -1) {
            savedDraft.current = editor.value;
          }
          const next = Math.min(prev + 1, historyStack.length - 1);
          dispatch({ type: "set", value: historyStack[next] });
          return next;
        });
        return;
      }

      if (key.downArrow) {
        setHistoryIndex((prev) => {
          if (prev <= 0) {
            if (prev === 0) {
              dispatch({ type: "set", value: savedDraft.current });
            }
            return -1;
          }
          const next = prev - 1;
          dispatch({ type: "set", value: historyStack[next] });
          return next;
        });
        return;
      }

      // Ignore other control/meta sequences
      if (key.ctrl || key.meta || key.escape || key.tab) return;

      if (input) {
        dispatch({ type: "insert", text: input });
        setHistoryIndex(-1);
      }
    },
  );

  const renderInput = (): React.JSX.Element => {
    if (disabled) {
      return <Text dimColor>Processing...</Text>;
    }
    if (!editor.value) {
      return (
        <Text>
          <Text inverse> </Text>
          <Text dimColor>{placeholder}</Text>
        </Text>
      );
    }
    const before = editor.value.slice(0, editor.cursor);
    const cursorChar = editor.value[editor.cursor] ?? " ";
    const after = editor.value.slice(editor.cursor + 1);
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
