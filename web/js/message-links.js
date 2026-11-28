// Pure URL detection and safe DOM link rendering for Bulbam messages.
// Never uses innerHTML; strictly allows http: and https: URLs without embedded credentials.

const SAFE_BARE_TLDS = [
  "com", "ru", "by", "org", "net", "io", "me", "app", "dev", "ua", "pl", "de",
  "uk", "eu", "co", "tv", "gg", "ai", "gov", "edu", "info", "xyz", "pro",
  "site", "online", "shop", "store", "club", "news", "live", "рф", "бел"
];

const BARE_TLD_PATTERN = SAFE_BARE_TLDS.join("|");

// Matches explicit http(s):// URLs, www. domains, or bare domains ending in an allowlisted TLD.
const URL_CANDIDATE_RE = new RegExp(
  `(https?:\\/\\/[^\\s<>]+|www\\.[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+[^\\s<>]*|(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?\\.)+(?:${BARE_TLD_PATTERN})(?::\\d{2,5})?(?:\\/[^\\s<>]*)?)`,
  "giu"
);

const PRECEDING_BLOCK_RE = /[\p{L}\p{N}_@/:]/u;
const SIMPLE_TRAILING_PUNCTUATION = new Set([",", ".", "!", "?", ";", ":", "»", "«", "\"", "'", "`", "…"]);
const MATCHING_OPEN_BRACKET = { ")": "(", "]": "[", "}": "{" };

function hasMoreClosers(text, openChar, closeChar) {
  let depth = 0;
  for (const ch of text) {
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) depth -= 1;
  }
  return depth < 0;
}

function trimTrailingPunctuation(raw) {
  let value = raw;
  while (value.length > 0) {
    const last = value[value.length - 1];
    if (SIMPLE_TRAILING_PUNCTUATION.has(last)) {
      value = value.slice(0, -1);
      continue;
    }
    const opener = MATCHING_OPEN_BRACKET[last];
    if (opener && hasMoreClosers(value, opener, last)) {
      value = value.slice(0, -1);
      continue;
    }
    break;
  }
  return value;
}

export function normalizeSafeHref(raw) {
  const value = String(raw ?? "").trim();
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname;
  if (!host || (!host.includes(".") && host !== "localhost")) return null;
  return { href: parsed.href, host };
}

export function tokenizeMessageText(text) {
  const input = String(text ?? "");
  if (!input) return [];

  const tokens = [];
  let cursor = 0;
  URL_CANDIDATE_RE.lastIndex = 0;

  let match;
  while ((match = URL_CANDIDATE_RE.exec(input)) !== null) {
    const start = match.index;
    const rawCandidate = match[0];

    // Prevent half-linking emails (user@example.com) or word-joined fragments (foo.com).
    if (start > 0 && PRECEDING_BLOCK_RE.test(input[start - 1])) {
      continue;
    }

    const display = trimTrailingPunctuation(rawCandidate);
    if (!display) continue;

    // For bare domains without scheme/www, ensure the character right after the TLD/port isn't a word char.
    if (!/^https?:\/\//i.test(display) && !/^www\./i.test(display)) {
      const endIndex = start + display.length;
      const afterChar = input[endIndex];
      if (afterChar && /[\p{L}\p{N}_-]/u.test(afterChar)) {
        continue;
      }
    }

    const normalized = normalizeSafeHref(display);
    if (!normalized) continue;

    if (start > cursor) {
      tokens.push({ type: "text", value: input.slice(cursor, start) });
    }
    tokens.push({
      type: "link",
      text: display,
      href: normalized.href,
      host: normalized.host
    });
    cursor = start + display.length;
  }

  if (cursor < input.length) {
    tokens.push({ type: "text", value: input.slice(cursor) });
  }

  return tokens;
}

export function extractMessageLinks(text) {
  return tokenizeMessageText(text).filter((token) => token.type === "link");
}

export function renderLinkifiedText(container, text) {
  const tokens = tokenizeMessageText(text);
  container.replaceChildren();
  const links = [];

  if (!tokens.length) {
    container.textContent = String(text ?? "");
    return links;
  }

  for (const token of tokens) {
    if (token.type === "text") {
      container.append(document.createTextNode(token.value));
      continue;
    }
    const anchor = document.createElement("a");
    anchor.className = "message-link";
    anchor.href = token.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer nofollow ugc";
    anchor.dataset.userContent = "true";
    anchor.title = token.href;
    anchor.textContent = token.text;
    container.append(anchor);
    links.push(token);
  }

  return links;
}

export function buildAccessibleLinksBar(links, translate = (value) => value) {
  if (!Array.isArray(links) || !links.length) return null;
  const nav = document.createElement("div");
  nav.className = "message-accessible-links";
  nav.setAttribute("role", "group");
  nav.setAttribute("aria-label", translate("Ссылки в сообщении"));
  for (const link of links) {
    const anchor = document.createElement("a");
    anchor.className = "message-accessible-link";
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer nofollow ugc";
    anchor.dataset.userContent = "true";
    anchor.textContent = link.text;
    anchor.setAttribute("aria-label", `${translate("Открыть ссылку")}: ${link.text}`);
    nav.append(anchor);
  }
  return nav;
}
