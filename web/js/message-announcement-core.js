export function findNewIncomingMessages(knownIds, serverMessages, accountId) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? []);
  return (serverMessages ?? []).filter((message) =>
    Boolean(
      message?.messageId &&
      !known.has(message.messageId) &&
      message.senderUserId &&
      message.senderUserId !== accountId
    )
  );
}
