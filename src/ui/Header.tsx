import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  walletAddress: string;
  modelName: string;
  serverCount: number;
  whaleTrackerActive: boolean;
  watchedWalletCount: number;
  termColumns?: number;
}

export function Header({
  walletAddress,
  modelName,
  serverCount,
  whaleTrackerActive,
  watchedWalletCount,
  termColumns = 80,
}: HeaderProps): React.JSX.Element {
  const shortWallet = walletAddress.length > 12
    ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
    : walletAddress;

  // Abbreviate model name on narrow terminals
  const maxModelLen = Math.max(10, termColumns - 60);
  const displayModel = modelName.length > maxModelLen
    ? modelName.slice(0, maxModelLen - 1) + "…"
    : modelName;

  // Whale status with proper spacing and state
  let whaleText: string;
  let whaleColor: string;
  if (!whaleTrackerActive) {
    whaleText = "🐋  off";
    whaleColor = "gray";
  } else if (watchedWalletCount === 0) {
    whaleText = "🐋  idle";
    whaleColor = "yellow";
  } else {
    whaleText = `🐋  ${watchedWalletCount} watching`;
    whaleColor = "green";
  }

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
      borderStyle="single"
      borderColor="cyan"
    >
      <Box gap={2}>
        <Text color="cyan" bold wrap="truncate-end">
          🪐  Sol Trader
        </Text>
        <Text dimColor wrap="truncate-end">
          💳  {shortWallet}
        </Text>
        <Text dimColor wrap="truncate-end">
          🤖  {displayModel}
        </Text>
      </Box>
      <Box gap={2}>
        <Text color={serverCount > 0 ? "green" : "red"} wrap="truncate-end">
          ⚡  {serverCount} MCP{serverCount !== 1 ? "s" : ""}
        </Text>
        <Text color={whaleColor as any} wrap="truncate-end">
          {whaleText}
        </Text>
      </Box>
    </Box>
  );
}
