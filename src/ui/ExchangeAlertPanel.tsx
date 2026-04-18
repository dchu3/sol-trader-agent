import React from "react";
import { Box, Text } from "ink";
import type { ExchangeTransfer } from "../exchange-db.js";

interface ExchangeAlertPanelProps {
  transfers: ExchangeTransfer[];
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

function TransferRow({ transfer }: { transfer: ExchangeTransfer }): React.JSX.Element {
  const isColdToHot = transfer.transferType === "cold_to_hot";
  const isHotToCold = transfer.transferType === "hot_to_cold";

  const typeColor = isColdToHot ? "red" : isHotToCold ? "green" : "yellow";
  const typeIcon = isColdToHot
    ? "🔴 COLD→HOT"
    : isHotToCold
    ? "🟢 HOT→COLD"
    : transfer.transferType === "exchange_to_exchange"
    ? "🔄 XCH→XCH"
    : transfer.transferType === "external_to_hot"
    ? "🟡 EXT→HOT"
    : "⚪ HOT→EXT";

  return (
    <Box gap={1}>
      <Text dimColor>{formatTimeAgo(transfer.alertedAt)}</Text>
      <Text color={typeColor} bold>
        {typeIcon}
      </Text>
      <Text bold>{transfer.exchangeName}</Text>
      <Text dimColor>{transfer.solAmount.toFixed(0)} SOL</Text>
    </Box>
  );
}

export function ExchangeAlertPanel({
  transfers,
  maxVisible = 8,
}: ExchangeAlertPanelProps): React.JSX.Element {
  const visible = transfers.slice(0, maxVisible);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="yellow"
      paddingX={1}
      minHeight={4}
    >
      <Text color="yellow" bold>
        🏦 Exchange Tracker
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>Monitoring exchange wallets for large SOL movements.</Text>
      ) : (
        visible.map((t) => <TransferRow key={t.signature} transfer={t} />)
      )}
    </Box>
  );
}
