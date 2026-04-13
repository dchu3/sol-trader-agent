import React, { useMemo, useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";

export interface Message {
  role: "user" | "agent" | "system";
  text: string;
  timestamp: number;
}

interface MessageLogProps {
  messages: Message[];
  availableRows: number;
  termColumns: number;
  maxVisible?: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Regex to match common emoji and wide characters (CJK, fullwidth, etc.)
const WIDE_CHAR_RE =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{2702}-\u{27B0}\u{231A}-\u{23F3}\u{2934}-\u{2935}\u{25AA}-\u{25FE}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{3030}\u{303D}\u{3297}\u{3299}\u{2300}-\u{23FF}\u{2B50}\u{200D}\u{20E3}\u{FE0F}\u{E0020}-\u{E007F}\u{1100}-\u{115F}\u{2329}-\u{232A}\u{2E80}-\u{303E}\u{3040}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{AC00}-\u{D7AF}\u{F900}-\u{FAFF}\u{FE10}-\u{FE19}\u{FE30}-\u{FE6F}\u{FF01}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F1E0}-\u{1F1FF}]/gu;

function visualWidth(str: string): number {
  const wideMatches = str.match(WIDE_CHAR_RE);
  const wideCount = wideMatches ? wideMatches.length : 0;
  return str.length + wideCount;
}

// Estimate rendered line count for a message (conservative — includes safety margin)
function estimateHeight(msg: Message, termColumns: number): number {
  // Content width: terminal minus paddingX(1 each side) minus textPaddingLeft(2)
  const contentWidth = Math.max(20, termColumns - 4);
  const lines = msg.text.split("\n");
  let textLines = 0;
  for (const line of lines) {
    const width = visualWidth(line) || 1;
    textLines += Math.max(1, Math.ceil(width / contentWidth));
  }

  // +1 safety margin per message to account for rendering variance
  if (msg.role === "system") {
    return textLines + 1 + 1;
  }
  return 1 + textLines + 1 + 1;
}

function MessageBubble({ msg }: { msg: Message }): React.JSX.Element {
  const time = formatTime(msg.timestamp);

  if (msg.role === "user") {
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text color="blue" bold>
          You <Text dimColor>[{time}]</Text>
        </Text>
        <Box paddingLeft={2}>
          <Text>{msg.text}</Text>
        </Box>
      </Box>
    );
  }

  if (msg.role === "system") {
    return (
      <Box paddingX={1} marginBottom={1}>
        <Text color="yellow" dimColor>
          ℹ {msg.text}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text color="green" bold>
        Agent <Text dimColor>[{time}]</Text>
      </Text>
      <Box paddingLeft={2}>
        <Text>{msg.text}</Text>
      </Box>
    </Box>
  );
}

const SCROLL_PAGE_SIZE = 5;

export function MessageLog({
  messages,
  availableRows,
  termColumns,
  maxVisible = 50,
}: MessageLogProps): React.JSX.Element {
  const [scrollOffset, setScrollOffset] = useState(0);
  const prevLengthRef = useRef(messages.length);

  // Auto-scroll to bottom when new messages arrive (if already at bottom)
  useEffect(() => {
    if (messages.length > prevLengthRef.current && scrollOffset === 0) {
      // Already at bottom, stay there
    } else if (messages.length > prevLengthRef.current) {
      // New message arrived while scrolled up — keep position but update indicator
    }
    prevLengthRef.current = messages.length;
  }, [messages.length, scrollOffset]);

  // Handle PageUp/PageDown for scrolling
  useInput((_input, key) => {
    if (key.pageUp) {
      setScrollOffset((prev) => Math.min(prev + SCROLL_PAGE_SIZE, Math.max(0, messages.length - 1)));
    }
    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - SCROLL_PAGE_SIZE));
    }
  });

  const { visible, hiddenAbove, hiddenBelow } = useMemo(() => {
    const recent = messages.slice(-maxVisible);
    // Clamp scroll offset to valid range
    const clampedOffset = Math.min(scrollOffset, Math.max(0, recent.length - 1));

    // End index: skip `clampedOffset` messages from the bottom
    const endIdx = recent.length - clampedOffset;
    if (endIdx <= 0) {
      return { visible: [] as Message[], hiddenAbove: 0, hiddenBelow: messages.length };
    }

    let usedRows = 0;
    let startIdx = endIdx;
    // Reserve rows for indicators (1 for "older" above, 1 for "newer" below)
    const reservedRows = (clampedOffset > 0 ? 1 : 0) + 1; // always reserve 1 for potential "older" indicator
    const budget = Math.max(2, availableRows - reservedRows);

    for (let i = endIdx - 1; i >= 0; i--) {
      const h = estimateHeight(recent[i], termColumns);
      if (usedRows + h > budget && startIdx < endIdx) break;
      usedRows += h;
      startIdx = i;
    }

    const totalShown = endIdx - startIdx;
    const above = messages.length - (recent.length - startIdx) - clampedOffset;
    const below = clampedOffset;

    return {
      visible: recent.slice(startIdx, endIdx),
      hiddenAbove: Math.max(0, above),
      hiddenBelow: below,
    };
  }, [messages, availableRows, termColumns, maxVisible, scrollOffset]);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.length === 0 && hiddenBelow === 0 ? (
        <Box paddingX={1} paddingY={1}>
          <Text dimColor>
            Welcome to Sol Trader Agent! Type a message to get started, or /help for commands.
          </Text>
        </Box>
      ) : (
        <>
          {hiddenAbove > 0 && (
            <Box paddingX={1}>
              <Text dimColor>↑ {hiddenAbove} older message{hiddenAbove !== 1 ? "s" : ""} — PgUp to scroll</Text>
            </Box>
          )}
          {visible.map((msg, idx) => <MessageBubble key={idx} msg={msg} />)}
          {hiddenBelow > 0 && (
            <Box paddingX={1}>
              <Text dimColor>↓ {hiddenBelow} newer message{hiddenBelow !== 1 ? "s" : ""} — PgDn to scroll</Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
