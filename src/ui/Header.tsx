import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  walletAddress: string;
  modelName: string;
  serverCount: number;
  whaleTrackerActive: boolean;
  watchedWalletCount: number;
}

export function Header({
  walletAddress,
  modelName,
  serverCount,
  whaleTrackerActive,
  watchedWalletCount,
}: HeaderProps): React.JSX.Element {
  const shortWallet = walletAddress.length > 12
    ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
    : walletAddress;

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
      borderStyle="single"
      borderColor="cyan"
    >
      <Box gap={2}>
        <Text color="cyan" bold>
          🪐 Sol Trader
        </Text>
        <Text dimColor>
          💳 {shortWallet}
        </Text>
        <Text dimColor>
          🤖 {modelName}
        </Text>
      </Box>
      <Box gap={2}>
        <Text color={serverCount > 0 ? "green" : "red"}>
          ⚡ {serverCount} MCP{serverCount !== 1 ? "s" : ""}
        </Text>
        <Text color={whaleTrackerActive ? "green" : "gray"}>
          🐋 {whaleTrackerActive ? `${watchedWalletCount} watched` : "off"}
        </Text>
      </Box>
    </Box>
  );
}
