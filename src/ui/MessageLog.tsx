import React from "react";
import { Box, Text } from "ink";

export interface Message {
  role: "user" | "agent" | "system";
  text: string;
  timestamp: number;
}

interface MessageLogProps {
  messages: Message[];
  maxVisible?: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

export function MessageLog({ messages, maxVisible = 50 }: MessageLogProps): React.JSX.Element {
  const visible = messages.slice(-maxVisible);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden" justifyContent="flex-end">
      {visible.length === 0 ? (
        <Box paddingX={1} paddingY={1}>
          <Text dimColor>
            Welcome to Sol Trader Agent! Type a message to get started, or /help for commands.
          </Text>
        </Box>
      ) : (
        visible.map((msg, idx) => <MessageBubble key={idx} msg={msg} />)
      )}
    </Box>
  );
}
