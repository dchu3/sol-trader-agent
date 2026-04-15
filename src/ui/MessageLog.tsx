import React, { useEffect, useRef, useState, useCallback } from "react";
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

const SCROLL_STEP = 5;
const PAGE_OVERLAP = 2;

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
  maxVisible = 200,
}: MessageLogProps): React.JSX.Element {
  const scrollRef = useRef<ScrollViewRef>(null);
  const { stdout } = useStdout();
  const prevLengthRef = useRef(messages.length);
  const isAtBottomRef = useRef(true);
  const [scrollPercent, setScrollPercent] = useState(100);
  const [showIndicator, setShowIndicator] = useState(false);

  const recent = messages.slice(-maxVisible);
  const hiddenCount = messages.length - recent.length;

  const updateScrollState = useCallback(() => {
    const bottom = scrollRef.current?.getBottomOffset() ?? 0;
    const offset = scrollRef.current?.getScrollOffset() ?? 0;
    isAtBottomRef.current = offset >= bottom;
    setShowIndicator(bottom > 0 && offset < bottom);
    setScrollPercent(bottom > 0 ? Math.round((offset / bottom) * 100) : 100);
  }, []);

  // Track whether user is at the bottom
  const handleScroll = useCallback((_offset: number) => {
    updateScrollState();
  }, [updateScrollState]);

  // Auto-scroll to bottom on new messages (if user was at bottom)
  useEffect(() => {
    if (messages.length > prevLengthRef.current && isAtBottomRef.current) {
      const timer = setTimeout(() => {
        if (isAtBottomRef.current) scrollRef.current?.scrollToBottom();
      }, 50);
      prevLengthRef.current = messages.length;
      return () => clearTimeout(timer);
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  // Handle terminal resize
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      scrollRef.current?.remeasure();
      if (isAtBottomRef.current) {
        setTimeout(() => scrollRef.current?.scrollToBottom(), 0);
      }
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  // Scroll keybindings
  useInput((input, key) => {
    // Shift+Up/Down — scroll by SCROLL_STEP lines
    if (key.shift && key.upArrow) {
      scrollRef.current?.scrollBy(-SCROLL_STEP);
      return;
    }
    if (key.shift && key.downArrow) {
      const maxOffset = scrollRef.current?.getBottomOffset() ?? 0;
      const current = scrollRef.current?.getScrollOffset() ?? 0;
      scrollRef.current?.scrollTo(Math.min(current + SCROLL_STEP, maxOffset));
      return;
    }

    // Page Up / Page Down — scroll by viewport height
    if (key.pageUp) {
      const vpHeight = scrollRef.current?.getViewportHeight() ?? 20;
      scrollRef.current?.scrollBy(-(vpHeight - PAGE_OVERLAP));
      return;
    }
    if (key.pageDown) {
      const vpHeight = scrollRef.current?.getViewportHeight() ?? 20;
      const maxOffset = scrollRef.current?.getBottomOffset() ?? 0;
      const current = scrollRef.current?.getScrollOffset() ?? 0;
      scrollRef.current?.scrollTo(Math.min(current + (vpHeight - PAGE_OVERLAP), maxOffset));
      return;
    }

    // Ctrl+Home / Ctrl+End — jump to top/bottom
    if (key.ctrl && key.upArrow) {
      scrollRef.current?.scrollToTop();
      return;
    }
    if (key.ctrl && key.downArrow) {
      scrollRef.current?.scrollToBottom();
      return;
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
      {showIndicator && (
        <Box paddingX={1} flexShrink={0}>
          <Text dimColor>
            ↑ Shift+↑↓ scroll • PgUp/PgDn page • Ctrl+↑↓ top/bottom — {scrollPercent}%
          </Text>
        </Box>
      )}
    </Box>
  );
}
