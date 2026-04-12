import React from "react";
import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = "Thinking..." }: SpinnerProps): React.JSX.Element {
  return (
    <Box paddingX={1}>
      <Text color="cyan">
        <InkSpinner type="dots" />
      </Text>
      <Text color="gray"> {label}</Text>
    </Box>
  );
}
