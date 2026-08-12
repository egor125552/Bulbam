const BOTTOM_TOLERANCE_PX = 96;

export function setupMessageScroll() {
  const list = document.querySelector("#message-list");
  if (!(list instanceof HTMLElement) || !window.MutationObserver) return;

  let lastScrollTop = list.scrollTop;
  let stickToBottom = isNearBottom(list);
  let mutationPending = false;
  let frameId = 0;
  let seenPendingIds = new Set();

  const rememberPosition = () => {
    if (mutationPending) return;
    lastScrollTop = list.scrollTop;
    stickToBottom = isNearBottom(list);
  };

  list.addEventListener("scroll", rememberPosition, { passive: true });

  window.addEventListener("bulbam:chat-changed", () => {
    cancelAnimationFrame(frameId);
    frameId = 0;
    mutationPending = false;
    lastScrollTop = 0;
    stickToBottom = true;
    seenPendingIds = new Set();
  });

  const observer = new MutationObserver(() => {
    mutationPending = true;
    const currentPendingIds = new Set(
      [...list.querySelectorAll(".message-pending[data-message-id]")]
        .map((element) => element.getAttribute("data-message-id"))
        .filter(Boolean)
    );
    const hasNewOwnPendingMessage = [...currentPendingIds].some((messageId) => !seenPendingIds.has(messageId));
    seenPendingIds = currentPendingIds;

    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(() => {
      const target = chooseScrollTop({
        previousScrollTop: lastScrollTop,
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        stickToBottom: stickToBottom || hasNewOwnPendingMessage
      });
      list.scrollTop = target;
      lastScrollTop = list.scrollTop;
      stickToBottom = isNearBottom(list);
      mutationPending = false;
      frameId = 0;
    });
  });

  observer.observe(list, { childList: true });
}

export function isNearBottomMetrics(scrollTop, clientHeight, scrollHeight, tolerance = BOTTOM_TOLERANCE_PX) {
  const distance = Math.max(0, Number(scrollHeight) - Number(clientHeight) - Number(scrollTop));
  return distance <= Math.max(0, Number(tolerance));
}

export function chooseScrollTop({ previousScrollTop, clientHeight, scrollHeight, stickToBottom }) {
  const maxScrollTop = Math.max(0, Number(scrollHeight) - Number(clientHeight));
  if (stickToBottom) return maxScrollTop;
  return Math.max(0, Math.min(Number(previousScrollTop) || 0, maxScrollTop));
}

function isNearBottom(element) {
  return isNearBottomMetrics(element.scrollTop, element.clientHeight, element.scrollHeight);
}
