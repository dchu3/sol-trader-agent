import React, { useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";

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

export function MessageLog({
  messages,
  maxVisible = 50,
}: MessageLogProps): React.JSX.Element {
  const scrollRef = useRef<ScrollViewRef>(null);
  const { stdout } = useStdout();
  const prevLengthRef = useRef(messages.length);
  const isAtBottomRef = useRef(true);

  const recent = messages.slice(-maxVisible);
  const hiddenCount = messages.length - recent.length;

  // Track whether user is at the bottom
  const handleScroll = (offset: number) => {
    const bottom = scrollRef.current?.getBottomOffset() ?? 0;
    isAtBottomRef.current = offset >= bottom - 1;
  };

  // Auto-scroll to bottom on new messages (if user was at bottom)
  useEffect(() => {
    if (messages.length > prevLengthRef.current && isAtBottomRef.current) {
      // Small delay to let ScrollView measure the new content
      const timer = setTimeout(() => {
        scrollRef.current?.scrollToBottom();
      }, 50);
      prevLengthRef.current = messages.length;
      return () => clearTimeout(timer);
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  // Handle terminal resize
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => scrollRef.current?.remeasure();
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  // Shift+Up/Down for scrolling
  useInput((_input, key) => {
    if (key.shift && key.upArrow) {
      scrollRef.current?.scrollBy(-1);
    }
    if (key.shift && key.downArrow) {
      scrollRef.current?.scrollBy(1);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScrollView ref={scrollRef} flexGrow={1} onScroll={handleScroll}>
        {recent.length === 0 ? (
          <Box key="welcome" paddingX={1} paddingY={1}>
            <Text dimColor>
              Welcome to Sol Trader Agent! Type a message to get started, or /help for commands.
            </Text>
          </Box>
        ) : (
          <>
            {hiddenCount > 0 && (
              <Box key="hidden-indicator" paddingX={1}>
                <Text dimColor>↑ {hiddenCount} older message{hiddenCount !== 1 ? "s" : ""}</Text>
              </Box>
            )}
            {recent.map((msg, idx) => (
              <MessageBubble key={`msg-${messages.length - recent.length + idx}`} msg={msg} />
            ))}
          </>
        )}
      </ScrollView>
    </Box>
  );
}
