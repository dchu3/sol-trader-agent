import React, { useMemo } from "react";
import { Box, Text } from "ink";

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

// Estimate rendered line count for a message (conservative — may overcount slightly)
function estimateHeight(msg: Message, termColumns: number): number {
  // Content width: terminal minus paddingX(1 each side) minus textPaddingLeft(2)
  const contentWidth = Math.max(20, termColumns - 4);
  const lines = msg.text.split("\n");
  let textLines = 0;
  for (const line of lines) {
    textLines += Math.max(1, Math.ceil((line.length || 1) / contentWidth));
  }

  if (msg.role === "system") {
    // system: "ℹ " prefix on one line block + marginBottom(1)
    return textLines + 1;
  }
  // user/agent: header line + text lines + marginBottom(1)
  return 1 + textLines + 1;
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

export function MessageLog({
  messages,
  availableRows,
  termColumns,
  maxVisible = 50,
}: MessageLogProps): React.JSX.Element {
  const { visible, hiddenCount } = useMemo(() => {
    const recent = messages.slice(-maxVisible);
    let usedRows = 0;
    let startIdx = recent.length;

    for (let i = recent.length - 1; i >= 0; i--) {
      const h = estimateHeight(recent[i], termColumns);
      if (usedRows + h > availableRows && startIdx < recent.length) break;
      usedRows += h;
      startIdx = i;
    }

    return {
      visible: recent.slice(startIdx),
      hiddenCount: messages.length - (recent.length - startIdx),
    };
  }, [messages, availableRows, termColumns, maxVisible]);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.length === 0 ? (
        <Box paddingX={1} paddingY={1}>
          <Text dimColor>
            Welcome to Sol Trader Agent! Type a message to get started, or /help for commands.
          </Text>
        </Box>
      ) : (
        <>
          {hiddenCount > 0 && (
            <Box paddingX={1}>
              <Text dimColor>↑ {hiddenCount} older message{hiddenCount !== 1 ? "s" : ""}</Text>
            </Box>
          )}
          {visible.map((msg, idx) => <MessageBubble key={idx} msg={msg} />)}
        </>
      )}
    </Box>
  );
}
