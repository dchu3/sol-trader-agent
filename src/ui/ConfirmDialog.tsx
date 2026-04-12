import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface ConfirmDialogProps {
  message: string;
  onResolve: (approved: boolean) => void;
}

export function ConfirmDialog({ message, onResolve }: ConfirmDialogProps): React.JSX.Element {
  const [resolved, setResolved] = useState(false);

  useInput((input) => {
    if (resolved) return;
    const lower = input.toLowerCase();
    if (lower === "y") {
      setResolved(true);
      onResolve(true);
    } else if (lower === "n" || input === "\r" || input === "\n") {
      setResolved(true);
      onResolve(false);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="yellow">
      <Text color="yellow" bold>
        ⚠️  {message}
      </Text>
      <Box marginTop={1}>
        <Text>
          Press <Text color="green" bold>y</Text> to approve or{" "}
          <Text color="red" bold>n</Text>/Enter to decline
        </Text>
      </Box>
    </Box>
  );
}
