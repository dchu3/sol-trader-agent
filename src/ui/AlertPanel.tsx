import React from "react";
import { Box, Text } from "ink";
import type { WhaleAlert } from "../whale-db.js";

interface AlertPanelProps {
  alerts: WhaleAlert[];
  maxVisible?: number;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function truncateAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function AlertRow({ alert }: { alert: WhaleAlert }): React.JSX.Element {
  const actionColor = alert.action === "buy" ? "green" : alert.action === "sell" ? "red" : "gray";
  const actionLabel = alert.action === "buy" ? "🟢 BUY" : alert.action === "sell" ? "🔴 SELL" : "⚪ ???";
  const label = alert.walletLabel || truncateAddr(alert.walletAddress);
  const token = alert.tokenSymbol || truncateAddr(alert.tokenAddress);

  return (
    <Box gap={1}>
      <Text dimColor>{formatTimeAgo(alert.alertedAt)}</Text>
      <Text color={actionColor} bold>{actionLabel}</Text>
      <Text>{label}</Text>
      <Text dimColor>→</Text>
      <Text color="cyan">{token}</Text>
      {alert.solAmount !== "0" && (
        <Text dimColor>({alert.solAmount} SOL)</Text>
      )}
    </Box>
  );
}

export function AlertPanel({ alerts, maxVisible = 10 }: AlertPanelProps): React.JSX.Element {
  const visible = alerts.slice(0, maxVisible);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      paddingX={1}
      minHeight={5}
    >
      <Text color="magenta" bold>
        🐋 Whale Alerts
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>No alerts yet. Use /watch to track wallets.</Text>
      ) : (
        visible.map((alert) => <AlertRow key={alert.signature} alert={alert} />)
      )}
    </Box>
  );
}
