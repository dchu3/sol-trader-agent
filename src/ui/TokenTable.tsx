import React from "react";
import { Box, Text } from "ink";

export interface TokenRow {
  label: string;
  value: string;
  color?: string;
}

interface TokenTableProps {
  title?: string;
  rows: TokenRow[];
}

/** Simple key-value table for displaying token data or whale info. */
export function TokenTable({ title, rows }: TokenTableProps): React.JSX.Element {
  if (rows.length === 0) return <></>;

  const maxLabelLen = Math.max(...rows.map((r) => r.label.length));

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {title && (
        <Text bold underline>
          {title}
        </Text>
      )}
      {rows.map((row, idx) => (
        <Box key={idx} gap={1}>
          <Text dimColor>{row.label.padEnd(maxLabelLen)}</Text>
          <Text color={row.color as any}>{row.value}</Text>
        </Box>
      ))}
    </Box>
  );
}
